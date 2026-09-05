import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcess, fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { createAuthorityPassport } from '@/services/passport.service';
import { createProposal } from '@/services/purchase.service';
import { TestClock } from '@/infrastructure/clock/clock';

type Outcome = { type: 'result'; outcome: string; status?: string };
const childScript = path.resolve(process.cwd(), 'test/integration/concurrency-child.ts');

function raceProcesses(dbPath: string, intentIds: string[], operatorId: string): Promise<Outcome[]> {
  return new Promise((resolve, reject) => {
    const children: ChildProcess[] = [];
    const results: Outcome[] = [];
    let ready = 0;
    let settled = false;
    const finish = () => {
      if (!settled && results.length === children.length) {
        settled = true;
        clearTimeout(timeout);
        resolve(results);
      }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      children.forEach((child) => child.kill());
      reject(new Error('OS-process contention timed out'));
    }, 30_000);
    for (const intentId of intentIds) {
      const child = fork(childScript, [], {
        execArgv: ['--require', 'tsx/cjs'],
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          AUTHORITY_TEST_MODE: 'true',
          PAYMENT_ADAPTER_MODE: 'MOCK',
          PAYMENT_MODE: 'mock',
          CHILD_INTENT_ID: intentId,
          CHILD_OPERATOR_ID: operatorId,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      child.on('message', (message: { type?: string } | Outcome) => {
        if (message.type === 'ready') {
          ready += 1;
          if (ready === intentIds.length) children.forEach((candidate) => candidate.send('start'));
        } else if (message.type === 'result') {
          results.push(message as Outcome);
          finish();
        }
      });
      child.on('error', reject);
    }
  });
}

describe('Authority Passport OS-process contention', () => {
  let dbPath: string;
  let operatorId: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.PAYMENT_ADAPTER_MODE = 'MOCK';
    process.env.PAYMENT_MODE = 'mock';
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-process-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    closeDefaultDb();
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    operatorId = createDrizzleClient(sqlite).select().from(schema.operators).get()!.id;
    sqlite.close();
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  function passport() {
    return createAuthorityPassport(operatorId, {
      agentId: 'process-agent', agentDisplayName: 'Process Agent', allowedMerchantIds: ['demo_store'],
      allowedCategories: ['electronics', 'books'], maximumAmountPerTransactionPaise: 149900,
      cumulativeBudgetPaise: 149900, approvalRequiredAbovePaise: 149900,
      validFrom: '2000-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 1,
    }, clock);
  }

  function proposal(passportId: string, key: string) {
    return createProposal(operatorId, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: key, source_mode: 'FIXTURE', fault_injection: 'NONE',
      passport_id: passportId, agent_id: 'process-agent',
    }, 'MOCK', clock);
  }

  it('serializes two OS processes competing for the final passport use and budget', async () => {
    const issued = passport();
    const first = proposal(issued.payload.passportId, 'process-budget-a');
    const second = proposal(issued.payload.passportId, 'process-budget-b');
    closeDefaultDb();
    const outcomes = await raceProcesses(dbPath, [first.intent.id, second.intent.id], operatorId);
    expect(outcomes.filter((outcome) => outcome.outcome === 'SUCCESS')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'BUDGET_EXCEEDED')).toHaveLength(1);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    expect(db.select().from(schema.spendLedger).all()).toHaveLength(1);
    expect(db.select().from(schema.passportUsages).all()).toHaveLength(1);
    sqlite.close();
  }, 40_000);

  it('allows five OS-process replays to create only one ledger and usage row', async () => {
    const issued = passport();
    const created = proposal(issued.payload.passportId, 'process-same-intent');
    closeDefaultDb();
    const outcomes = await raceProcesses(dbPath, Array.from({ length: 5 }, () => created.intent.id), operatorId);
    expect(outcomes.some((outcome) => outcome.outcome === 'SUCCESS')).toBe(true);
    expect(outcomes.every((outcome) => ['SUCCESS', 'STATE_CONFLICT'].includes(outcome.outcome))).toBe(true);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, created.intent.id)).all()).toHaveLength(1);
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, created.intent.id)).all()).toHaveLength(1);
    sqlite.close();
  }, 40_000);
});
