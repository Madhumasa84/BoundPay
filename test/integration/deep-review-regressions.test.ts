import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, getDb, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { PaymentAdapter, PaymentStatusResult } from '@/infrastructure/payment/adapter.interface';
import { ExecutionService } from '@/services/execution.service';
import { approveIntent, createProposal, declineIntent } from '@/services/purchase.service';
import { getCurrentPolicy, updatePolicy } from '@/services/policy.service';
import { addProduct, getProductById, updateProduct } from '@/services/catalog.service';
import { checkLoginRateLimit, recordFailedLogin } from '@/infrastructure/auth/rate-limit';
import { GET as getPolicyRoute } from '@/app/api/policy/route';
import * as sharedAuthority from '@/services/shared-authority.service';
import { revokePassport } from '@/services/passport.service';

describe('deep review financial and persistence regressions', () => {
  let directory: string;
  let ownerId: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  beforeEach(() => {
    clock.setTime('2026-09-03T12:00:00.000Z');
    closeDefaultDb();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-deep-review-'));
    process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.SHARED_AUTHORITY_MODE = 'DISABLED';
    seedDatabase();
    ownerId = getDb().db.select().from(schema.operators).get()!.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDefaultDb();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function proposal(productId = 'prod_mouse') {
    return createProposal(ownerId, {
      product_id: productId, quantity: 1, purchase_budget_paise: 400000,
      idempotency_key: `review-${Math.random()}`, source_mode: 'FIXTURE', fault_injection: 'NONE',
    }, 'RAZORPAY_TEST', clock).intent;
  }

  function adapter(status: Partial<PaymentStatusResult> = {}): PaymentAdapter {
    return {
      mode: 'RAZORPAY_TEST',
      async createOrder() { return { isMock: false, success: true, status: 'CREATED', orderId: 'order_review', rawResponse: {} }; },
      async confirmCapture(input) { return { isMock: false, success: true, status: 'CAPTURED', orderId: input.orderId, paymentId: input.paymentId, rawResponse: {} }; },
      async getOrderStatus() { return { isMock: false, status: 'CAPTURED', orderId: 'order_review', paymentId: 'pay_review', amountPaise: 149900, currency: 'INR', rawResponse: {}, ...status }; },
      verifyWebhookSignature() { return true; },
    };
  }

  function stored(intentId: string) {
    const { db } = getDb();
    return {
      intent: db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get()!,
      ledger: db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, intentId)).get()!,
    };
  }

  it.each(['revocation', 'policy', 'catalog', 'quote expiry'])('rechecks %s after shared ledger authorization awaits', async (change) => {
    const intent = proposal();
    process.env.SHARED_AUTHORITY_MODE = 'DRUNIX';
    vi.spyOn(sharedAuthority, 'prepareSharedDispatch').mockImplementation(async () => {
      if (change === 'revocation') revokePassport(intent.passport_id!, ownerId, clock);
      if (change === 'policy') updatePolicy({ ...getCurrentPolicy(), daily_budget_paise: 600000 }, ownerId, clock);
      if (change === 'catalog') updateProduct('prod_mouse', { unit_price_paise: 100000 }, ownerId, clock);
      if (change === 'quote expiry') clock.advanceMinutes(11);
      return {} as sharedAuthority.SharedDispatchAuthorization;
    });
    const dispatch = vi.spyOn(sharedAuthority, 'markSharedProviderRequestStarted');
    const provider = adapter();
    const createOrder = vi.spyOn(provider, 'createOrder');
    await expect(new ExecutionService(provider, clock).executeIntent(intent.id, ownerId)).rejects.toThrow('Local authority changed');
    expect(createOrder).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(stored(intent.id).intent.state).toBe('UNKNOWN');
    expect(stored(intent.id).ledger.status).toBe('RESERVED');
  });

  it.each([
    { amountPaise: 1 }, { currency: 'USD' }, { orderId: 'order_other' }, { paymentId: undefined },
  ])('does not confirm mismatched or incomplete status evidence %j', async (evidence) => {
    const intent = proposal();
    const service = new ExecutionService(adapter(evidence), clock);
    await service.executeIntent(intent.id, ownerId);
    await expect(service.refreshPaymentStatus(intent.id, ownerId)).rejects.toThrow();
    expect(stored(intent.id).intent.state).toBe('ORDER_CREATED');
    expect(stored(intent.id).ledger.status).toBe('RESERVED');
  });

  it('does not bind an UNKNOWN intent to a checkout order supplied by the client', async () => {
    const intent = proposal();
    const provider = adapter();
    provider.createOrder = async () => ({ isMock: false, success: false, status: 'UNKNOWN', rawResponse: {} });
    const service = new ExecutionService(provider, clock);
    await service.executeIntent(intent.id, ownerId);
    await expect(service.confirmPaymentCapture(intent.id, ownerId, {
      orderId: 'order_from_other_purchase', paymentId: 'pay_other', signature: 'valid-for-other-order',
    })).rejects.toThrow();
    expect(stored(intent.id).intent.state).toBe('UNKNOWN');
    expect(stored(intent.id).ledger.status).toBe('RESERVED');
  });

  it('preserves confirmation when an older failure query finishes after a capture', async () => {
    const intent = proposal();
    const provider = adapter();
    let answer!: (status: PaymentStatusResult) => void;
    provider.getOrderStatus = () => new Promise((resolve) => { answer = resolve; });
    const service = new ExecutionService(provider, clock);
    await service.executeIntent(intent.id, ownerId);
    const refresh = service.refreshPaymentStatus(intent.id, ownerId);
    await service.confirmPaymentCapture(intent.id, ownerId, { orderId: 'order_review', paymentId: 'pay_review', signature: 'test' });
    answer({ isMock: false, orderId: 'order_review', status: 'FAILED', amountPaise: 149900, currency: 'INR', rawResponse: {} });
    const result = await refresh;
    expect(result.status).toBe('PAYMENT_CONFIRMED');
    expect(stored(intent.id).intent.state).toBe('PAYMENT_CONFIRMED');
    expect(stored(intent.id).ledger.status).toBe('CONFIRMED');
  });

  it('does not confirm an order.paid webhook without captured payment evidence', async () => {
    const intent = proposal();
    const service = new ExecutionService(adapter(), clock);
    await service.executeIntent(intent.id, ownerId);
    const result = await service.handleRazorpayWebhook(JSON.stringify({
      event: 'order.paid', payload: { order: { entity: { id: 'order_review', amount: 1, currency: 'USD', status: 'paid' } } },
    }), 'test', 'evt_missing_payment');
    expect(result.processed).toBe(false);
    expect(stored(intent.id).intent.state).toBe('ORDER_CREATED');
    expect(stored(intent.id).ledger.status).toBe('RESERVED');
  });

  function rejectAudit(eventType: string) {
    getDb().sqlite.exec(`CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
  }

  it('rolls back early webhook reconciliation if confirmation audit fails', async () => {
    const intent = proposal();
    const service = new ExecutionService(adapter(), clock);
    await service.handleRazorpayWebhook(JSON.stringify({
      event: 'payment.captured', payload: { payment: { entity: { id: 'pay_review', order_id: 'order_review', status: 'captured', amount: 149900, currency: 'INR' } } },
    }), 'test', 'evt_early_atomic');
    rejectAudit('PAYMENT_CONFIRMED');
    await service.executeIntent(intent.id, ownerId);
    expect(stored(intent.id).intent.state).toBe('ORDER_CREATED');
    expect(stored(intent.id).ledger.status).toBe('RESERVED');
    expect(getDb().db.select().from(schema.webhookEvents).get()!.status).toBe('UNMATCHED');
  });

  it('does not let receipt reconciliation dispatch or mutate an unexecuted proposal', async () => {
    const intent = proposal();
    const provider = adapter();
    provider.reconcileOrderByReceipt = async () => ({ isMock: false, orderId: 'order_review', status: 'CREATED', amountPaise: 0, currency: 'INR', rawResponse: {} });
    await expect(new ExecutionService(provider, clock).reconcileUncertainIntent(intent.id, ownerId)).rejects.toThrow();
    expect(stored(intent.id).intent.state).toBe('READY');
    expect(stored(intent.id).intent.provider_order_id).toBeNull();
  });

  it('normalizes policy expiry with a timezone offset before persistence', () => {
    const result = updatePolicy({ ...getCurrentPolicy(), expires_at: '2026-10-01T00:00:00+05:30' }, ownerId, clock);
    expect(result.expires_at).toBe('2026-09-30T18:30:00.000Z');
    expect(getCurrentPolicy().expires_at).toBe(result.expires_at);
  });

  it('reports the configured payment namespace in policy budget usage', async () => {
    const previousMode = process.env.PAYMENT_ADAPTER_MODE;
    const previousLegacyMode = process.env.PAYMENT_MODE;
    try {
      process.env.PAYMENT_ADAPTER_MODE = 'RAZORPAY_TEST';
      process.env.PAYMENT_MODE = 'RAZORPAY_TEST';
      const intent = proposal();
      new ExecutionService(adapter(), clock).claimAndReserveAtomic(intent.id, ownerId);
      const response = await getPolicyRoute(new Request('http://localhost/api/policy'));
      const data = await response.json();
      expect(data.usage.activeReservationsPaise).toBe(149900);
    } finally {
      if (previousMode === undefined) delete process.env.PAYMENT_ADAPTER_MODE;
      else process.env.PAYMENT_ADAPTER_MODE = previousMode;
      if (previousLegacyMode === undefined) delete process.env.PAYMENT_MODE;
      else process.env.PAYMENT_MODE = previousLegacyMode;
    }
  });

  it('rolls back policy publication when its audit record fails', () => {
    const policy = getCurrentPolicy();
    rejectAudit('POLICY_UPDATED');
    expect(() => updatePolicy({ ...policy, daily_budget_paise: 600000 }, ownerId, clock)).toThrow();
    expect(getCurrentPolicy()).toEqual(policy);
  });

  it('rolls back a catalog update when its audit record fails', () => {
    const product = getProductById('prod_mouse')!;
    rejectAudit('CATALOG_PRODUCT_UPDATED');
    expect(() => updateProduct(product.id, { unit_price_paise: 1 }, ownerId, clock)).toThrow();
    expect(getProductById(product.id)).toEqual(product);
  });

  it('validates catalog additions from direct service callers', () => {
    const product = getProductById('prod_mouse')!;
    expect(() => addProduct({ ...product, id: 'unsafe_product', unit_price_paise: 1.5 }, ownerId, clock)).toThrow();
    expect(getProductById('unsafe_product')).toBeNull();
  });

  it('rolls back approval and its exact approval record when audit fails', () => {
    const intent = proposal('prod_keyboard');
    rejectAudit('INTENT_APPROVED');
    expect(() => approveIntent(intent.id, ownerId, undefined, clock)).toThrow();
    expect(stored(intent.id).intent.state).toBe('NEEDS_APPROVAL');
    expect(getDb().db.select().from(schema.intentApprovals).where(eq(schema.intentApprovals.intent_id, intent.id)).all()).toHaveLength(0);
  });

  it('rolls back a decline when its audit record fails', () => {
    const intent = proposal('prod_keyboard');
    rejectAudit('INTENT_DECLINED');
    expect(() => declineIntent(intent.id, ownerId, undefined, clock)).toThrow();
    expect(stored(intent.id).intent.state).toBe('NEEDS_APPROVAL');
  });

  it('allows a fresh failure window after a login lockout expires', () => {
    const { db } = getDb();
    const identifier = 'operator-review';
    db.insert(schema.loginAttempts).values({ identifier, consecutive_failures: 5, locked_until: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z' }).run();
    expect(checkLoginRateLimit(identifier).locked).toBe(false);
    recordFailedLogin(identifier);
    expect(checkLoginRateLimit(identifier).locked).toBe(false);
    expect(db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier)).get()!.consecutive_failures).toBe(1);
  });
});
