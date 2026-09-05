/**
 * Authority Passport contention tests. These are worker-thread contention
 * tests using independent SQLite connections (not OS cross-process tests).
 * A real SharedArrayBuffer/Atomics barrier starts the claims together.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'worker_threads';
import path from 'path';
import url from 'url';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { createAuthorityPassport, revokePassport } from '@/services/passport.service';
import { createProposal, approveIntent } from '@/services/purchase.service';
import { updatePolicy } from '@/services/policy.service';
import { updateProduct } from '@/services/catalog.service';
import { TestClock } from '@/infrastructure/clock/clock';

type WorkerResult = { type: 'ready' | 'result' | 'error'; outcome?: string; message?: string; status?: string; ledgerId?: string };
const workerScriptPath = path.resolve(process.cwd(), 'test/integration/concurrency-worker.ts');

function spawnWorker(dbPath: string, intentId: string, operatorId: string, barrier: SharedArrayBuffer): Worker {
  return new Worker(new URL(url.pathToFileURL(workerScriptPath).href), { workerData: { dbPath, intentId, operatorId, barrier }, execArgv: ['--require', 'tsx/cjs'] });
}

function raceWorkers(dbPath: string, intentIds: string[], operatorId: string, afterRelease?: () => void): Promise<WorkerResult[]> {
  return new Promise((resolve, reject) => {
    const barrier = new SharedArrayBuffer(4);
    const view = new Int32Array(barrier);
    const results: WorkerResult[] = [];
    let ready = 0;
    let done = 0;
    let settled = false;
    const workers = intentIds.map((intentId) => spawnWorker(dbPath, intentId, operatorId, barrier));
    const finish = () => { if (!settled && done === workers.length) { settled = true; resolve(results); workers.forEach((worker) => worker.terminate().catch(() => {})); } };
    workers.forEach((worker) => {
      worker.on('message', (message: WorkerResult) => {
        if (message.type === 'ready') {
          ready += 1;
          if (ready === workers.length) {
            Atomics.store(view, 0, 1);
            Atomics.notify(view, 0, workers.length);
            if (afterRelease) setImmediate(afterRelease);
          }
        } else {
          results.push(message);
          done += 1;
          finish();
        }
      });
      worker.on('error', (error) => { results.push({ type: 'error', outcome: 'ERROR', message: error instanceof Error ? error.message : String(error) }); done += 1; finish(); });
    });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('worker race timed out')); } }, 30000);
  });
}

describe('Authority Passport atomic contention', () => {
  let dbPath: string;
  let operatorId: string;
  let clock: TestClock;

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    clock = new TestClock('2026-09-03T12:00:00.000Z');
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-contention-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    closeDefaultDb();
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    operatorId = db.select().from(schema.operators).get()!.id;
    sqlite.close();
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  const issue = (overrides: Record<string, unknown> = {}) => createAuthorityPassport(operatorId, {
    agentId: 'contention-agent', agentDisplayName: 'Contention Agent', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics', 'books'],
    maximumAmountPerTransactionPaise: 149900, cumulativeBudgetPaise: 149900, approvalRequiredAbovePaise: 149900,
    validFrom: '2000-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 1, ...overrides,
  }, clock);

  const proposeMouse = (passportId: string, key: string, proposalClock = clock) => createProposal(operatorId, {
    product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: key, source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passportId, agent_id: 'contention-agent',
  }, 'MOCK', proposalClock);

  it('enforces one remaining passport use and budget across independent connections', async () => {
    const passport = issue();
    const first = proposeMouse(passport.payload.passportId, 'contention-budget-1');
    const second = proposeMouse(passport.payload.passportId, 'contention-budget-2');
    closeDefaultDb();
    const outcomes = await raceWorkers(dbPath, [first.intent.id, second.intent.id], operatorId);
    expect(outcomes.filter((result) => result.outcome === 'SUCCESS')).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === 'BUDGET_EXCEEDED')).toHaveLength(1);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.passport_id, passport.payload.passportId)).all()).toHaveLength(1);
    expect(db.select().from(schema.spendLedger).all()).toHaveLength(1);
    sqlite.close();
  });

  it('keeps same-intent replay idempotent under worker contention', async () => {
    const passport = issue({ maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000, maximumUsageCount: 10 });
    const proposal = proposeMouse(passport.payload.passportId, 'contention-replay');
    closeDefaultDb();
    const outcomes = await raceWorkers(dbPath, Array.from({ length: 6 }, () => proposal.intent.id), operatorId);
    expect(outcomes.some((result) => result.outcome === 'SUCCESS')).toBe(true);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, proposal.intent.id)).all()).toHaveLength(1);
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).all()).toHaveLength(1);
    sqlite.close();
  });

  it('serializes revocation racing with reservation without partial state', async () => {
    const passport = issue();
    const proposal = proposeMouse(passport.payload.passportId, 'contention-revoke');
    closeDefaultDb();
    const outcomes = await raceWorkers(dbPath, [proposal.intent.id], operatorId, () => {
      try { revokePassport(passport.payload.passportId, operatorId, clock); } catch {}
    });
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    const intent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!;
    const ledger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).get();
    const usage = db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, proposal.intent.id)).get();
    expect(['PAYMENT_CONFIRMED', 'BLOCKED', 'EXPIRED', 'UNKNOWN', 'ORDER_CREATED']).toContain(intent.state);
    expect(ledger ? ['RESERVED', 'CONFIRMED', 'RELEASED'].includes(ledger.status) : true).toBe(true);
    expect(usage ? ['RESERVED', 'COMMITTED', 'CONFIRMED', 'UNKNOWN', 'RELEASED'].includes(usage.usage_status) : true).toBe(true);
    expect(outcomes.every((result) => result.type === 'result')).toBe(true);
    sqlite.close();
  });

  it('blocks exactly at the expiry boundary before any provider reservation', async () => {
    const proposalClock = new TestClock('2026-09-03T11:59:59.000Z');
    const passport = issue({ expiresAt: '2026-09-03T12:00:00.000Z' });
    const proposal = proposeMouse(passport.payload.passportId, 'contention-expiry', proposalClock);
    closeDefaultDb();
    const outcomes = await raceWorkers(dbPath, [proposal.intent.id], operatorId);
    expect(outcomes[0].outcome).toBe('QUOTE_REVALIDATION');
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).all()).toHaveLength(0);
    expect(db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!.state).toBe('EXPIRED');
    sqlite.close();
  });

  it('allows only valid serial outcomes when policy or catalog updates race reservation', async () => {
    const passport = issue({ maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000, maximumUsageCount: 10 });
    const proposal = createProposal(operatorId, { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000, idempotency_key: 'contention-policy-catalog', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passport.payload.passportId, agent_id: 'contention-agent' }, 'MOCK', clock);
    approveIntent(proposal.intent.id, operatorId, 'contention approval', clock);
    closeDefaultDb();
    const outcomes = await raceWorkers(dbPath, [proposal.intent.id], operatorId, () => {
      try { updatePolicy({ currency: 'INR', max_transaction_amount_paise: 200000, daily_budget_paise: 500000, approval_threshold_paise: 100000, allowed_categories: ['electronics', 'books'], approved_merchant_id: 'demo_store', allow_subscriptions: false, expires_at: '2026-11-01T00:00:00.000Z' }, operatorId, clock); } catch {}
      try { updateProduct('prod_keyboard', { unit_price_paise: 429900 }, operatorId, clock); } catch {}
    });
    expect(outcomes.every((result) => ['SUCCESS', 'QUOTE_REVALIDATION', 'BUDGET_EXCEEDED', 'STATE_CONFLICT'].includes(result.outcome || ''))).toBe(true);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    const ledger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).get();
    if (ledger) expect(['RESERVED', 'CONFIRMED', 'RELEASED']).toContain(ledger.status);
    sqlite.close();
  });
});
