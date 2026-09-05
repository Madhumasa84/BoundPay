/**
 * Regression test for the stale historical-catalog defect.
 *
 * Background: During Phase 4 Sarvam integration, the live model was observed
 * operating against a stale cached catalog that listed the keyboard at 429900
 * paise instead of the canonical 279900 paise.  The server-side guard must
 * reject checkout when the catalog has advanced since proposal time, regardless
 * of whether the price went up or down.
 *
 * This test exercises the full purchase → catalog mutation → execution path
 * through real services and SQLite to ensure the guard durably prevents
 * stale-price execution and transitions the intent to EXPIRED.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { createProposal } from '@/services/purchase.service';
import { ExecutionService, QuoteRevalidationError } from '@/services/execution.service';
import { updateProduct } from '@/services/catalog.service';
import { PaymentAdapter, PaymentOrderResult, PaymentCaptureResult, PaymentStatusResult, CreateOrderParams, ConfirmCaptureParams } from '@/infrastructure/payment/adapter.interface';
import { eq } from 'drizzle-orm';

class NeverCalledProvider implements PaymentAdapter {
  readonly mode = 'MOCK' as const;
  called = false;
  async createOrder(_params: CreateOrderParams): Promise<PaymentOrderResult> {
    this.called = true;
    throw new Error('Provider must never be called for a stale-catalog intent');
  }
  async confirmCapture(_params: ConfirmCaptureParams): Promise<PaymentCaptureResult> {
    this.called = true;
    throw new Error('Provider must never be called for a stale-catalog intent');
  }
  async getOrderStatus(_orderId: string): Promise<PaymentStatusResult> {
    this.called = true;
    throw new Error('Provider must never be called for a stale-catalog intent');
  }
}

const originalDbPath = process.env.DATABASE_PATH;
const dir = path.resolve(process.cwd(), 'data/test');
fs.mkdirSync(dir, { recursive: true });

describe('Stale historical-catalog regression guard', () => {
  const dbPath = path.join(dir, `stale-catalog-regression-${Date.now()}.sqlite`);

  afterEach(() => {
    closeDefaultDb();
  });

  afterAll(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
    process.env.DATABASE_PATH = originalDbPath;
  });

  it('rejects checkout and transitions to EXPIRED when catalog version advances after proposal', async () => {
    // Set up isolated database
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);

    const clock = new TestClock('2026-09-05T00:00:00Z');

    // 1. Capture the seed keyboard price (279900 paise) and create a proposal
    const keyboardBefore = db.select().from(schema.products).where(eq(schema.products.id, 'prod_keyboard')).get()!;
    expect(keyboardBefore.unit_price_paise).toBe(279900);
    const versionBefore = keyboardBefore.version;

    const operator = db.select().from(schema.operators).limit(1).get()!;
    const proposal = createProposal(
      operator.id,
      {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 400000,
        idempotency_key: `stale-catalog-test-keyboard-${Date.now()}`,
        reason: 'Stale catalog regression test',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock,
    );

    // State may be READY or NEEDS_APPROVAL depending on the policy threshold
    const state = proposal.intent.state;
    expect(['READY', 'NEEDS_APPROVAL']).toContain(state);
    expect(proposal.intent.product_version).toBe(versionBefore);

    // If approval is required, approve it (mirrors the real-world flow)
    if (state === 'NEEDS_APPROVAL') {
      const { approveIntent } = await import('@/services/purchase.service');
      approveIntent(proposal.intent.id, operator.id, 'Approved for regression test', clock);
    }

    // 2. Mutate the catalog (simulates the stale-catalog defect: price jumps to 429900)
    clock.advanceSeconds(5);
    updateProduct('prod_keyboard', { unit_price_paise: 429900 }, operator.id, clock);

    const keyboardAfter = db.select().from(schema.products).where(eq(schema.products.id, 'prod_keyboard')).get()!;
    expect(keyboardAfter.unit_price_paise).toBe(429900);
    expect(keyboardAfter.version).toBeGreaterThan(versionBefore);

    // 3. Attempt execution — must fail with EXPIRED, never reach the provider
    const provider = new NeverCalledProvider();
    const execution = new ExecutionService(provider, clock);

    await expect(
      execution.executeIntent(proposal.intent.id, operator.id),
    ).rejects.toThrow(QuoteRevalidationError);

    expect(provider.called).toBe(false);

    // 4. Verify the intent row is durably EXPIRED in the database
    const finalIntent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!;
    expect(finalIntent.state).toBe('EXPIRED');

    // 5. Verify audit trail records the version mismatch
    const auditEvents = db.select().from(schema.auditEvents).all();
    const mismatchEvent = auditEvents.find(
      (e) => e.event_type === 'PRODUCT_VERSION_MISMATCH' && e.intent_id === proposal.intent.id,
    );
    expect(mismatchEvent).toBeTruthy();

    // 6. Restore the canonical price for subsequent tests
    updateProduct('prod_keyboard', { unit_price_paise: 279900 }, operator.id, clock);
    sqlite.close();
  });

  it('allows checkout when catalog version has NOT changed since proposal', async () => {
    // Set up isolated database
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);

    const clock = new TestClock('2026-09-05T01:00:00Z');
    const operator = db.select().from(schema.operators).limit(1).get()!;

    const proposal = createProposal(
      operator.id,
      {
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: `stale-catalog-test-mouse-${Date.now()}`,
        reason: 'Control case: unchanged catalog',
        fault_injection: 'NONE',
      },
      'MOCK',
      clock,
    );

    expect(proposal.intent.state).toBe('READY');

    // Execute with a mock that actually succeeds
    const mockProvider: PaymentAdapter = {
      mode: 'MOCK',
      async createOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
        return { isMock: true, success: true, orderId: `ctrl_order_${params.intentId}`, status: 'CREATED', rawResponse: {} };
      },
      async confirmCapture(params: ConfirmCaptureParams): Promise<PaymentCaptureResult> {
        return { isMock: true, success: true, orderId: params.orderId, paymentId: `ctrl_pay_${params.orderId}`, status: 'CAPTURED', rawResponse: {} };
      },
      async getOrderStatus(orderId: string): Promise<PaymentStatusResult> {
        return { isMock: true, orderId, paymentId: '', status: 'CREATED', amountPaise: 0, currency: 'INR', rawResponse: {} };
      },
    };

    const execution = new ExecutionService(mockProvider, clock);
    const result = await execution.executeIntent(proposal.intent.id, operator.id);

    expect(result.status).toBe('PAYMENT_CONFIRMED');
    sqlite.close();
  });
});
