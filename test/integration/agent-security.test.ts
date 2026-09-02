import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import {
  createDrizzleClient,
  createSqliteConnection,
  schema,
  closeDefaultDb,
} from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { POST as proposeRoute } from '@/app/api/agent/propose/route';
import { POST as confirmPaymentRoute } from '@/app/api/intents/[id]/confirm-payment/route';
import { POST as refreshStatusRoute } from '@/app/api/intents/[id]/refresh-status/route';
import { POST as webhookRoute } from '@/app/api/webhooks/razorpay/route';
import { createProposal } from '@/services/purchase.service';
import { IntentStates } from '@/domain/state-machine';
import { createOperatorSession } from '@/infrastructure/auth/session';

describe('Security, Authentication, & Anti-Forgery HTTP Integration Tests', () => {
  const testDbDir = path.resolve(process.cwd(), 'data/test');
  let testDbPath: string;

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    closeDefaultDb();
    testDbPath = path.resolve(
      testDbDir,
      `test-sec-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.sqlite`
    );
    process.env.DATABASE_PATH = testDbPath;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_secKey123';
    process.env.RAZORPAY_KEY_SECRET = 'secSecret456';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'secWebhook789';
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

  it('Unauthenticated requests to /api/agent/propose are rejected with 401 Unauthorized', async () => {
    const req = new Request('http://localhost:3000/api/agent/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopping_request: 'mechanical keyboard',
        purchase_budget_paise: 300000,
      }),
    });

    const res = await proposeRoute(req);
    expect(res.status).toBe(401);
  });

  it('Unauthenticated requests to /api/intents/[id]/confirm-payment are rejected with 401', async () => {
    const req = new Request('http://localhost:3000/api/intents/intent_123/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_123',
        orderId: 'order_123',
        signature: 'sig_123',
      }),
    });

    const res = await confirmPaymentRoute(req, { params: { id: 'intent_123' } });
    expect(res.status).toBe(401);
  });

  it('Unauthenticated requests to /api/intents/[id]/refresh-status are rejected with 401', async () => {
    const req = new Request('http://localhost:3000/api/intents/intent_123/refresh-status', {
      method: 'POST',
    });

    const res = await refreshStatusRoute(req, { params: { id: 'intent_123' } });
    expect(res.status).toBe(401);
  });

  it('Cross-operator authorization: operator B cannot confirm payment for operator A intent', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);

    // Create operator A and operator B
    const operatorA = db.select().from(schema.operators).get()!;
    const operatorBId = 'operator_b_rogue';
    db.insert(schema.operators).values({
      id: operatorBId,
      username: 'operator_b',
      password_hash: 'hash',
      created_at: new Date().toISOString(),
    }).run();

    // Create session for Operator B
    const { token: sessionTokenB } = createOperatorSession(operatorBId);

    // Proposal owned by Operator A
    const p = createProposal(
      operatorA.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_cross_owner',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST'
    );

    // Operator B attempts to confirm Operator A's intent
    const req = new Request(`http://localhost:3000/api/intents/${p.intent.id}/confirm-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `boundpay_session=${sessionTokenB}`,
      },
      body: JSON.stringify({
        paymentId: 'pay_123',
        orderId: 'order_123',
        signature: 'sig_123',
      }),
    });

    const res = await confirmPaymentRoute(req, { params: { id: p.intent.id } });
    const json = await res.json();
    expect(res.status).toBe(409); // StateConflictError: Unauthorized
    expect(json.message).toContain('Unauthorized');

    sqlite.close();
  });

  it('Forged callback signature fails verification and does not confirm intent or ledger', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    // Create session for Operator
    const { token: sessionToken } = createOperatorSession(operator.id);

    const p = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'test_forged_sig',
        source_mode: 'MANUAL',
        fault_injection: 'NONE',
      },
      'RAZORPAY_TEST'
    );

    // Simulate order created
    db.update(schema.purchaseIntents)
      .set({ state: IntentStates.ORDER_CREATED, provider_order_id: 'order_legit_123' })
      .where(eq(schema.purchaseIntents.id, p.intent.id))
      .run();

    // Call confirm-payment with a completely forged signature
    const req = new Request(`http://localhost:3000/api/intents/${p.intent.id}/confirm-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `boundpay_session=${sessionToken}`,
      },
      body: JSON.stringify({
        orderId: 'order_legit_123',
        paymentId: 'pay_fake_999',
        signature: 'deadbeef_forged_signature_here',
      }),
    });

    const res = await confirmPaymentRoute(req, { params: { id: p.intent.id } });
    const json = await res.json();
    expect(json.success).toBe(false);

    // Invariant: Intent remains ORDER_CREATED, NOT PAYMENT_CONFIRMED!
    const unchanged = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, p.intent.id)).get()!;
    expect(unchanged.state).toBe(IntentStates.ORDER_CREATED);

    sqlite.close();
  });

  it('Invalid webhook signature returns 400 and causes zero database mutations', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);

    const initialWebhooksCount = db.select().from(schema.webhookEvents).all().length;

    const fakePayload = JSON.stringify({
      id: 'evt_fake_attacker',
      event: 'payment.captured',
    });

    const req = new Request('http://localhost:3000/api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': 'invalid_signature_hex_1234',
      },
      body: fakePayload,
    });

    const res = await webhookRoute(req);
    expect(res.status).toBe(400);

    // No webhook recorded for invalid signature
    const finalWebhooksCount = db.select().from(schema.webhookEvents).all().length;
    expect(finalWebhooksCount).toBe(initialWebhooksCount);

    sqlite.close();
  });

  it('Secrets (API keys, webhook secrets) never appear in agent propose response', async () => {
    const sqlite = createSqliteConnection(testDbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;

    const { token: sessionToken } = createOperatorSession(operator.id);

    const req = new Request('http://localhost:3000/api/agent/propose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `boundpay_session=${sessionToken}`,
      },
      body: JSON.stringify({
        shopping_request: 'wireless mouse',
        purchase_budget_paise: 200000,
      }),
    });

    const res = await proposeRoute(req);
    const text = await res.text();

    expect(text).not.toContain(process.env.RAZORPAY_KEY_SECRET!);
    expect(text).not.toContain(process.env.RAZORPAY_WEBHOOK_SECRET!);

    sqlite.close();
  });
});
