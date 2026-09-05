import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDefaultDb, getDb, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { getAuthorityConfig } from '@/infrastructure/authority/signing';
import { createAuthorityPassport } from '@/services/passport.service';
import { TestClock } from '@/infrastructure/clock/clock';

describe('offline verifier process isolation', () => {
  let dbPath = '';
  const clock = new TestClock('2026-09-03T12:00:00.000Z');
  beforeEach(() => {
    dbPath = path.resolve(process.cwd(), 'data/test', `offline-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    process.env.AUTHORITY_TEST_MODE = 'true';
    closeDefaultDb();
    seedDatabase(dbPath);
  });
  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  function verifyInChild(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = fork(path.resolve(process.cwd(), 'test/integration/offline-verifier-child.ts'), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, DATABASE_PATH: '/proc/boundpay-database-access-disabled.sqlite' },
      });
      child.once('error', reject);
      child.once('message', resolve);
      child.send({
        token, expected: 'passport', publicKeyPem: getAuthorityConfig().publicKeyPem,
        claims: { issuer: 'boundpay-test-authority', audience: 'boundpay-agent' },
      });
    });
  }

  it('verifies intact public proof without database access and rejects alteration', async () => {
    const owner = getDb().db.select().from(schema.operators).get()!;
    const passport = createAuthorityPassport(owner.id, {
      agentId: 'offline-agent', agentDisplayName: 'Offline Agent', allowedMerchantIds: ['demo_store'],
      allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 200000,
      cumulativeBudgetPaise: 300000, approvalRequiredAbovePaise: 150000,
      expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 2,
    }, clock, 'MOCK');
    await expect(verifyInChild(passport.signedToken)).resolves.toMatchObject({ ok: true, id: passport.payload.passportId });
    const altered = `${passport.signedToken.slice(0, -1)}${passport.signedToken.endsWith('a') ? 'b' : 'a'}`;
    await expect(verifyInChild(altered)).resolves.toEqual({ ok: false });
  });
});
