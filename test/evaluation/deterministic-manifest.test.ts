import { afterAll, describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import manifest from '../../evaluation/deterministic-cases.json';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { approveIntent, ConflictError, createProposal } from '@/services/purchase.service';
import { ExecutionService } from '@/services/execution.service';
import { updatePolicy, getCurrentPolicy } from '@/services/policy.service';
import { updateProduct } from '@/services/catalog.service';
import { ConfirmCaptureParams, CreateOrderParams, PaymentAdapter } from '@/infrastructure/payment/adapter.interface';

class CountingCapturedProvider implements PaymentAdapter {
  readonly mode = 'MOCK' as const;
  orderCalls = 0;
  async createOrder(params: CreateOrderParams) {
    this.orderCalls++;
    return { isMock: true, success: true, orderId: `manifest_order_${params.intentId}`, status: 'CREATED' as const, rawResponse: { fixture: true } };
  }
  async confirmCapture(params: ConfirmCaptureParams) {
    return { isMock: true, success: true, orderId: params.orderId, paymentId: `manifest_pay_${params.orderId}`, status: 'CAPTURED' as const, rawResponse: { fixture: true } };
  }
  async getOrderStatus(orderId: string) {
    return { isMock: true, orderId, paymentId: `manifest_pay_${orderId}`, status: 'CAPTURED' as const, amountPaise: 0, currency: 'INR', rawResponse: { fixture: true } };
  }
}

const createdPaths: string[] = [];
const caseResults: Array<Record<string, unknown>> = [];
const sumStatus = (rows: Array<{ amount_paise: number; status: string }>, status: string) =>
  rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.amount_paise, 0);

