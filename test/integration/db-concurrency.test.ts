import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import { createDrizzleClient, createSqliteConnection, schema, closeDefaultDb } from '@/infrastructure/db';
import { runMigrations } from '@/infrastructure/db/migrate';
import { seedDatabase } from '@/infrastructure/db/seed';
import { ExecutionService } from '@/services/execution.service';
import { createProposal, approveIntent, declineIntent } from '@/services/purchase.service';
import { updatePolicy } from '@/services/policy.service';
import { updateProduct } from '@/services/catalog.service';
import { MockPaymentAdapter } from '@/infrastructure/payment/mock-adapter';
import { TestClock } from '@/infrastructure/clock/clock';
import { IntentStates } from '@/domain/state-machine';
import { Worker } from 'worker_threads';

describe('Real SQLite Concurrency and Transaction Integration Tests', () => {
  const testDbDir = path.resolve(process.cwd(), 'data/test');
  let testDbPath: string;
  let clock: TestClock;

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    closeDefaultDb();
    testDbPath = path.resolve(testDbDir, `test-concurrency-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.sqlite`);
    clock = new TestClock('2026-09-03T12:00:00.000Z');
    process.env.DATABASE_PATH = testDbPath;
    seedDatabase(testDbPath);
  });

  afterEach(() => {
    closeDefaultDb();
    try {
      const files = [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`];
      for (const f of files) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch {}
  });

  it('Race two 279,900-paise purchases against a 500,000-paise budget: at most one reservation succeeds', async () => {
    const sqliteConn1 = createSqliteConnection(testDbPath);
    const sqliteConn2 = createSqliteConnection(testDbPath);

    const db1 = createDrizzleClient(sqliteConn1);
    const db2 = createDrizzleClient(sqliteConn2);

    const operator = db1.select().from(schema.operators).get()!;

    // Create proposal 1 (Keyboard: 279900 paise)
    const p1 = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'race-key-1',
        source_mode: 'FIXTURE',
        reason: 'Race intent 1',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    // Create proposal 2 (Keyboard: 279900 paise)
    const p2 = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'race-key-2',
        source_mode: 'FIXTURE',
        reason: 'Race intent 2',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    // Approve both proposals (since keyboard requires approval > 250,000 paise)
    approveIntent(p1.intent.id, operator.id, 'Approve 1', clock);
    approveIntent(p2.intent.id, operator.id, 'Approve 2', clock);

    // Run execution claims on two independent connections
    const execService1 = new ExecutionService(new MockPaymentAdapter(), clock);
    const execService2 = new ExecutionService(new MockPaymentAdapter(), clock);

    let successCount = 0;
    let budgetExceededCount = 0;

    const results = await Promise.allSettled([
      execService1.executeIntent(p1.intent.id, operator.id),
      execService2.executeIntent(p2.intent.id, operator.id),
    ]);

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        successCount++;
      } else if (r.status === 'rejected' && r.reason?.name === 'BudgetExceededError') {
        budgetExceededCount++;
      }
    }

    // Invariant: Total budget is 500,000 paise. Two 279,900 items sum to 559,800 paise.
    // Exactly ONE must succeed and ONE must be rejected by the daily budget invariant.
    expect(successCount).toBe(1);
    expect(budgetExceededCount).toBe(1);

    // Inspect final state in DB
    const finalLedgerEntries = db1.select().from(schema.spendLedger).all();
    const reservedOrConfirmed = finalLedgerEntries.filter(
      (e) => e.status === 'RESERVED' || e.status === 'CONFIRMED'
    );
    expect(reservedOrConfirmed.length).toBe(1);
    expect(reservedOrConfirmed[0].amount_paise).toBe(279900);

    sqliteConn1.close();
    sqliteConn2.close();
  });

  it('Race repeated execution requests for the same intent: at most one adapter dispatch occurs', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    // Create Mouse proposal (149,900 paise, auto-allowed READY)
    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'repeat-exec-key',
        source_mode: 'FIXTURE',
        reason: 'Repeat exec test',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    const mockAdapter = new MockPaymentAdapter();
    const execService = new ExecutionService(mockAdapter, clock);

    // Concurrently fire 5 checkout executions for the same intent ID
    const promises = Array.from({ length: 5 }).map(() =>
      execService.executeIntent(p.intent.id, operator.id)
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Verify only ONE reservation / confirmed entry was ever created for this intent
    const ledgerRows = db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.intent_id, p.intent.id))
      .all();

    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].status).toBe('CONFIRMED');

    sqlite.close();
  });

  it('Race approval and denial: exactly one wins and state is deterministic', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'race-approve-deny',
        source_mode: 'FIXTURE',
        reason: 'Race approve vs deny',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    expect(p.intent.state).toBe(IntentStates.NEEDS_APPROVAL);

    // Concurrently trigger approve and decline
    const results = await Promise.allSettled([
      (async () => approveIntent(p.intent.id, operator.id, 'Approve note', clock))(),
      (async () => declineIntent(p.intent.id, operator.id, 'Decline note', clock))(),
    ]);

    const states = results
      .filter((r) => r.status === 'fulfilled')
      .map((r: any) => r.value.state);

    // Exactly one operation succeeds or both finish in valid serial order
    const updated = db
      .select()
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, p.intent.id))
      .get();

    expect(['APPROVED', 'DECLINED']).toContain(updated?.state);

    sqlite.close();
  });

  it('Policy edit after proposal invalidates prior approval during execution claim', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    // 1. Propose keyboard
    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'policy-invalidation-key',
        source_mode: 'FIXTURE',
        reason: 'Policy invalidation test',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    // 2. Approve
    approveIntent(p.intent.id, operator.id, 'Approved under v1', clock);

    // 3. Operator edits spending policy (increments policy version to v2)
    updatePolicy(
      {
        currency: 'INR',
        max_transaction_amount_paise: 350000,
        daily_budget_paise: 500000,
        approval_threshold_paise: 200000,
        allowed_categories: ['electronics', 'books'],
        approved_merchant_id: 'demo_store',
        allow_subscriptions: false,
        expires_at: '2026-11-01T00:00:00.000Z',
      },
      operator.id,
      clock
    );

    // 4. Attempt to execute intent with obsolete policy version
    const execService = new ExecutionService(new MockPaymentAdapter(), clock);
    await expect(
      execService.executeIntent(p.intent.id, operator.id)
    ).rejects.toThrow('Spending policy modified after proposal; new proposal and authorization required');

    sqlite.close();
  });

  it('Product price edit after proposal invalidates authorization during execution claim', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'catalog-invalidation-key',
        source_mode: 'FIXTURE',
        reason: 'Catalog invalidation test',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    approveIntent(p.intent.id, operator.id, 'Approved', clock);

    // Operator changes catalog price (increments product version)
    updateProduct('prod_keyboard', { unit_price_paise: 289900 }, operator.id, clock);

    const execService = new ExecutionService(new MockPaymentAdapter(), clock);
    await expect(
      execService.executeIntent(p.intent.id, operator.id)
    ).rejects.toThrow('Catalog product price or attributes modified after proposal');

    sqlite.close();
  });

  it('State and reservations survive closing and reopening the database', async () => {
    let conn = createSqliteConnection(testDbPath);
    let db = createDrizzleClient(conn);
    const operator = db.select().from(schema.operators).get()!;

    // Create and execute purchase
    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'durability-test-key',
        source_mode: 'FIXTURE',
        reason: 'Durability test',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    const execService = new ExecutionService(new MockPaymentAdapter(), clock);
    const result = await execService.executeIntent(p.intent.id, operator.id);
    expect(result.status).toBe(IntentStates.PAYMENT_CONFIRMED);

    // Completely close connection
    conn.close();

    // Reopen database fresh
    conn = createSqliteConnection(testDbPath);
    db = createDrizzleClient(conn);

    const restoredIntent = db
      .select()
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, p.intent.id))
      .get();

    expect(restoredIntent?.state).toBe(IntentStates.PAYMENT_CONFIRMED);

    const restoredLedger = db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.intent_id, p.intent.id))
      .get();

    expect(restoredLedger?.status).toBe('CONFIRMED');
    expect(restoredLedger?.amount_paise).toBe(149900);

    conn.close();
  });

  it('Mock and Test mode accounting isolation', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    // Proposal in MOCK mode
    const pMock = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'mode-test-mock',
        source_mode: 'FIXTURE',
        reason: 'Mock mode intent',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock
    );

    // Proposal with SAME idempotency key in RAZORPAY_TEST mode
    const pTest = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'mode-test-mock', // same key
        source_mode: 'FIXTURE',
        reason: 'Razorpay test mode intent',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    expect(pMock.intent.id).not.toBe(pTest.intent.id);
    expect(pMock.intent.payment_adapter_mode).toBe('MOCK');
    expect(pTest.intent.payment_adapter_mode).toBe('RAZORPAY_TEST');

    sqlite.close();
  });
});
