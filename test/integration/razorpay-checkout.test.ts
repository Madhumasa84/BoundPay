import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { eq, and } from 'drizzle-orm';
import {
  createDrizzleClient,
  createSqliteConnection,
  schema,
  closeDefaultDb,
} from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { ExecutionService } from '@/services/execution.service';
import { createProposal } from '@/services/purchase.service';
import { IntentStates } from '@/domain/state-machine';
import { RazorpayTestAdapter } from '@/infrastructure/payment/razorpay-test-adapter';
import { TestClock } from '@/infrastructure/clock/clock';

describe('Razorpay Checkout & Webhook Integration Tests', () => {
  const testDbDir = path.resolve(process.cwd(), 'data/test');
  let testDbPath: string;
  let clock: TestClock;

  const testKeyId = 'rzp_test_intKey123';
  const testKeySecret = 'intKeySecret456';
  const testWebhookSecret = 'intWebhookSecret789';

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    closeDefaultDb();
    testDbPath = path.resolve(
      testDbDir,
      `test-rzp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.sqlite`
    );
    clock = new TestClock('2026-09-03T12:00:00.000Z');
    process.env.DATABASE_PATH = testDbPath;
    process.env.RAZORPAY_KEY_ID = testKeyId;
    process.env.RAZORPAY_KEY_SECRET = testKeySecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = testWebhookSecret;
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

  it('Order created in RAZORPAY_TEST mode transitions to ORDER_CREATED and yields order details without auto-capture', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    // Propose Wireless Mouse (₹1,499 = 149900 paise, auto-allowed <= ₹2,500 threshold)
    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_rzp_order_created',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order_rzp12345',
        amount: 149900,
        currency: 'INR',
        receipt: p.intent.receipt,
        status: 'created',
      }),
    } as any);

    const adapter = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      customFetch: mockFetch,
    });

    const execService = new ExecutionService(adapter, clock);
    const execResult = await execService.executeIntent(p.intent.id, operator.id);

    expect(execResult.success).toBe(true);
    expect(execResult.status).toBe(IntentStates.ORDER_CREATED);
    expect(execResult.providerOrderId).toBe('order_rzp12345');
    expect(execResult.keyId).toBe(testKeyId);
    expect(execResult.isMock).toBe(false);

    // Verify DB state is ORDER_CREATED and budget is RESERVED
    const updated = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(updated.state).toBe(IntentStates.ORDER_CREATED);
    expect(updated.provider_order_id).toBe('order_rzp12345');

    const ledger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, p.intent.id)).get()!;
    expect(ledger.status).toBe('RESERVED');
    expect(ledger.provider_order_id).toBe('order_rzp12345');

    sqlite.close();
  });

  it('Checkout callback confirms payment once, verifies signature, and updates ledger to CONFIRMED', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_rzp_checkout_callback',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    const orderId = 'order_rzp_callback_123';
    const paymentId = 'pay_rzp_payment_456';

    const mockFetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('/orders')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: orderId,
            amount: 149900,
            currency: 'INR',
            status: 'created',
          }),
        } as any;
      }
      if (urlStr.includes(`/payments/${paymentId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: paymentId,
            order_id: orderId,
            amount: 149900,
            currency: 'INR',
            status: 'captured',
          }),
        } as any;
      }
      return { ok: false } as any;
    };

    const adapter = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      webhookSecret: testWebhookSecret,
      customFetch: mockFetch,
    });

    const execService = new ExecutionService(adapter, clock);

    // 1. Create order
    await execService.executeIntent(p.intent.id, operator.id);

    // 2. Client completes checkout and returns signature
    const signature = crypto
      .createHmac('sha256', testKeySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const confirmResult = await execService.confirmPaymentCapture(p.intent.id, operator.id, {
      paymentId,
      orderId,
      signature,
    });

    expect(confirmResult.success).toBe(true);
    expect(confirmResult.status).toBe(IntentStates.PAYMENT_CONFIRMED);
    expect(confirmResult.providerPaymentId).toBe(paymentId);

    // Verify DB state
    const confirmedIntent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(confirmedIntent.state).toBe(IntentStates.PAYMENT_CONFIRMED);

    const confirmedLedger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, p.intent.id)).get()!;
    expect(confirmedLedger.status).toBe('CONFIRMED');
    expect(confirmedLedger.provider_payment_id).toBe(paymentId);

    // 3. Repeated callback: verify idempotent no-op and no duplicate ledger entries
    const repeatResult = await execService.confirmPaymentCapture(p.intent.id, operator.id, {
      paymentId,
      orderId,
      signature,
    });
    expect(repeatResult.success).toBe(true);

    const allLedgerRows = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, p.intent.id)).all();
    expect(allLedgerRows.length).toBe(1);

    sqlite.close();
  });

  it('Webhook confirmation is idempotent, deduplicates event ID, and ignores duplicates', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_rzp_webhook',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    const orderId = 'order_rzp_wh_123';
    const paymentId = 'pay_rzp_wh_456';

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: orderId, amount: 149900, currency: 'INR', status: 'created' }),
    } as any);

    const adapter = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      webhookSecret: testWebhookSecret,
      customFetch: mockFetch,
    });

    const execService = new ExecutionService(adapter, clock);
    await execService.executeIntent(p.intent.id, operator.id);

    // Formulate raw webhook payload
    const eventId = 'evt_unique_12345';
    const webhookPayload = JSON.stringify({
      id: eventId,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 149900,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const signature = crypto
      .createHmac('sha256', testWebhookSecret)
      .update(webhookPayload)
      .digest('hex');

    // First delivery of webhook
    const firstDelivery = await execService.handleRazorpayWebhook(webhookPayload, signature, eventId);
    expect(firstDelivery.processed).toBe(true);
    expect(firstDelivery.status).toBe('CONFIRMED_FROM_WEBHOOK');

    // Intent is confirmed
    const intentAfterWh = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(intentAfterWh.state).toBe(IntentStates.PAYMENT_CONFIRMED);

    // Duplicate delivery of the same webhook event ID
    const duplicateDelivery = await execService.handleRazorpayWebhook(webhookPayload, signature, eventId);
    expect(duplicateDelivery.status).toBe('ALREADY_PROCESSED');

    // Still exactly ONE confirmed ledger row
    const ledgerRows = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, p.intent.id)).all();
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].status).toBe('CONFIRMED');

    sqlite.close();
  });

  it('Webhook arriving before order persistence is durably retained as UNMATCHED and reconciled', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const orderId = 'order_unmatched_race';
    const paymentId = 'pay_unmatched_race';
    const eventId = 'evt_race_999';

    const webhookPayload = JSON.stringify({
      id: eventId,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 149900,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const signature = crypto
      .createHmac('sha256', testWebhookSecret)
      .update(webhookPayload)
      .digest('hex');

    const adapter = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      webhookSecret: testWebhookSecret,
    });

    const execService = new ExecutionService(adapter, clock);

    // Webhook arrives BEFORE order is saved in application DB!
    const webhookResult = await execService.handleRazorpayWebhook(webhookPayload, signature, eventId);
    expect(webhookResult.status).toBe('RETAINED_UNMATCHED');

    // Verify webhook is stored in DB with status UNMATCHED
    const storedWebhook = db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.event_id, eventId)).get()!;
    expect(storedWebhook.status).toBe('UNMATCHED');
    expect(storedWebhook.order_id).toBe(orderId);

    // Now order response is saved via executeIntent
    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_rzp_race_intent',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: orderId, amount: 149900, currency: 'INR', status: 'created' }),
    } as any);

    const adapterWithOrder = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      webhookSecret: testWebhookSecret,
      customFetch: mockFetch,
    });

    const execServiceWithOrder = new ExecutionService(adapterWithOrder, clock);
    const execRes = await execServiceWithOrder.executeIntent(p.intent.id, operator.id);

    // Notice: executeIntent automatically reconciled the previously unmatched webhook!
    expect(execRes.status).toBe(IntentStates.PAYMENT_CONFIRMED);

    const finalizedIntent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(finalizedIntent.state).toBe(IntentStates.PAYMENT_CONFIRMED);

    const finalizedWebhook = db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.event_id, eventId)).get()!;
    expect(finalizedWebhook.status).toBe('PROCESSED');

    sqlite.close();
  });

  it('Early unmatched webhook with wrong amount is ignored when the order later becomes matchable', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;
    const orderId = 'order_early_wrong_amount';
    const eventId = 'evt_early_wrong_amount';
    const webhookPayload = JSON.stringify({
      id: eventId,
      event: 'payment.captured',
      payload: { payment: { entity: {
        id: 'pay_wrong_amount', order_id: orderId, amount: 1, currency: 'INR', status: 'captured',
      } } },
    });
    const signature = crypto.createHmac('sha256', testWebhookSecret).update(webhookPayload).digest('hex');
    const verifier = new RazorpayTestAdapter({ keyId: testKeyId, keySecret: testKeySecret, webhookSecret: testWebhookSecret });
    expect((await new ExecutionService(verifier, clock).handleRazorpayWebhook(webhookPayload, signature, eventId)).status)
      .toBe('RETAINED_UNMATCHED');

    const proposal = createProposal(operator.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'early-wrong-amount', source_mode: 'MANUAL', fault_injection: 'NONE',
    }, 'RAZORPAY_TEST', clock);
    const orderAdapter = new RazorpayTestAdapter({
      keyId: testKeyId, keySecret: testKeySecret, webhookSecret: testWebhookSecret,
      customFetch: async () => ({ ok: true, status: 200, json: async () => ({ id: orderId, amount: 149900, currency: 'INR', status: 'created' }) } as any),
    });
    const result = await new ExecutionService(orderAdapter, clock).executeIntent(proposal.intent.id, operator.id);
    expect(result.status).toBe(IntentStates.ORDER_CREATED);
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).get()!.status).toBe('RESERVED');
    expect(db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.event_id, eventId)).get()!.status).toBe('IGNORED');
    expect(db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.intent_id, proposal.intent.id),
      eq(schema.auditEvents.event_type, 'EARLY_WEBHOOK_PAYMENT_MISMATCH')
    )).get()).toBeTruthy();
    sqlite.close();
  });

  it('Status refresh confirms payment when browser callback was lost', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_lost_callback',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    const orderId = 'order_lost_cb';
    const paymentId = 'pay_found_on_provider';

    const mockFetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('/orders') && !urlStr.includes('/payments')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: orderId, amount: 149900, currency: 'INR', status: 'created' }),
        } as any;
      }
      if (urlStr.includes(`/orders/${orderId}/payments`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            count: 1,
            items: [
              {
                id: paymentId,
                order_id: orderId,
                amount: 149900,
                currency: 'INR',
                status: 'captured',
              },
            ],
          }),
        } as any;
      }
      return { ok: false } as any;
    };

    const adapter = new RazorpayTestAdapter({
      keyId: testKeyId,
      keySecret: testKeySecret,
      customFetch: mockFetch,
    });

    const execService = new ExecutionService(adapter, clock);
    await execService.executeIntent(p.intent.id, operator.id);

    // Simulate lost browser callback: client closed tab before calling confirm-payment.
    // Operator clicks "Refresh Status"
    const refreshRes = await execService.refreshPaymentStatus(p.intent.id, operator.id);
    expect(refreshRes.success).toBe(true);
    expect(refreshRes.status).toBe(IntentStates.PAYMENT_CONFIRMED);
    expect(refreshRes.providerPaymentId).toBe(paymentId);

    const confirmed = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(confirmed.state).toBe(IntentStates.PAYMENT_CONFIRMED);

    sqlite.close();
  });

  it('Crash recovery: recovers stale EXECUTING intents to UNKNOWN and retains budget reservation', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_crash_recovery',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST',
      clock
    );

    // Atomically claim reservation (state: EXECUTING)
    const execService = new ExecutionService(undefined, clock);
    execService.claimAndReserveAtomic(p.intent.id, operator.id);

    // Advance clock by 10 minutes (simulating node process crash during order dispatch)
    clock.advanceSeconds(600);

    // Service restart runs recovery
    const recoveredCount = execService.recoverStaleExecutingIntents(300);
    expect(recoveredCount).toBe(1);

    const recoveredIntent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(recoveredIntent.state).toBe(IntentStates.UNKNOWN);
    expect(recoveredIntent.failure_reason).toContain('Process crash');

    // Invariant: budget reservation remains held (status RESERVED)!
    const ledger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, p.intent.id)).get()!;
    expect(ledger.status).toBe('RESERVED');
    expect(ledger.amount_paise).toBe(149900);

    sqlite.close();
  });
});
