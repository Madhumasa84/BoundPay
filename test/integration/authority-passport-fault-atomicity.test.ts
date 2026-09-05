import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, getDb, schema } from '@/infrastructure/db';
import { runMigrations } from '@/infrastructure/db/migrate';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { createAuthorityPassport } from '@/services/passport.service';
import { createProposal } from '@/services/purchase.service';
import { ExecutionService } from '@/services/execution.service';
import { PaymentAdapter } from '@/infrastructure/payment/adapter.interface';

describe('Authority lifecycle fault atomicity', () => {
  const clock = new TestClock('2026-03-01T10:00:00.000Z');
  let dbPath = '';

  beforeEach(() => {
    dbPath = path.resolve(process.cwd(), 'data/test', `authority-fault-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.PAYMENT_ADAPTER_MODE = 'MOCK';
    process.env.AGENT_MODE = 'fixture';
    closeDefaultDb();
    const { sqlite } = getDb();
    runMigrations(sqlite);
    closeDefaultDb();
    seedDatabase(dbPath);
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  function passportAndOwner() {
    const { db } = getDb();
    const owner = db.select().from(schema.operators).get()!;
    const passport = createAuthorityPassport(owner.id, {
      agentId: 'faultbot', agentDisplayName: 'Fault Bot', allowedMerchantIds: ['demo_store'],
      allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 200000,
      cumulativeBudgetPaise: 500000, approvalRequiredAbovePaise: 190000,
      expiresAt: '2027-01-01T00:00:00.000Z', maximumUsageCount: 5,
    }, clock);
    return { owner, passport };
  }

  it('rolls back intent and audit when decision-receipt persistence fails', () => {
    const { owner, passport } = passportAndOwner();
    const { sqlite, db } = getDb();
    const beforeIntents = db.select().from(schema.purchaseIntents).all().length;
    const beforeAudits = db.select().from(schema.auditEvents).all().length;
    sqlite.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON decision_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");

    expect(() => createProposal(owner.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'receipt-fault', source_mode: 'FIXTURE', fault_injection: 'NONE',
      passport_id: passport.payload.passportId, agent_id: passport.payload.agentId,
    }, 'MOCK', clock)).toThrow(/injected receipt failure/i);

    expect(db.select().from(schema.purchaseIntents).all()).toHaveLength(beforeIntents);
    expect(db.select().from(schema.auditEvents).all()).toHaveLength(beforeAudits);
    expect(db.select().from(schema.decisionReceipts).all()).toHaveLength(0);
  });

  it('falls back atomically to durable UNKNOWN when confirmation audit append fails', async () => {
    const { owner, passport } = passportAndOwner();
    const proposal = createProposal(owner.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'confirmation-audit-fault', source_mode: 'FIXTURE', fault_injection: 'NONE',
      passport_id: passport.payload.passportId, agent_id: passport.payload.agentId,
    }, 'MOCK', clock);
    const { sqlite, db } = getDb();
    sqlite.exec("CREATE TRIGGER fail_confirm_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'PAYMENT_CONFIRMED' BEGIN SELECT RAISE(ABORT, 'injected confirmation audit failure'); END");

    const result = await new ExecutionService(undefined, clock).executeIntent(proposal.intent.id, owner.id);
    expect(result.status).toBe('UNKNOWN');
    expect(db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!.state).toBe('UNKNOWN');
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).get()!.status).toBe('RESERVED');
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, proposal.intent.id)).get()!.usage_status).toBe('UNKNOWN');
    expect(db.select().from(schema.auditEvents).all().some((event) => event.event_type === 'PAYMENT_ADAPTER_EXCEPTION')).toBe(true);
  });

  it('linearizes callback and status-refresh confirmation races to one audit transition', async () => {
    const { db } = getDb();
    const owner = db.select().from(schema.operators).get()!;
    const passport = createAuthorityPassport(owner.id, {
      agentId: 'racebot', agentDisplayName: 'Race Bot', allowedMerchantIds: ['demo_store'],
      allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 200000,
      cumulativeBudgetPaise: 500000, approvalRequiredAbovePaise: 190000,
      expiresAt: '2027-01-01T00:00:00.000Z', maximumUsageCount: 5,
    }, clock, 'RAZORPAY_TEST');
    const proposal = createProposal(owner.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'callback-refresh-race', source_mode: 'FIXTURE', fault_injection: 'NONE',
      passport_id: passport.payload.passportId, agent_id: passport.payload.agentId,
    }, 'RAZORPAY_TEST', clock);
    const adapter: PaymentAdapter = {
      mode: 'RAZORPAY_TEST',
      async createOrder() { return { success: true, orderId: 'order_test_race', status: 'CREATED', isMock: false, keyId: 'rzp_test_fake', rawResponse: {} }; },
      async confirmCapture() { await Promise.resolve(); return { success: true, status: 'CAPTURED', isMock: false, orderId: 'order_test_race', paymentId: 'pay_test_race', rawResponse: {} }; },
      async getOrderStatus() { await Promise.resolve(); return { status: 'CAPTURED', isMock: false, orderId: 'order_test_race', paymentId: 'pay_test_race', amountPaise: 149900, currency: 'INR', rawResponse: {} }; },
    };
    const service = new ExecutionService(adapter, clock);
    await service.executeIntent(proposal.intent.id, owner.id);
    const results = await Promise.all([
      service.confirmPaymentCapture(proposal.intent.id, owner.id, { orderId: 'order_test_race', paymentId: 'pay_test_race', signature: 'test-only' }),
      service.refreshPaymentStatus(proposal.intent.id, owner.id),
    ]);
    expect(results.every((result) => result.status === 'PAYMENT_CONFIRMED')).toBe(true);
    expect(db.select().from(schema.auditEvents).all().filter((event) => event.intent_id === proposal.intent.id && event.event_type === 'PAYMENT_CONFIRMED')).toHaveLength(1);
    expect(db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, proposal.intent.id)).all()).toHaveLength(1);
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, proposal.intent.id)).all()).toHaveLength(1);
  });
});
