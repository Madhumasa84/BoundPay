import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const operators = sqliteTable('operators', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: text('created_at').notNull(),
});

export const operatorSessions = sqliteTable('operator_sessions', {
  id: text('id').primaryKey(),
  operator_id: text('operator_id').notNull().references(() => operators.id),
  token_hash: text('token_hash').notNull().unique(),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').notNull(),
  revoked_at: text('revoked_at'),
}, (table) => ({
  tokenIdx: index('idx_sessions_token').on(table.token_hash),
  operatorIdx: index('idx_sessions_operator').on(table.operator_id),
}));

export const loginAttempts = sqliteTable('login_attempts', {
  identifier: text('identifier').primaryKey(),
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  locked_until: text('locked_until'),
  updated_at: text('updated_at').notNull(),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  unit_price_paise: integer('unit_price_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  category: text('category').notNull(),
  is_subscription: integer('is_subscription', { mode: 'boolean' }).notNull().default(false),
  merchant_id: text('merchant_id').notNull(),
  version: integer('version').notNull().default(1),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  updated_at: text('updated_at').notNull(),
});

export const policies = sqliteTable('policies', {
  id: text('id').primaryKey(),
  version: integer('version').notNull().unique(),
  currency: text('currency').notNull().default('INR'),
  max_transaction_amount_paise: integer('max_transaction_amount_paise').notNull(),
  daily_budget_paise: integer('daily_budget_paise').notNull(),
  approval_threshold_paise: integer('approval_threshold_paise').notNull(),
  allowed_categories_json: text('allowed_categories_json').notNull(),
  approved_merchant_id: text('approved_merchant_id').notNull(),
  allow_subscriptions: integer('allow_subscriptions', { mode: 'boolean' }).notNull().default(false),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').notNull(),
});

/** Immutable signed authority mandates. Status/revoked_at are the only mutable fields. */
export const authorityPassports = sqliteTable('authority_passports', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').notNull().references(() => operators.id),
  agent_id: text('agent_id').notNull(),
  issuer: text('issuer').notNull(),
  audience: text('audience').notNull(),
  policy_version: integer('policy_version').notNull(),
  payload_json: text('payload_json').notNull(),
  payload_digest: text('payload_digest').notNull(),
  signed_token: text('signed_token').notNull(),
  key_id: text('key_id').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  valid_from: text('valid_from').notNull(),
  expires_at: text('expires_at').notNull(),
  revocation_nonce: text('revocation_nonce').notNull().unique(),
  revoked_at: text('revoked_at'),
  idempotency_key: text('idempotency_key'),
  created_at: text('created_at').notNull(),
}, (table) => ({
  ownerIdx: index('idx_passports_owner').on(table.owner_id),
  statusIdx: index('idx_passports_status').on(table.status),
  agentIdx: index('idx_passports_agent').on(table.agent_id),
  idempotencyIdx: uniqueIndex('idx_passports_idempotency').on(table.owner_id, table.idempotency_key),
}));

