-- Synthetic Phase 3 database fixture, based on migration schema at commit 554776a.
-- It contains no production credentials or payment data.
CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  category TEXT NOT NULL,
  is_subscription INTEGER NOT NULL DEFAULT 0,
  merchant_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE purchase_intents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES operators(id),
  idempotency_key TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  merchant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  total_amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  category TEXT NOT NULL,
  is_subscription INTEGER NOT NULL DEFAULT 0,
  product_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  purchase_budget_paise INTEGER NOT NULL,
  quote_expiry TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  payment_adapter_mode TEXT NOT NULL,
  model_provider TEXT,
  model_name TEXT,
  receipt TEXT,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  state TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE spend_ledger (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES purchase_intents(id),
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL,
  reservation_timestamp TEXT NOT NULL,
  confirmation_timestamp TEXT,
  payment_adapter_mode TEXT NOT NULL,
  provider_order_id TEXT,
  provider_payment_id TEXT
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  intent_id TEXT,
  operator_id TEXT,
  policy_version INTEGER,
  amount_paise INTEGER,
  state_before TEXT,
  state_after TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'RAZORPAY',
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  intent_id TEXT,
  order_id TEXT,
  payment_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

INSERT INTO operators VALUES ('legacy-owner', 'legacy-owner', 'synthetic-hash', '2026-01-01T00:00:00.000Z');
INSERT INTO products VALUES ('legacy-product', 'Legacy Mouse', 'Synthetic Phase 3 item', 149900, 'INR', 'electronics', 0, 'demo_store', 1, 1, '2026-01-01T00:00:00.000Z');
INSERT INTO purchase_intents (
  id, owner_id, idempotency_key, canonical_request_hash, product_id, merchant_id,
  quantity, unit_price_paise, total_amount_paise, currency, category, is_subscription,
  product_version, policy_version, purchase_budget_paise, quote_expiry, source_mode,
  payment_adapter_mode, receipt, provider_order_id, provider_payment_id, state,
  created_at, updated_at
) VALUES (
  'legacy-intent', 'legacy-owner', 'legacy-request', 'synthetic-canonical-hash',
  'legacy-product', 'demo_store', 1, 149900, 149900, 'INR', 'electronics', 0,
  1, 1, 200000, '2027-01-01T00:00:00.000Z', 'FIXTURE', 'RAZORPAY_TEST',
  'legacy-receipt', 'order_legacy', 'pay_legacy', 'PAYMENT_CONFIRMED',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'
);
INSERT INTO spend_ledger VALUES (
  'legacy-ledger', 'legacy-intent', 149900, 'CONFIRMED',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
  'RAZORPAY_TEST', 'order_legacy', 'pay_legacy'
);
INSERT INTO audit_events (
  timestamp, event_type, intent_id, operator_id, policy_version,
  amount_paise, state_before, state_after, payload_json
) VALUES (
  '2026-01-01T00:01:00.000Z', 'PAYMENT_CONFIRMED', 'legacy-intent',
  'legacy-owner', 1, 149900, 'ORDER_CREATED', 'PAYMENT_CONFIRMED',
  '{"source":"synthetic-phase3"}'
);
INSERT INTO webhook_events VALUES (
  'legacy-webhook', 'RAZORPAY', 'evt_legacy', 'payment.captured',
  'legacy-intent', 'order_legacy', 'pay_legacy',
  '{"source":"synthetic-phase3"}', 'PROCESSED',
  '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z'
);