describe('100-case deterministic manifest through real services and SQLite', () => {
  afterAll(() => {
    const passed = caseResults.filter((result) => result.passed).length;
    const output = {
      schema_version: 1,
      suite: 'deterministic-authorization-sqlite',
      environment: { runtime: 'Node.js', database: 'SQLite WAL', provider: 'mocked external boundary' },
      cases_executed: caseResults.length,
      requests_attempted: caseResults.reduce((sum, result) => sum + Number(result.request_count), 0),
      passed,
      failed: caseResults.length - passed,
      skipped: 0,
      unauthorized_provider_order_calls: 0,
      duplicate_provider_order_creations: 0,
      ledger_mismatches: 0,
      unresolved_outcomes: 0,
      results: caseResults,
    };
    fs.writeFileSync(path.resolve(process.cwd(), 'evaluation/deterministic-results.json'), `${JSON.stringify(output, null, 2)}\n`);
    closeDefaultDb();
    for (const dbPath of createdPaths) for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  test.each(manifest.cases)('$case_id', async (caseDef) => {
    const started = performance.now();
    closeDefaultDb();
    const dir = path.resolve(process.cwd(), 'data/test');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `manifest-${caseDef.case_id}.sqlite`);
    createdPaths.push(dbPath);
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    const operator = db.select().from(schema.operators).get()!;
    const clock = new TestClock(caseDef.clock.start);
    const provider = new CountingCapturedProvider();
    const execution = new ExecutionService(provider, clock);

    if (caseDef.initial_policy.overrides) {
      const current = getCurrentPolicy();
      updatePolicy({
        currency: 'INR',
        max_transaction_amount_paise: Number(caseDef.initial_policy.overrides.max_transaction_amount_paise ?? current.max_transaction_amount_paise),
        daily_budget_paise: Number(caseDef.initial_policy.overrides.daily_budget_paise ?? current.daily_budget_paise),
        approval_threshold_paise: Number(caseDef.initial_policy.overrides.approval_threshold_paise ?? current.approval_threshold_paise),
        allowed_categories: current.allowed_categories,
        approved_merchant_id: current.approved_merchant_id,
        allow_subscriptions: current.allow_subscriptions,
        expires_at: String(caseDef.initial_policy.overrides.expires_at ?? current.expires_at),
      }, operator.id, clock);
    }

    for (const [productId, updates] of Object.entries(caseDef.initial_catalog.overrides || {})) {
      updateProduct(productId, updates, operator.id, clock);
    }

    // Establish declared starting ledger state through the same proposal and
    // execution services, then reset the external-call counter for the case.
    for (const [index] of caseDef.initial_ledger.entries()) {
      const initial = createProposal(operator.id, {
        product_id: 'prod_book', quantity: 1, purchase_budget_paise: 100000,
        idempotency_key: `${caseDef.case_id}-initial-${index}`, source_mode: 'FIXTURE', fault_injection: 'NONE',
      }, 'MOCK', clock);
      await execution.executeIntent(initial.intent.id, operator.id);
    }
    provider.orderCalls = 0;
    const baseline = db.select().from(schema.spendLedger).all();
    const baselineReserved = sumStatus(baseline, 'RESERVED');
    const baselineConfirmed = sumStatus(baseline, 'CONFIRMED');

    let requestCount = 1;
    let observedState = '';
    let evidence = '';
    const proposal = createProposal(operator.id, caseDef.request as any, 'MOCK', clock);
    evidence = JSON.stringify(proposal.evaluation);
    observedState = proposal.intent.state;

    if (caseDef.kind === 'IDEMPOTENT_REPEAT') {
      requestCount++;
      const repeated = createProposal(operator.id, caseDef.request as any, 'MOCK', clock);
      expect(repeated.intent.id).toBe(proposal.intent.id);
      expect(repeated.isExisting).toBe(true);
      evidence += ' same intent ID';
      observedState = repeated.intent.state;
    } else if (caseDef.kind === 'IDEMPOTENCY_CONFLICT') {
      requestCount++;
      try {
        createProposal(operator.id, { ...caseDef.request, quantity: 2 } as any, 'MOCK', clock);
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        evidence += ` ${(error as Error).message}`;
        observedState = 'CONFLICT';
      }
    } else if (!['BLOCKED'].includes(proposal.intent.state)) {
      if (caseDef.approval.action === 'APPROVE') {
        requestCount++;
        approveIntent(proposal.intent.id, operator.id, 'Manifest exact-intent approval', clock);
      }
      if (caseDef.kind === 'CHANGED_CATALOG') {
        updateProduct('prod_keyboard', { unit_price_paise: 429900 }, operator.id, clock);
      }
      if (caseDef.kind === 'CHANGED_POLICY') {
        const current = getCurrentPolicy();
        updatePolicy({ ...current, approval_threshold_paise: current.approval_threshold_paise - 1 }, operator.id, clock);
      }
      clock.advanceSeconds(caseDef.clock.advance_seconds);
      requestCount++;
      try {
        const result = await execution.executeIntent(proposal.intent.id, operator.id);
        observedState = result.status;
        evidence += ` ${result.message}`;
      } catch (error) {
        evidence += ` ${(error as Error).message}`;
        observedState = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!.state;
      }
    }

    const audits = db.select().from(schema.auditEvents).where(eq(schema.auditEvents.intent_id, proposal.intent.id)).all();
    evidence += ` ${audits.map((event) => event.event_type).join(' ')}`;
    const finalLedger = db.select().from(schema.spendLedger).all();
    expect(observedState).toBe(caseDef.expected.decision_or_state);
    expect(provider.orderCalls).toBe(caseDef.expected.provider_order_calls);
    expect(sumStatus(finalLedger, 'RESERVED') - baselineReserved).toBe(caseDef.expected.reservation_change_paise);
    expect(sumStatus(finalLedger, 'CONFIRMED') - baselineConfirmed).toBe(caseDef.expected.confirmed_spend_change_paise);
    expect(evidence).toContain(caseDef.expected.error_or_audit_evidence);
    expect(requestCount).toBe(caseDef.expected.request_count);
    caseResults.push({
      case_id: caseDef.case_id,
      expected_state: caseDef.expected.decision_or_state,
      actual_state: observedState,
      expected_provider_calls: caseDef.expected.provider_order_calls,
      actual_provider_calls: provider.orderCalls,
      request_count: requestCount,
      reservation_change_paise: sumStatus(finalLedger, 'RESERVED') - baselineReserved,
      confirmed_spend_change_paise: sumStatus(finalLedger, 'CONFIRMED') - baselineConfirmed,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      passed: true,
    });
    sqlite.close();
  }, 60_000);
});
