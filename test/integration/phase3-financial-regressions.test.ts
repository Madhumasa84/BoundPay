import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { PaymentAdapter } from '@/infrastructure/payment/adapter.interface';
import { ExecutionService } from '@/services/execution.service';
import { approveIntent, createProposal } from '@/services/purchase.service';
import { updatePolicy } from '@/services/policy.service';
import { TestClock } from '@/infrastructure/clock/clock';

describe('Phase 3 financial-state regressions', () => {
  let testDbPath: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  beforeEach(() => {
    closeDefaultDb();
    const dir = path.resolve(process.cwd(), 'data/test');
    fs.mkdirSync(dir, { recursive: true });
    testDbPath = path.join(dir, `phase3-regression-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = testDbPath;
    seedDatabase(testDbPath);
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch {}
    }
  });

  it('persists UNKNOWN and retains the reservation when the provider throws after reservation commit', async () => {
    const throwingAdapter: PaymentAdapter = {
      mode: 'MOCK',
      async createOrder() { throw new Error('connection reset after dispatch'); },
      async confirmCapture() { throw new Error('not reached'); },
      async getOrderStatus() { return { isMock: true, orderId: 'none', status: 'UNKNOWN', amountPaise: 0, currency: 'INR', rawResponse: {} }; },
    };
    const { db } = (() => {
      const sqlite = createSqliteConnection(testDbPath);
      return { db: createDrizzleClient(sqlite) };
    })();
    const operator = db.select().from(schema.operators).get()!;
    const proposal = createProposal(operator.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'adapter-throw', source_mode: 'FIXTURE', fault_injection: 'NONE',
    }, 'MOCK', clock);

    const result = await new ExecutionService(throwingAdapter, clock).executeIntent(proposal.intent.id, operator.id);
    expect(result.status).toBe('UNKNOWN');

    const storedIntent = db.select().from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!;
    const ledger = db.select().from(schema.spendLedger)
      .where(eq(schema.spendLedger.intent_id, proposal.intent.id)).get()!;
    expect(storedIntent.state).toBe('UNKNOWN');
    expect(storedIntent.failure_reason).toContain('connection reset after dispatch');
    expect(ledger.status).toBe('RESERVED');
  });

  it('rejects a policy reduction below Razorpay-test commitments even when MOCK has no spend', () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;
    const proposal = createProposal(operator.id, {
      product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000,
      idempotency_key: 'rzp-policy-reduction', source_mode: 'FIXTURE', fault_injection: 'NONE',
    }, 'RAZORPAY_TEST', clock);
    approveIntent(proposal.intent.id, operator.id, 'exact approval', clock);
    new ExecutionService(undefined, clock).claimAndReserveAtomic(proposal.intent.id, operator.id);

    expect(() => updatePolicy({
      currency: 'INR', max_transaction_amount_paise: 250000, daily_budget_paise: 250000,
      approval_threshold_paise: 200000, allowed_categories: ['electronics', 'books'],
      approved_merchant_id: 'demo_store', allow_subscriptions: false,
      expires_at: '2026-11-01T00:00:00.000Z',
    }, operator.id, clock)).toThrow('279900 paise committed');
    sqlite.close();
  });
});
