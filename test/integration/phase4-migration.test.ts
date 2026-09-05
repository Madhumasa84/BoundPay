import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createDrizzleClient, createSqliteConnection, closeDefaultDb, schema } from '@/infrastructure/db';
import { runMigrations } from '@/infrastructure/db/migrate';
import { seedDatabase } from '@/infrastructure/db/seed';
import { createProposal } from '@/services/purchase.service';

describe('Phase 4 migrations preserve Phase 3 data', () => {
  let tempPaths: string[] = [];

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    closeDefaultDb();
  });

  afterEach(() => {
    closeDefaultDb();
    for (const dbPath of tempPaths) for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    tempPaths = [];
  });

  const tempDb = (name: string) => {
    const dbPath = path.resolve(process.cwd(), 'data/test', `migration-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    tempPaths.push(dbPath);
    return dbPath;
  };

  it('clean migration → seed → migration is idempotent and creates authority tables', () => {
    const dbPath = tempDb('clean');
    process.env.DATABASE_PATH = dbPath;
    const sqlite = createSqliteConnection(dbPath);
    runMigrations(sqlite);
    sqlite.close();
    seedDatabase(dbPath);
    const second = createSqliteConnection(dbPath);
    runMigrations(second);
    const db = createDrizzleClient(second);
    expect(db.select().from(schema.operators).all()).toHaveLength(1);
    expect(db.select().from(schema.authorityPassports).all()).toHaveLength(1);
    expect(db.select().from(schema.passportUsages).all()).toHaveLength(0);
    expect(db.select().from(schema.decisionReceipts).all()).toHaveLength(0);
    const passport = db.select().from(schema.authorityPassports).get()!;
    expect(() => db.update(schema.authorityPassports).set({ status: 'INVALID' }).run()).toThrow();
    const intent = createProposal(db.select().from(schema.operators).get()!.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'migration-negative-row', source_mode: 'FIXTURE', fault_injection: 'NONE',
      passport_id: passport.id, agent_id: passport.agent_id,
    }, 'MOCK').intent;
    expect(() => db.insert(schema.passportUsages).values({
      id: 'invalid-negative-usage', passport_id: passport.id, intent_id: intent.id,
      amount_paise: -1, payment_adapter_mode: 'MOCK', usage_status: 'RESERVED',
      reservation_timestamp: new Date().toISOString(), released_or_committed_timestamp: null,
      created_at: new Date().toISOString(),
    }).run()).toThrow();
    expect(second.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(second.pragma('foreign_key_check')).toEqual([]);
    second.close();
  });

  it('rolls back migration DDL when invalid pre-existing rows abort the migration', () => {
    const dbPath = tempDb('rollback');
    const sqlite = createSqliteConnection(dbPath);
    runMigrations(sqlite);
    sqlite.exec('DROP TRIGGER authority_passports_validate_insert');
    sqlite.exec("INSERT INTO operators(id, username, password_hash, created_at) VALUES ('rollback-owner','rollback-owner','x','2026-01-01T00:00:00.000Z')");
    sqlite.exec("INSERT INTO authority_passports(id,owner_id,agent_id,issuer,audience,policy_version,payload_json,payload_digest,signed_token,key_id,status,valid_from,expires_at,revocation_nonce,created_at) VALUES ('bad-pass','rollback-owner','agent','issuer','audience',1,'{}','x','x','kid','INVALID','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','nonce','2026-01-01T00:00:00.000Z')");
    sqlite.exec('DROP INDEX idx_intents_order_id');

    expect(() => runMigrations(sqlite)).toThrow(/refused invalid pre-existing/i);
    const index = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_intents_order_id'").get();
    expect(index).toBeUndefined();
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    sqlite.close();
  });

  it('migrating a copied Phase 3 database preserves intents, ledger, audit, and provider evidence', () => {
    const source = path.resolve(process.cwd(), 'data/boundpay.sqlite');
    expect(fs.existsSync(source), 'the completed Phase 3 database evidence must remain present').toBe(true);
    const copy = tempDb('phase3-copy');
    fs.copyFileSync(source, copy);
    const beforeSqlite = createSqliteConnection(copy);
    const beforeDb = createDrizzleClient(beforeSqlite);
    const beforeIntents = beforeDb.select({ id: schema.purchaseIntents.id, order: schema.purchaseIntents.provider_order_id, payment: schema.purchaseIntents.provider_payment_id }).from(schema.purchaseIntents).all();
    const beforeLedger = beforeDb.select().from(schema.spendLedger).all();
    const beforeAudit = beforeDb.select().from(schema.auditEvents).all();
    const beforeProviderEvidence = beforeIntents.filter((row) => row.order || row.payment);
    runMigrations(beforeSqlite);
    const afterDb = createDrizzleClient(beforeSqlite);
    const afterIntents = afterDb.select({ id: schema.purchaseIntents.id, order: schema.purchaseIntents.provider_order_id, payment: schema.purchaseIntents.provider_payment_id }).from(schema.purchaseIntents).all();
    const afterLedger = afterDb.select().from(schema.spendLedger).all();
    const afterAudit = afterDb.select().from(schema.auditEvents).all();
    expect(afterIntents).toEqual(expect.arrayContaining(beforeIntents));
    expect(afterLedger).toHaveLength(beforeLedger.length);
    expect(afterAudit).toHaveLength(beforeAudit.length);
    expect(afterIntents.filter((row) => row.order || row.payment)).toEqual(expect.arrayContaining(beforeProviderEvidence));
    expect(afterDb.select().from(schema.authorityPassports).all()).toBeDefined();
    expect(afterDb.select().from(schema.passportUsages).all()).toBeDefined();
    expect(afterDb.select().from(schema.decisionReceipts).all()).toBeDefined();
    expect(beforeSqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(beforeSqlite.pragma('foreign_key_check')).toEqual([]);
    beforeSqlite.close();
  });
});