export const purchaseIntents = sqliteTable('purchase_intents', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').notNull().references(() => operators.id),
  idempotency_key: text('idempotency_key').notNull(),
  canonical_request_hash: text('canonical_request_hash').notNull(),
  product_id: text('product_id').notNull().references(() => products.id),
  merchant_id: text('merchant_id').notNull(),
  quantity: integer('quantity').notNull(),
  unit_price_paise: integer('unit_price_paise').notNull(),
  total_amount_paise: integer('total_amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  category: text('category').notNull(),
  is_subscription: integer('is_subscription', { mode: 'boolean' }).notNull().default(false),
  product_version: integer('product_version').notNull(),
  policy_version: integer('policy_version').notNull(),
  purchase_budget_paise: integer('purchase_budget_paise').notNull(),
  quote_expiry: text('quote_expiry').notNull(),
  source_mode: text('source_mode').notNull(), // 'MANUAL' | 'FIXTURE' | 'LIVE_MODEL' | 'AGENT_PROPOSAL'
  payment_adapter_mode: text('payment_adapter_mode').notNull(), // 'MOCK' | 'RAZORPAY_TEST'
  model_provider: text('model_provider'),
  model_name: text('model_name'),
  passport_id: text('passport_id').references(() => authorityPassports.id),
  passport_payload_digest: text('passport_payload_digest'),
  agent_id: text('agent_id'),
  receipt: text('receipt'),
  provider_order_id: text('provider_order_id'),
  provider_payment_id: text('provider_payment_id'),
  state: text('state').notNull(), // IntentState
  failure_reason: text('failure_reason'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
}, (table) => ({
  idempotencyUniqueIdx: uniqueIndex('idx_intents_idempotency').on(
    table.owner_id,
    table.idempotency_key,
    table.payment_adapter_mode
  ),
  stateIdx: index('idx_intents_state').on(table.state),
  createdIdx: index('idx_intents_created_at').on(table.created_at),
  orderIdx: index('idx_intents_order_id').on(table.provider_order_id),
}));

export const intentApprovals = sqliteTable('intent_approvals', {
  id: text('id').primaryKey(),
  intent_id: text('intent_id').notNull().references(() => purchaseIntents.id),
  operator_id: text('operator_id').notNull().references(() => operators.id),
  canonical_hash: text('canonical_hash').notNull(),
  status: text('status').notNull(), // 'APPROVED' | 'DECLINED'
  notes: text('notes'),
  approved_at: text('approved_at').notNull(),
}, (table) => ({
  intentApprovalIdx: index('idx_approvals_intent').on(table.intent_id),
}));

export const spendLedger = sqliteTable('spend_ledger', {
  id: text('id').primaryKey(),
  intent_id: text('intent_id').notNull().references(() => purchaseIntents.id),
  amount_paise: integer('amount_paise').notNull(),
  status: text('status').notNull(), // 'RESERVED' | 'CONFIRMED' | 'RELEASED'
  reservation_timestamp: text('reservation_timestamp').notNull(),
  confirmation_timestamp: text('confirmation_timestamp'),
  payment_adapter_mode: text('payment_adapter_mode').notNull(),
  provider_order_id: text('provider_order_id'),
  provider_payment_id: text('provider_payment_id'),
}, (table) => ({
  intentLedgerIdx: index('idx_ledger_intent').on(table.intent_id),
  oneLedgerPerIntentIdx: uniqueIndex('idx_ledger_one_per_intent').on(table.intent_id),
  statusIdx: index('idx_ledger_status').on(table.status),
  confirmTimeIdx: index('idx_ledger_confirm_time').on(table.confirmation_timestamp),
}));

/** One durable usage row per passport and intent. RELEASED is only for definite provider rejection. */
export const passportUsages = sqliteTable('passport_usages', {
  id: text('id').primaryKey(),
  passport_id: text('passport_id').notNull().references(() => authorityPassports.id),
  intent_id: text('intent_id').notNull().references(() => purchaseIntents.id),
  amount_paise: integer('amount_paise').notNull(),
  payment_adapter_mode: text('payment_adapter_mode').notNull(),
  usage_status: text('usage_status').notNull(),
  reservation_timestamp: text('reservation_timestamp').notNull(),
  released_or_committed_timestamp: text('released_or_committed_timestamp'),
  created_at: text('created_at').notNull(),
}, (table) => ({
  passportIdx: index('idx_passport_usage_passport').on(table.passport_id),
  intentIdx: index('idx_passport_usage_intent').on(table.intent_id),
  statusIdx: index('idx_passport_usage_status').on(table.usage_status),
  onePerIntentIdx: uniqueIndex('idx_passport_usage_one_per_intent').on(table.passport_id, table.intent_id),
}));

/** Immutable signed deterministic authorization receipts. */
export const decisionReceipts = sqliteTable('decision_receipts', {
  id: text('id').primaryKey(),
  intent_id: text('intent_id').notNull().references(() => purchaseIntents.id),
  receipt_schema_version: integer('receipt_schema_version').notNull(),
  decision: text('decision').notNull(),
  request_hash: text('request_hash').notNull(),
  passport_id: text('passport_id').notNull(),
  passport_payload_digest: text('passport_payload_digest').notNull(),
  payload_json: text('payload_json').notNull(),
  signed_token: text('signed_token').notNull(),
  key_id: text('key_id').notNull(),
  issued_at: text('issued_at').notNull(),
}, (table) => ({
  intentIdx: index('idx_decision_receipts_intent').on(table.intent_id),
  decisionIdx: index('idx_decision_receipts_decision').on(table.decision),
  requestIdx: index('idx_decision_receipts_request').on(table.request_hash),
}));

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull(),
  event_type: text('event_type').notNull(),
  intent_id: text('intent_id'),
  operator_id: text('operator_id'),
  policy_version: integer('policy_version'),
  amount_paise: integer('amount_paise'),
  state_before: text('state_before'),
  state_after: text('state_after'),
  payload_json: text('payload_json').notNull(),
}, (table) => ({
  timeIdx: index('idx_audit_time').on(table.timestamp),
  intentIdx: index('idx_audit_intent').on(table.intent_id),
  typeIdx: index('idx_audit_type').on(table.event_type),
}));

export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('RAZORPAY'),
  event_id: text('event_id').notNull(),
  event_type: text('event_type').notNull(),
  intent_id: text('intent_id'),
  order_id: text('order_id'),
  payment_id: text('payment_id'),
  payload_json: text('payload_json').notNull(),
  status: text('status').notNull(), // 'PROCESSED' | 'IGNORED' | 'UNMATCHED'
  received_at: text('received_at').notNull(),
  processed_at: text('processed_at'),
}, (table) => ({
  eventUniqueIdx: uniqueIndex('idx_webhook_events_unique').on(table.provider, table.event_id),
  orderIdx: index('idx_webhook_order').on(table.order_id),
  statusIdx: index('idx_webhook_status').on(table.status),
}));
