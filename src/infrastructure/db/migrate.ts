import Database from 'better-sqlite3';
import { createSqliteConnection, getDatabasePath } from './index';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON operator_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_operator ON operator_sessions(operator_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
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

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'INR',
  max_transaction_amount_paise INTEGER NOT NULL,
  daily_budget_paise INTEGER NOT NULL,
  approval_threshold_paise INTEGER NOT NULL,
  allowed_categories_json TEXT NOT NULL,
  approved_merchant_id TEXT NOT NULL,
  allow_subscriptions INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_intents (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idempotency ON purchase_intents(owner_id, idempotency_key, payment_adapter_mode);
CREATE INDEX IF NOT EXISTS idx_intents_state ON purchase_intents(state);
CREATE INDEX IF NOT EXISTS idx_intents_created_at ON purchase_intents(created_at);

CREATE TABLE IF NOT EXISTS intent_approvals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES purchase_intents(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  canonical_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT,
  approved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_intent ON intent_approvals(intent_id);

CREATE TABLE IF NOT EXISTS spend_ledger (
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

CREATE INDEX IF NOT EXISTS idx_ledger_intent ON spend_ledger(intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_one_per_intent ON spend_ledger(intent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON spend_ledger(status);
CREATE INDEX IF NOT EXISTS idx_ledger_confirm_time ON spend_ledger(confirmation_timestamp);

CREATE TABLE IF NOT EXISTS audit_events (
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

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_intent ON audit_events(intent_id);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);

CREATE TABLE IF NOT EXISTS webhook_events (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_unique ON webhook_events(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_order ON webhook_events(order_id);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status);
`;

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(MIGRATION_SQL);

  // Safely alter purchase_intents for any existing database files
  const columns = sqlite.pragma('table_info(purchase_intents)') as Array<{ name: string }>;
  const colNames = new Set(columns.map((c) => c.name));

  const additions = [
    { name: 'model_provider', type: 'TEXT' },
    { name: 'model_name', type: 'TEXT' },
    { name: 'receipt', type: 'TEXT' },
    { name: 'provider_order_id', type: 'TEXT' },
    { name: 'provider_payment_id', type: 'TEXT' },
  ];

  for (const col of additions) {
    if (!colNames.has(col.name)) {
      try {
        sqlite.exec(`ALTER TABLE purchase_intents ADD COLUMN ${col.name} ${col.type}`);
      } catch {}
    }
  }

  try {
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_intents_order_id ON purchase_intents(provider_order_id);');
  } catch {}
}

if (require.main === module) {
  const dbPath = getDatabasePath();
  console.log(`Running migrations on ${dbPath}...`);
  const sqlite = createSqliteConnection(dbPath);
  runMigrations(sqlite);
  sqlite.close();
  console.log('Migrations applied successfully.');
}
