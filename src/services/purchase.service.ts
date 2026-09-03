import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import {
  CanonicalIntentPayload,
  computeCanonicalIntentHash,
  CreateProposalInput,
  CreateProposalRequestSchema,
  PurchaseIntent,
} from '../domain/intent';
import { evaluateSpendingPolicy, PolicyEvaluation } from '../domain/policy';
import { IntentStates, IntentState, assertValidTransition } from '../domain/state-machine';
import { getProductById } from './catalog.service';
import { getCurrentPolicy, getDailyBudgetUsage } from './policy.service';
import { Clock, defaultClock } from '../infrastructure/clock/clock';
import { appendAuditEvent } from './audit.service';

export const DEFAULT_QUOTE_VALIDITY_SECONDS = 600; // 10 minutes

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface ProposalResult {
  intent: PurchaseIntent;
  evaluation: PolicyEvaluation;
  isExisting: boolean;
}

export function createProposal(
  ownerId: string,
  rawRequest: CreateProposalInput,
  paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST' = 'MOCK',
  clock: Clock = defaultClock
): ProposalResult {
  const request = CreateProposalRequestSchema.parse(rawRequest);
  const { db } = getDb();
  const now = clock.now();
  const nowIso = now.toISOString();

  // 1. Resolve trusted product attributes from server-controlled catalog
  const product = getProductById(request.product_id);
  if (!product || !product.is_active) {
    throw new NotFoundError(`Product '${request.product_id}' not found in server catalog`);
  }

  // 2. Resolve current spending policy
  const policy = getCurrentPolicy();

  // 3. Query current budget usage for policy evaluation
  const budgetUsage = getDailyBudgetUsage(paymentAdapterMode, clock, policy);

  // 4. Deterministic policy evaluation
  const evaluation = evaluateSpendingPolicy({
    policy,
    product,
    quantity: request.quantity,
    purchaseBudgetPaise: request.purchase_budget_paise,
    currentDayConfirmedPaise: budgetUsage.confirmedSpendTodayPaise,
    currentActiveReservationsPaise: budgetUsage.activeReservationsPaise,
    nowIso,
  });

  const quoteValiditySeconds = parseInt(process.env.QUOTE_VALIDITY_SECONDS || `${DEFAULT_QUOTE_VALIDITY_SECONDS}`, 10);
  const quoteExpiry = new Date(now.getTime() + quoteValiditySeconds * 1000).toISOString();

  // 5. Build canonical intent payload and compute cryptographic digest
  const canonicalPayload: CanonicalIntentPayload = {
    category: product.category,
    currency: 'INR',
    idempotency_key: request.idempotency_key,
    is_subscription: product.is_subscription,
    merchant_id: product.merchant_id,
    owner_id: ownerId,
    policy_version: policy.version,
    product_id: product.id,
    product_version: product.version,
    purchase_budget_paise: request.purchase_budget_paise,
    quantity: request.quantity,
    quote_expiry: quoteExpiry,
    total_amount_paise: evaluation.totalAmountPaise,
    unit_price_paise: product.unit_price_paise,
  };

  const canonicalRequestHash = computeCanonicalIntentHash(canonicalPayload);

  // 6. Check Idempotency: (owner_id, idempotency_key, payment_adapter_mode)
  const existingRow = db
    .select()
    .from(schema.purchaseIntents)
    .where(
      and(
        eq(schema.purchaseIntents.owner_id, ownerId),
        eq(schema.purchaseIntents.idempotency_key, request.idempotency_key),
        eq(schema.purchaseIntents.payment_adapter_mode, paymentAdapterMode)
      )
    )
    .get();

  if (existingRow) {
    // If exact same request content (product, quantity, budget), return existing intent
    if (
      existingRow.product_id === request.product_id &&
      existingRow.quantity === request.quantity &&
      existingRow.purchase_budget_paise === request.purchase_budget_paise
    ) {
      const existingIntent: PurchaseIntent = {
        id: existingRow.id,
        owner_id: existingRow.owner_id,
        idempotency_key: existingRow.idempotency_key,
        canonical_request_hash: existingRow.canonical_request_hash,
        product_id: existingRow.product_id,
        merchant_id: existingRow.merchant_id,
        quantity: existingRow.quantity,
        unit_price_paise: existingRow.unit_price_paise,
        total_amount_paise: existingRow.total_amount_paise,
        currency: 'INR',
        category: existingRow.category,
        is_subscription: existingRow.is_subscription,
        product_version: existingRow.product_version,
        policy_version: existingRow.policy_version,
        purchase_budget_paise: existingRow.purchase_budget_paise,
        quote_expiry: existingRow.quote_expiry,
        source_mode: existingRow.source_mode as any,
        payment_adapter_mode: existingRow.payment_adapter_mode as any,
        receipt: existingRow.receipt,
        provider_order_id: existingRow.provider_order_id,
        provider_payment_id: existingRow.provider_payment_id,
        model_provider: existingRow.model_provider,
        model_name: existingRow.model_name,
        state: existingRow.state as any,
        failure_reason: existingRow.failure_reason,
        created_at: existingRow.created_at,
        updated_at: existingRow.updated_at,
      };

      return {
        intent: existingIntent,
        evaluation,
        isExisting: true,
      };
    }

    // Same idempotency key but conflicting parameters: reject with 409 Conflict
    throw new ConflictError(
      `Idempotency key '${request.idempotency_key}' already used with different purchase parameters`
    );
  }

  // 7. Determine initial state from policy evaluation
  let initialState: IntentState = IntentStates.READY;
  let failureReason: string | null = null;

  if (evaluation.state === 'BLOCKED') {
    initialState = IntentStates.BLOCKED;
    failureReason = evaluation.blockingReasons.join('; ');
  } else if (evaluation.state === 'NEEDS_APPROVAL') {
    initialState = IntentStates.NEEDS_APPROVAL;
  }

  const intentId = crypto.randomUUID();

  const intentRecord: PurchaseIntent = {
    id: intentId,
    owner_id: ownerId,
    idempotency_key: request.idempotency_key,
    canonical_request_hash: canonicalRequestHash,
    product_id: product.id,
    merchant_id: product.merchant_id,
    quantity: request.quantity,
    unit_price_paise: product.unit_price_paise,
    total_amount_paise: evaluation.totalAmountPaise,
    currency: 'INR',
    category: product.category,
    is_subscription: product.is_subscription,
    product_version: product.version,
    policy_version: policy.version,
    purchase_budget_paise: request.purchase_budget_paise,
    quote_expiry: quoteExpiry,
    source_mode: request.source_mode,
    payment_adapter_mode: paymentAdapterMode,
    model_provider: request.model_provider || null,
    model_name: request.model_name || null,
    receipt: `rcpt_${intentId.replace(/-/g, '').substring(0, 16)}`,
    provider_order_id: null,
    provider_payment_id: null,
    state: initialState,
    failure_reason: failureReason,
    created_at: nowIso,
    updated_at: nowIso,
  };

  db.insert(schema.purchaseIntents).values(intentRecord).run();

  // 8. Log Audit Event
  appendAuditEvent({
    eventType: 'INTENT_PROPOSED',
    intentId,
    operatorId: ownerId,
    policyVersion: policy.version,
    amountPaise: evaluation.totalAmountPaise,
    stateBefore: null,
    stateAfter: initialState,
    payload: {
      canonicalHash: canonicalRequestHash,
      evaluation,
      reason: request.reason,
      faultInjection: request.fault_injection,
    },
    clock,
  });

  return {
    intent: intentRecord,
    evaluation,
    isExisting: false,
  };
}

