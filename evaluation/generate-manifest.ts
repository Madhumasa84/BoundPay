import fs from 'fs';
import path from 'path';

type Kind =
  | 'AUTO_VALID' | 'APPROVAL_VALID'
  | 'PURCHASE_BUDGET_BLOCK' | 'MAX_TX_BLOCK' | 'DAILY_BLOCK'
  | 'SUBSCRIPTION_BLOCK' | 'CATEGORY_BLOCK' | 'UNAPPROVED_MERCHANT'
  | 'EXPIRED_POLICY' | 'EXPIRED_QUOTE'
  | 'CHANGED_CATALOG' | 'CHANGED_POLICY'
  | 'IDEMPOTENT_REPEAT' | 'IDEMPOTENCY_CONFLICT' | 'FORCED_COMPROMISE';

interface EvaluationCase {
  case_id: string;
  kind: Kind;
  initial_policy: { source: 'seed'; overrides?: Record<string, unknown> };
  initial_catalog: { source: 'seed'; overrides?: Record<string, Record<string, unknown>> };
  initial_ledger: Array<{ amount_paise: number; status: 'CONFIRMED' | 'RESERVED'; mode: 'MOCK' }>;
  request: { product_id: string; quantity: number; purchase_budget_paise: number; idempotency_key: string; source_mode: 'FIXTURE' };
  approval: { action: 'NONE' | 'APPROVE'; exact_intent: boolean };
  clock: { start: string; advance_seconds: number };
  adapter: { mode: 'MOCK'; behavior: 'CAPTURE' };
  expected: {
    decision_or_state: string;
    provider_order_calls: number;
    reservation_change_paise: number;
    confirmed_spend_change_paise: number;
    error_or_audit_evidence: string;
    request_count: number;
  };
}

const cases: EvaluationCase[] = [];
const add = (kind: Kind, index: number, overrides: Partial<EvaluationCase> = {}) => {
  const id = `${kind.toLowerCase().replaceAll('_', '-')}-${String(index).padStart(2, '0')}`;
  const base: EvaluationCase = {
    case_id: id,
    kind,
    initial_policy: { source: 'seed' },
    initial_catalog: { source: 'seed' },
    initial_ledger: [],
    request: { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: id, source_mode: 'FIXTURE' },
    approval: { action: 'NONE', exact_intent: false },
    clock: { start: '2026-09-03T12:00:00.000Z', advance_seconds: 0 },
    adapter: { mode: 'MOCK', behavior: 'CAPTURE' },
    expected: { decision_or_state: 'PAYMENT_CONFIRMED', provider_order_calls: 1, reservation_change_paise: 0, confirmed_spend_change_paise: 149900, error_or_audit_evidence: 'PAYMENT_CONFIRMED', request_count: 2 },
  };
  cases.push({ ...base, ...overrides, request: { ...base.request, ...overrides.request }, expected: { ...base.expected, ...overrides.expected } });
};

for (let i = 1; i <= 30; i++) add('AUTO_VALID', i);
for (let i = 1; i <= 10; i++) add('APPROVAL_VALID', i, {
  request: { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000 } as any,
  approval: { action: 'APPROVE', exact_intent: true },
  expected: { decision_or_state: 'PAYMENT_CONFIRMED', provider_order_calls: 1, reservation_change_paise: 0, confirmed_spend_change_paise: 279900, error_or_audit_evidence: 'INTENT_APPROVED', request_count: 3 },
});
for (let i = 1; i <= 5; i++) add('PURCHASE_BUDGET_BLOCK', i, { request: { purchase_budget_paise: 100000 } as any, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'PURCHASE_BUDGET_LIMIT', request_count: 1 } });
for (let i = 1; i <= 5; i++) add('MAX_TX_BLOCK', i, { request: { product_id: 'prod_mouse', quantity: 3, purchase_budget_paise: 500000 } as any, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'MAX_TRANSACTION_LIMIT', request_count: 1 } });
for (let i = 1; i <= 5; i++) add('DAILY_BLOCK', i, { initial_policy: { source: 'seed', overrides: { max_transaction_amount_paise: 200000, daily_budget_paise: 200000, approval_threshold_paise: 150000 } }, initial_ledger: [{ amount_paise: 89900, status: 'CONFIRMED', mode: 'MOCK' }], expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'DAILY_BUDGET_AVAILABLE', request_count: 1 } });
for (let i = 1; i <= 5; i++) add('SUBSCRIPTION_BLOCK', i, { request: { product_id: 'prod_subscription', quantity: 1, purchase_budget_paise: 1500000 } as any, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'SUBSCRIPTION_ALLOWED', request_count: 1 } });
for (let i = 1; i <= 5; i++) add('CATEGORY_BLOCK', i, { initial_catalog: { source: 'seed', overrides: { prod_book: { category: 'luxury' } } }, request: { product_id: 'prod_book', quantity: 1, purchase_budget_paise: 100000 } as any, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'CATEGORY_ALLOWED', request_count: 1 } });
for (let i = 1; i <= 5; i++) add('UNAPPROVED_MERCHANT', i, { initial_catalog: { source: 'seed', overrides: { prod_mouse: { merchant_id: 'unapproved_store' } } }, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'APPROVED_MERCHANT', request_count: 1 } });
for (let i = 1; i <= 3; i++) add('EXPIRED_POLICY', i, { initial_policy: { source: 'seed', overrides: { expires_at: '2026-09-03T11:59:59.000Z' } }, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'POLICY_ACTIVE', request_count: 1 } });
for (let i = 1; i <= 2; i++) add('EXPIRED_QUOTE', i, { clock: { start: '2026-09-03T12:00:00.000Z', advance_seconds: 601 }, expected: { decision_or_state: 'EXPIRED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'QUOTE_EXPIRED', request_count: 2 } });
for (let i = 1; i <= 5; i++) add('CHANGED_CATALOG', i, { request: { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000 } as any, approval: { action: 'APPROVE', exact_intent: true }, expected: { decision_or_state: 'EXPIRED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'PRODUCT_VERSION_MISMATCH', request_count: 3 } });
for (let i = 1; i <= 5; i++) add('CHANGED_POLICY', i, { request: { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000 } as any, approval: { action: 'APPROVE', exact_intent: true }, expected: { decision_or_state: 'EXPIRED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'POLICY_VERSION_MISMATCH', request_count: 3 } });
for (let i = 1; i <= 5; i++) add('IDEMPOTENT_REPEAT', i, { expected: { decision_or_state: 'READY', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'same intent ID', request_count: 2 } });
for (let i = 1; i <= 5; i++) add('IDEMPOTENCY_CONFLICT', i, { expected: { decision_or_state: 'CONFLICT', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'Idempotency key', request_count: 2 } });
for (let i = 1; i <= 5; i++) add('FORCED_COMPROMISE', i, { request: { product_id: 'prod_subscription', quantity: 1, purchase_budget_paise: 1500000 } as any, expected: { decision_or_state: 'BLOCKED', provider_order_calls: 0, reservation_change_paise: 0, confirmed_spend_change_paise: 0, error_or_audit_evidence: 'Subscriptions are prohibited', request_count: 1 } });

if (cases.length !== 100) throw new Error(`Expected 100 cases, generated ${cases.length}`);
const output = path.resolve(process.cwd(), 'evaluation/deterministic-cases.json');
fs.writeFileSync(output, `${JSON.stringify({ manifest_version: 1, generated_by: 'evaluation/generate-manifest.ts', case_count: cases.length, cases }, null, 2)}\n`);
console.log(`Wrote ${cases.length} cases to ${output}`);