export function getIntentById(intentId: string, ownerId?: string): PurchaseIntent | null {
  const { db } = getDb();
  let query = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId));
  const row = query.get();
  if (!row) return null;
  if (ownerId && row.owner_id !== ownerId) {
    throw new Error('Unauthorized intent access: ownership mismatch');
  }

  return {
    id: row.id,
    owner_id: row.owner_id,
    idempotency_key: row.idempotency_key,
    canonical_request_hash: row.canonical_request_hash,
    product_id: row.product_id,
    merchant_id: row.merchant_id,
    quantity: row.quantity,
    unit_price_paise: row.unit_price_paise,
    total_amount_paise: row.total_amount_paise,
    currency: 'INR',
    category: row.category,
    is_subscription: row.is_subscription,
    product_version: row.product_version,
    policy_version: row.policy_version,
    purchase_budget_paise: row.purchase_budget_paise,
    quote_expiry: row.quote_expiry,
    source_mode: row.source_mode as any,
    payment_adapter_mode: row.payment_adapter_mode as any,
    receipt: row.receipt,
    provider_order_id: row.provider_order_id,
    provider_payment_id: row.provider_payment_id,
    model_provider: row.model_provider,
    model_name: row.model_name,
    state: row.state as any,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function approveIntent(
  intentId: string,
  operatorId: string,
  notes?: string,
  clock: Clock = defaultClock
): PurchaseIntent {
  const { db } = getDb();
  const intent = getIntentById(intentId, operatorId);
  if (!intent) {
    throw new NotFoundError(`Purchase intent '${intentId}' not found`);
  }

  if (intent.state !== IntentStates.NEEDS_APPROVAL) {
    throw new Error(`Cannot approve intent in state '${intent.state}' (must be 'NEEDS_APPROVAL')`);
  }

  const nowIso = clock.nowIso();
  if (nowIso >= intent.quote_expiry) {
    db.update(schema.purchaseIntents)
      .set({ state: IntentStates.EXPIRED, failure_reason: 'Quote expired before approval', updated_at: nowIso })
      .where(eq(schema.purchaseIntents.id, intentId))
      .run();
    throw new Error(`Quote expired at ${intent.quote_expiry}`);
  }

  // Revalidate that product or policy haven't changed since proposal
  const currentProduct = getProductById(intent.product_id);
  const currentPolicy = getCurrentPolicy();
  if (!currentProduct || currentProduct.version !== intent.product_version) {
    throw new Error('Product price or attributes changed after proposal; approval rejected');
  }
  if (currentPolicy.version !== intent.policy_version) {
    throw new Error('Spending policy changed after proposal; approval rejected');
  }

  assertValidTransition(intent.state, IntentStates.APPROVED);

  // Store exact approval record bound to canonical hash
  const approvalId = crypto.randomUUID();
  db.insert(schema.intentApprovals).values({
    id: approvalId,
    intent_id: intentId,
    operator_id: operatorId,
    canonical_hash: intent.canonical_request_hash,
    status: 'APPROVED',
    notes: notes || null,
    approved_at: nowIso,
  }).run();

  db.update(schema.purchaseIntents)
    .set({ state: IntentStates.APPROVED, updated_at: nowIso })
    .where(eq(schema.purchaseIntents.id, intentId))
    .run();

  appendAuditEvent({
    eventType: 'INTENT_APPROVED',
    intentId,
    operatorId,
    amountPaise: intent.total_amount_paise,
    stateBefore: intent.state,
    stateAfter: IntentStates.APPROVED,
    payload: {
      canonicalHash: intent.canonical_request_hash,
      approvalId,
      notes,
    },
    clock,
  });

  return {
    ...intent,
    state: IntentStates.APPROVED,
    updated_at: nowIso,
  };
}

export function declineIntent(
  intentId: string,
  operatorId: string,
  notes?: string,
  clock: Clock = defaultClock
): PurchaseIntent {
  const { db } = getDb();
  const intent = getIntentById(intentId, operatorId);
  if (!intent) {
    throw new NotFoundError(`Purchase intent '${intentId}' not found`);
  }

  assertValidTransition(intent.state, IntentStates.DECLINED);
  const nowIso = clock.nowIso();

  const approvalId = crypto.randomUUID();
  db.insert(schema.intentApprovals).values({
    id: approvalId,
    intent_id: intentId,
    operator_id: operatorId,
    canonical_hash: intent.canonical_request_hash,
    status: 'DECLINED',
    notes: notes || null,
    approved_at: nowIso,
  }).run();

  db.update(schema.purchaseIntents)
    .set({
      state: IntentStates.DECLINED,
      failure_reason: notes || 'Operator declined purchase proposal',
      updated_at: nowIso,
    })
    .where(eq(schema.purchaseIntents.id, intentId))
    .run();

  appendAuditEvent({
    eventType: 'INTENT_DECLINED',
    intentId,
    operatorId,
    amountPaise: intent.total_amount_paise,
    stateBefore: intent.state,
    stateAfter: IntentStates.DECLINED,
    payload: {
      canonicalHash: intent.canonical_request_hash,
      approvalId,
      notes,
    },
    clock,
  });

  return {
    ...intent,
    state: IntentStates.DECLINED,
    failure_reason: notes || 'Operator declined purchase proposal',
    updated_at: nowIso,
  };
}
