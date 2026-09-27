import crypto from 'node:crypto';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { getDb, schema } from '@/infrastructure/db';
import { resolvePaymentAdapterMode, type PurchaseIntent } from '@/domain/intent';
import { PassportStatus } from '@/domain/passport';
import { getAuthorityConfig } from '@/infrastructure/authority/signing';
import { createCommitment, decryptCommitmentSalt, encryptCommitmentSalt } from '@/infrastructure/shared-authority/commitment';
import { getDrunixSettings, getSharedAuthorityMode } from '@/infrastructure/shared-authority/config';
import { DrunixGatewayClient, DrunixOperationError, type DrunixMandate, type DrunixReservation } from '@/infrastructure/shared-authority/drunix-gateway';
import { getPassportById, verifyStoredPassport } from './passport.service';
import { getCurrentPolicy, getKolkataDayRange } from './policy.service';

export class SharedAuthorityDeniedError extends Error {
  constructor(message: string) { super(message); this.name = 'SharedAuthorityDeniedError'; }
}

export class SharedAuthorityPendingError extends Error {
  readonly transactionId?: string;
  constructor(message: string, transactionId?: string) { super(message); this.name = 'SharedAuthorityPendingError'; this.transactionId = transactionId; }
}

export interface SharedMandateIssueInput {
  passportId: string;
  aggregateCapPaise: number;
  perTransactionCapPaise: number;
  maximumUsageCount: number;
}

export interface SharedDispatchAuthorization {
  mandate: DrunixMandate;
  reservation: DrunixReservation;
  reservationId: string;
  paymentAttemptId: string;
  requestId: string;
  requestCommitment: string;
}

export function requireDrunixMode(): void {
  if (getSharedAuthorityMode() !== 'DRUNIX') throw new Error('This operation requires SHARED_AUTHORITY_MODE=DRUNIX; no ledger fallback is available');
}

export async function issueSharedMandate(ownerId: string, input: SharedMandateIssueInput): Promise<{ mandate: DrunixMandate; transactionId: string; validationCode: string }> {
  requireDrunixMode();
  const settings = getDrunixSettings();
  if (!Number.isSafeInteger(input.aggregateCapPaise) || input.aggregateCapPaise <= 0 || !Number.isSafeInteger(input.perTransactionCapPaise) || input.perTransactionCapPaise <= 0 || !Number.isSafeInteger(input.maximumUsageCount) || input.maximumUsageCount <= 0) {
    throw new Error('Mandate limits must be positive safe integers');
  }
  const passport = getPassportById(input.passportId, ownerId);
  if (!passport) throw new Error('Authority Passport not found');
  if (passport.status !== PassportStatus.ACTIVE) throw new SharedAuthorityDeniedError('Only an active Authority Passport can issue a shared mandate');
  const signedPassport = verifyStoredPassport(passport, ownerId, passport.payload.agentId);
  if (signedPassport.paymentAdapterMode !== resolvePaymentAdapterMode()) throw new SharedAuthorityDeniedError('Passport payment mode does not match the service payment mode');

  const policy = getCurrentPolicy();
  const { db } = getDb();
  const existing = db.select().from(schema.sharedAuthorityMandates).where(eq(schema.sharedAuthorityMandates.mandate_id, settings.mandateId)).get();
  const policyCategories = new Set(policy.allowed_categories);
  const allowedMerchantIds = signedPassport.allowedMerchantIds.filter((value) => value === policy.approved_merchant_id).sort();
  const allowedCategories = signedPassport.allowedCategories.filter((value) => policyCategories.has(value)).sort();
  if (allowedMerchantIds.length === 0 || allowedCategories.length === 0) throw new SharedAuthorityDeniedError('Passport and current policy have no common merchant/category scope');
  if (input.aggregateCapPaise > Math.min(signedPassport.cumulativeBudgetPaise, policy.daily_budget_paise)) throw new SharedAuthorityDeniedError('Shared allowance would exceed the Passport cumulative budget or current server daily budget');
  if (input.perTransactionCapPaise > Math.min(signedPassport.maximumAmountPerTransactionPaise, policy.max_transaction_amount_paise)) throw new SharedAuthorityDeniedError('Per-transaction limit would exceed the Passport or current server policy');
  if (input.perTransactionCapPaise > input.aggregateCapPaise || input.maximumUsageCount > signedPassport.maximumUsageCount) throw new SharedAuthorityDeniedError('Shared mandate limits would exceed the signed Passport');

  // A newly issued shared allowance is carved out of the Passport and daily
  // policy headroom already consumed by this BoundPay database. Existing
  // issuance retries keep their original immutable allocation.
  if (!existing) {
    const activePassportUsages = db.select().from(schema.passportUsages).where(and(
      eq(schema.passportUsages.passport_id, passport.payload.passportId),
      eq(schema.passportUsages.payment_adapter_mode, signedPassport.paymentAdapterMode),
      inArray(schema.passportUsages.usage_status, ['RESERVED', 'COMMITTED', 'CONFIRMED', 'UNKNOWN']),
    )).all();
    const passportUsedPaise = activePassportUsages.reduce((sum, row) => sum + row.amount_paise, 0);
    const passportRemainingPaise = Math.max(0, signedPassport.cumulativeBudgetPaise - passportUsedPaise);
    const passportUsagesRemaining = Math.max(0, signedPassport.maximumUsageCount - activePassportUsages.length);
    if (input.aggregateCapPaise > passportRemainingPaise || input.maximumUsageCount > passportUsagesRemaining) {
      throw new SharedAuthorityDeniedError('Shared allowance would exceed the Authority Passport budget or usage remaining after existing reservations');
    }

    const { startIso, endIso } = getKolkataDayRange(new Date());
    const confirmedToday = db.select().from(schema.spendLedger).where(and(
      eq(schema.spendLedger.status, 'CONFIRMED'),
      gte(schema.spendLedger.confirmation_timestamp, startIso),
      lte(schema.spendLedger.confirmation_timestamp, endIso),
      eq(schema.spendLedger.payment_adapter_mode, signedPassport.paymentAdapterMode),
    )).all();
    const activeSpendReservations = db.select().from(schema.spendLedger).where(and(
      eq(schema.spendLedger.status, 'RESERVED'),
      eq(schema.spendLedger.payment_adapter_mode, signedPassport.paymentAdapterMode),
    )).all();
    const dailyUsedPaise = confirmedToday.reduce((sum, row) => sum + row.amount_paise, 0)
      + activeSpendReservations.reduce((sum, row) => sum + row.amount_paise, 0);
    const dailyRemainingPaise = Math.max(0, policy.daily_budget_paise - dailyUsedPaise);
    if (input.aggregateCapPaise > dailyRemainingPaise) {
      throw new SharedAuthorityDeniedError('Shared allowance would exceed the current deterministic policy daily budget remaining');
    }
  }

  const scopeTerms = { schemaVersion: 1, policyVersion: policy.version, allowedMerchantIds, allowedCategories };
  if (existing && (existing.owner_id !== ownerId || existing.passport_id !== passport.payload.passportId || existing.passport_digest !== passport.payloadDigest || existing.aggregate_cap_paise !== input.aggregateCapPaise || existing.per_transaction_cap_paise !== input.perTransactionCapPaise || existing.maximum_usage_count !== input.maximumUsageCount || existing.policy_version !== policy.version || existing.participant_identities_json !== JSON.stringify(settings.participantIdentities) || existing.verifier_identities_json !== JSON.stringify(settings.verifierIdentities))) {
    throw new SharedAuthorityDeniedError('This local mandate ID is already reserved for different issuance terms');
  }
  const scope = existing
    ? createCommitment('passport-scope', scopeTerms, decryptCommitmentSalt(existing.scope_salt_ciphertext))
    : createCommitment('passport-scope', scopeTerms);
  if (existing && existing.scope_commitment !== scope.digest) throw new SharedAuthorityDeniedError('Stored mandate scope salt does not match its commitment');
  const nowIso = new Date().toISOString();
  if (!existing) {
    db.insert(schema.sharedAuthorityMandates).values({
      mandate_id: settings.mandateId,
      passport_id: passport.payload.passportId,
      owner_id: ownerId,
      passport_digest: passport.payloadDigest,
      aggregate_cap_paise: input.aggregateCapPaise,
      per_transaction_cap_paise: input.perTransactionCapPaise,
      maximum_usage_count: input.maximumUsageCount,
      policy_version: policy.version,
      participant_msps_json: JSON.stringify(settings.participantMsps),
      participant_identities_json: JSON.stringify(settings.participantIdentities),
      verifier_identities_json: JSON.stringify(settings.verifierIdentities),
      lifecycle_status: 'PENDING',
      scope_commitment: scope.digest,
      scope_salt_ciphertext: encryptCommitmentSalt(scope.salt),
      issued_transaction_id: null,
      validation_code: null,
      created_at: nowIso,
    }).onConflictDoNothing().run();
  }
  const scopeProof = Buffer.from(JSON.stringify({ salt: scope.saltBase64Url, payload: scopeTerms }), 'utf8');
  const settingsAndRow = getAuthorityConfig();
  const client = new DrunixGatewayClient();
  try {
    const keyCommit = await client.submit<null>('RegisterPassportIssuerKey', [signedPassport.keyId, settingsAndRow.publicKeyPem]);
    const issue = await client.submit<DrunixMandate>('IssueMandate', [
      settings.mandateId,
      signedPassport.passportId,
      passport.payloadDigest,
      signedPassport.currency,
      String(input.aggregateCapPaise),
      String(input.perTransactionCapPaise),
      String(input.maximumUsageCount),
      scope.digest,
      JSON.stringify(settings.participantIdentities),
      JSON.stringify(settings.verifierIdentities),
    ], {
      'boundpay.passport.v1': Buffer.from(passport.signedToken, 'utf8'),
      'boundpay.scope.v1': scopeProof,
    });
    const mandate = await client.queryMandate(settings.mandateId);
    if (mandate.status !== 'ACTIVE' || mandate.passportId !== signedPassport.passportId || mandate.passportDigest !== passport.payloadDigest || mandate.paymentAdapterMode !== signedPassport.paymentAdapterMode || mandate.aggregateCapPaise !== input.aggregateCapPaise || mandate.perTransactionCapPaise !== input.perTransactionCapPaise || mandate.maximumUsageCount !== input.maximumUsageCount || mandate.scopeCommitment !== scope.digest || JSON.stringify(mandate.participantIdentities) !== JSON.stringify(settings.participantIdentities)) {
      throw new SharedAuthorityPendingError('Mandate transaction committed, but the queried state did not match the requested terms', issue.transactionId);
    }
    db.update(schema.sharedAuthorityMandates).set({ lifecycle_status: 'ACTIVE', issued_transaction_id: issue.transactionId, validation_code: issue.validationCode }).where(eq(schema.sharedAuthorityMandates.mandate_id, settings.mandateId)).run();
    return { mandate, transactionId: issue.transactionId || keyCommit.transactionId, validationCode: issue.validationCode };
  } finally {
    client.close();
  }
}

export async function revokeSharedMandate(ownerId: string, passportId?: string): Promise<{ mandate: DrunixMandate; transactionId: string; validationCode: string }> {
  requireDrunixMode();
  const settings = getDrunixSettings();
  const { db } = getDb();
  const local = db.select().from(schema.sharedAuthorityMandates).where(and(eq(schema.sharedAuthorityMandates.mandate_id, settings.mandateId), eq(schema.sharedAuthorityMandates.owner_id, ownerId))).get();
  if (!local || (passportId && local.passport_id !== passportId)) throw new SharedAuthorityDeniedError('Only the authenticated owner who issued this Passport-bound mandate may revoke it');
  const client = new DrunixGatewayClient();
  try {
    const commit = await client.submit<DrunixMandate>('RevokeFutureAuthority', [settings.mandateId]);
    const mandate = await client.queryMandate(settings.mandateId);
    if (mandate.status !== 'REVOKED') throw new SharedAuthorityPendingError('Revocation commit could not be confirmed by a state query', commit.transactionId);
    db.update(schema.sharedAuthorityMandates).set({ lifecycle_status: 'REVOKED', validation_code: commit.validationCode }).where(eq(schema.sharedAuthorityMandates.mandate_id, settings.mandateId)).run();
    return { mandate, transactionId: commit.transactionId, validationCode: commit.validationCode };
  } finally { client.close(); }
}

export async function revokeSharedMandateForPassport(ownerId: string, passportId: string): Promise<{ revoked: boolean; transactionId?: string }> {
  if (getSharedAuthorityMode() !== 'DRUNIX') return { revoked: false };
  const { db } = getDb();
  const settings = getDrunixSettings();
  const local = db.select().from(schema.sharedAuthorityMandates).where(and(
    eq(schema.sharedAuthorityMandates.mandate_id, settings.mandateId),
    eq(schema.sharedAuthorityMandates.owner_id, ownerId),
    eq(schema.sharedAuthorityMandates.passport_id, passportId),
  )).get();
  if (!local) return { revoked: false };
  const result = await revokeSharedMandate(ownerId, passportId);
  return { revoked: true, transactionId: result.transactionId };
}

export async function querySharedMandate(): Promise<{
  mandate: DrunixMandate;
  reservations: DrunixReservation[];
  paymentOperations: Array<{ intentId: string; reservationId: string; ledgerState: string; paymentState: string; dispatchState: string; reserveTransactionId: string | null; dispatchTransactionId: string | null; outcomeTransactionId: string | null; validationCode: string | null; lastError: string | null }>;
}> {
  requireDrunixMode();
  const settings = getDrunixSettings();
  const { db } = getDb();
  const client = new DrunixGatewayClient();
  try {
    const [mandate, reservations] = await Promise.all([client.queryMandate(settings.mandateId), client.queryReservations(settings.mandateId)]);
    const operations = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.mandate_id, settings.mandateId)).all();
    return {
      mandate,
      reservations,
      paymentOperations: operations.map((operation) => ({
        intentId: operation.intent_id,
        reservationId: operation.reservation_id,
        ledgerState: operation.ledger_state,
        paymentState: operation.payment_state,
        dispatchState: operation.payment_dispatch_state,
        reserveTransactionId: operation.reserve_transaction_id,
        dispatchTransactionId: operation.dispatch_transaction_id,
        outcomeTransactionId: operation.outcome_transaction_id,
        validationCode: operation.validation_code,
        lastError: operation.last_error,
      })),
    };
  } finally { client.close(); }
}

/** Reserve on Drunix, verify commit and queried state, then obtain a one-time committed dispatch claim. */
export async function prepareSharedDispatch(intent: PurchaseIntent): Promise<SharedDispatchAuthorization> {
  requireDrunixMode();
  if (!intent.passport_id || !intent.passport_payload_digest) throw new SharedAuthorityDeniedError('Shared spending requires a Passport-bound intent');
  const settings = getDrunixSettings();
  const passport = getPassportById(intent.passport_id, intent.owner_id);
  if (!passport) throw new SharedAuthorityDeniedError('Authority Passport not found for shared reservation');
  if (passport.status !== PassportStatus.ACTIVE) throw new SharedAuthorityDeniedError('Authority Passport is no longer active');
  if (!intent.agent_id) throw new SharedAuthorityDeniedError('Shared spending requires a Passport-bound agent identity');
  const signedPassport = verifyStoredPassport(passport, intent.owner_id, intent.agent_id || undefined);
  if (passport.payloadDigest !== intent.passport_payload_digest) throw new SharedAuthorityDeniedError('Intent Passport digest no longer matches its signed Authority Passport');
  if (intent.payment_adapter_mode !== signedPassport.paymentAdapterMode) throw new SharedAuthorityDeniedError('Intent payment mode does not match the Authority Passport');

  const requestHash = crypto.createHash('sha256').update(intent.id).digest('hex').slice(0, 32);
  const requestId = `req-${requestHash}`;
  const reservationId = `res-${requestHash}`;
  const paymentAttemptId = `pay-${requestHash}`;
  const proofPayload = {
    schemaVersion: 1,
    requestId,
    paymentAttemptId,
    passportId: intent.passport_id,
    agentId: intent.agent_id,
    amountPaise: intent.total_amount_paise,
    currency: intent.currency,
    paymentAdapterMode: intent.payment_adapter_mode,
    isSubscription: intent.is_subscription,
    merchantId: intent.merchant_id,
    category: intent.category,
    productId: intent.product_id,
    quantity: intent.quantity,
    unitPricePaise: intent.unit_price_paise,
  };
  const { db } = getDb();
  let operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intent.id)).get();
  let proofCommitment: string;
  let salt: Buffer;
  if (operation) {
    if (operation.mandate_id !== settings.mandateId || operation.reservation_id !== reservationId || operation.payment_attempt_id !== paymentAttemptId) {
      throw new SharedAuthorityDeniedError('Existing shared authorization outbox does not match the intent binding');
    }
    salt = decryptCommitmentSalt(operation.purchase_salt_ciphertext);
    proofCommitment = createCommitment('purchase-scope', proofPayload, salt).digest;
    if (proofCommitment !== operation.request_commitment) throw new SharedAuthorityDeniedError('Stored shared authorization commitment does not match the intent');
  } else {
    const generated = createCommitment('purchase-scope', proofPayload);
    proofCommitment = generated.digest;
    salt = generated.salt;
    const now = new Date().toISOString();
    db.insert(schema.sharedAuthorityOperations).values({
      intent_id: intent.id,
      mandate_id: settings.mandateId,
      reservation_id: reservationId,
      payment_attempt_id: paymentAttemptId,
      request_commitment: proofCommitment,
      purchase_salt_ciphertext: encryptCommitmentSalt(salt),
      evidence_salt_ciphertext: null,
      ledger_state: 'RESERVE_PENDING',
      payment_dispatch_state: 'NOT_SENT',
      payment_state: 'NOT_DISPATCHED',
      reserve_transaction_id: null,
      dispatch_transaction_id: null,
      outcome_transaction_id: null,
      outcome_commitment: null,
      validation_code: null,
      last_error: null,
      updated_at: now,
    }).run();
    operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intent.id)).get();
  }
  if (!operation) throw new Error('Shared authorization outbox was not durably created');

  const client = new DrunixGatewayClient();
  try {
    const mandate = await client.queryMandate(settings.mandateId);
    assertMandateMatchesPassport(mandate, intent, passport.payloadDigest);
    const currentPolicy = getCurrentPolicy();
    if (mandate.policyVersion !== currentPolicy.version) {
      throw new SharedAuthorityDeniedError('Shared mandate policy version is stale; revoke it and issue a mandate under the current deterministic policy');
    }
    const proof = Buffer.from(JSON.stringify({ salt: salt.toString('base64url'), payload: proofPayload }), 'utf8');
    let reservation: DrunixReservation;
    if (['RESERVED', 'DISPATCHING', 'UNKNOWN', 'SETTLED', 'RELEASED'].includes(operation.ledger_state)) {
      reservation = await client.queryReservation(reservationId, settings.mandateId);
    } else {
      // The chaincode checks the revoked flag after its idempotency lookup:
      // a pre-revocation reservation can be recovered, but a new one cannot.
      let reserveCommit;
      try {
        reserveCommit = await client.submit<DrunixReservation>('Reserve', [
          settings.mandateId,
          reservationId,
          requestId,
          paymentAttemptId,
          intent.passport_id,
          passport.payloadDigest,
          String(intent.total_amount_paise),
          intent.currency,
          mandate.scopeCommitment,
          proofCommitment,
        ], {
          'boundpay.passport.v1': Buffer.from(passport.signedToken, 'utf8'),
          'boundpay.purchase-proof.v1': proof,
        });
      } catch (error) {
        if (error instanceof DrunixOperationError && !error.uncertain) {
          setOperation(intent.id, { ledger_state: 'RESERVE_REJECTED', validation_code: error.validationCode || null, last_error: safeError(error) });
          throw new SharedAuthorityDeniedError(`Drunix rejected the shared reservation: ${error.message}`);
        }
        setOperation(intent.id, { ledger_state: 'RESERVE_UNKNOWN', last_error: safeError(error) });
        throw new SharedAuthorityPendingError('Drunix did not provide a committed reservation result; payment was not dispatched and the local hold is retained');
      }
      setOperation(intent.id, { ledger_state: 'RESERVE_PENDING', reserve_transaction_id: reserveCommit.transactionId, validation_code: reserveCommit.validationCode, last_error: null });
      try { reservation = await client.queryReservation(reservationId, settings.mandateId); }
      catch (error) {
        setOperation(intent.id, { ledger_state: 'RESERVE_UNKNOWN', last_error: safeError(error) });
        throw new SharedAuthorityPendingError('Drunix commit was successful, but the reservation state query is unavailable; payment was not dispatched', reserveCommit.transactionId);
      }
    }

    verifyReservationMatches(reservation, intent, mandate, reservationId, requestId, paymentAttemptId, proofCommitment);
    if (reservation.status === 'SETTLED' || reservation.status === 'RELEASED') throw new SharedAuthorityDeniedError(`Shared reservation is terminal (${reservation.status}); it cannot authorize another dispatch`);
    const identity = await client.identify();
    if (identity.mspId !== reservation.participantMsp || identity.clientId !== reservation.executorIdentity) {
      throw new SharedAuthorityDeniedError('This service identity is not the executor bound to the shared reservation');
    }

    if (reservation.status === 'RESERVED') {
      try {
        const dispatchCommit = await client.submit<DrunixReservation>('BeginDispatch', [settings.mandateId, reservationId]);
        setOperation(intent.id, { ledger_state: 'DISPATCH_PENDING', dispatch_transaction_id: dispatchCommit.transactionId, validation_code: dispatchCommit.validationCode, last_error: null });
        reservation = await client.queryReservation(reservationId, settings.mandateId);
        if (reservation.status !== 'DISPATCHING' || reservation.dispatchTransactionId !== dispatchCommit.transactionId) {
          setOperation(intent.id, { ledger_state: 'DISPATCH_UNKNOWN', last_error: 'Committed dispatch claim did not match queried reservation state' });
          throw new SharedAuthorityPendingError('Dispatch claim commit could not be confirmed; payment was not dispatched', dispatchCommit.transactionId);
        }
      } catch (error) {
        if (error instanceof SharedAuthorityPendingError) throw error;
        if (error instanceof DrunixOperationError && !error.uncertain) {
          setOperation(intent.id, { ledger_state: 'RESERVED', validation_code: error.validationCode || null, last_error: safeError(error) });
          throw new SharedAuthorityDeniedError(`Drunix refused the one-time dispatch claim: ${error.message}`);
        }
        setOperation(intent.id, { ledger_state: 'DISPATCH_UNKNOWN', last_error: safeError(error) });
        throw new SharedAuthorityPendingError('Dispatch claim status is unknown; payment was not dispatched', error instanceof DrunixOperationError ? error.transactionId : undefined);
      }
    } else if (reservation.status === 'UNKNOWN') {
      throw new SharedAuthorityPendingError('Drunix records an unknown payment outcome; reconcile it before dispatch');
    } else if (reservation.status !== 'DISPATCHING') {
      throw new SharedAuthorityPendingError(`Drunix reservation is ${reservation.status}; no dispatch is authorized`);
    }

    operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intent.id)).get();
    if (!operation) throw new Error('Shared authorization outbox disappeared');
    if (operation.payment_dispatch_state !== 'NOT_SENT') throw new SharedAuthorityPendingError('Provider dispatch may already have started; reconcile before retrying');
    setOperation(intent.id, { ledger_state: 'DISPATCHING', dispatch_transaction_id: reservation.dispatchTransactionId || operation.dispatch_transaction_id, last_error: null });
    return { mandate, reservation, reservationId, paymentAttemptId, requestId, requestCommitment: proofCommitment };
  } finally { client.close(); }
}

/** Durable local marker is committed before the provider call. MAY_HAVE_SENT is never retried after restart. */
export function markSharedProviderRequestStarted(intentId: string): void {
  const { db, sqlite } = getDb();
  sqlite.transaction(() => {
    const operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intentId)).get();
    if (!operation || operation.ledger_state !== 'DISPATCHING' || operation.payment_dispatch_state !== 'NOT_SENT') {
      throw new SharedAuthorityPendingError('Provider dispatch is not authorized by a committed Drunix reservation or was already attempted');
    }
    db.update(schema.sharedAuthorityOperations).set({ payment_dispatch_state: 'MAY_HAVE_SENT', payment_state: 'DISPATCHING', updated_at: new Date().toISOString() }).where(eq(schema.sharedAuthorityOperations.intent_id, intentId)).run();
  }).immediate();
}

export function markSharedProviderOrder(intentId: string): void {
  setOperation(intentId, { payment_state: 'ORDER_CREATED', updated_at: new Date().toISOString(), last_error: null });
}

export async function markSharedPaymentUnknown(intentId: string, reason: string): Promise<void> {
  const { db } = getDb();
  const operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intentId)).get();
  if (!operation) return;
  setOperation(intentId, { ledger_state: 'OUTCOME_UNKNOWN', payment_state: 'UNKNOWN', payment_dispatch_state: 'MAY_HAVE_SENT', last_error: reason.slice(0, 500), updated_at: new Date().toISOString() });
  try {
    const client = new DrunixGatewayClient();
    try {
      const reservation = await client.queryReservation(operation.reservation_id, operation.mandate_id);
      if (reservation.status === 'DISPATCHING') {
        const commit = await client.submit<DrunixReservation>('MarkUnknown', [operation.mandate_id, operation.reservation_id]);
        const confirmed = await client.queryReservation(operation.reservation_id, operation.mandate_id);
        if (confirmed.status === 'UNKNOWN') setOperation(intentId, { ledger_state: 'UNKNOWN', outcome_transaction_id: commit.transactionId, validation_code: commit.validationCode, last_error: reason.slice(0, 500) });
      }
    } finally { client.close(); }
  } catch (error) {
    setOperation(intentId, { ledger_state: 'OUTCOME_UNKNOWN', last_error: `Drunix reconciliation pending: ${safeError(error)}`.slice(0, 500) });
  }
}

export async function recordSharedPaymentOutcome(input: {
  intentId: string;
  outcome: 'SUCCESS' | 'DEFINITIVE_FAILURE';
  providerMode: 'MOCK' | 'RAZORPAY_TEST';
  orderId?: string;
  paymentId?: string;
}): Promise<{ confirmed: boolean; transactionId?: string; message?: string }> {
  const { db } = getDb();
  const operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, input.intentId)).get();
  if (!operation) return { confirmed: getSharedAuthorityMode() !== 'DRUNIX', message: 'No Drunix outbox row is present for this intent' };
  const evidence = {
    schemaVersion: 1,
    evidenceType: input.outcome === 'SUCCESS' ? 'PROVIDER_CAPTURED' : 'PROVIDER_DEFINITIVE_FAILURE',
    providerMode: input.providerMode,
    paymentAttemptId: operation.payment_attempt_id,
    orderReferenceDigest: input.orderId ? crypto.createHash('sha256').update(input.orderId).digest('hex') : null,
  };
  let salt: Buffer;
  let evidenceCommitment: string;
  if (operation.outcome_commitment && operation.evidence_salt_ciphertext) {
    salt = decryptCommitmentSalt(operation.evidence_salt_ciphertext);
    evidenceCommitment = createCommitment('payment-outcome', evidence, salt).digest;
    if (evidenceCommitment !== operation.outcome_commitment) throw new Error('Stored outcome commitment does not match reconciled provider evidence');
  } else {
    const generated = createCommitment('payment-outcome', evidence);
    salt = generated.salt;
    evidenceCommitment = generated.digest;
    setOperation(input.intentId, { evidence_salt_ciphertext: encryptCommitmentSalt(salt), outcome_commitment: evidenceCommitment, payment_state: input.outcome === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED_DEFINITIVE' });
  }
  const client = new DrunixGatewayClient('verifier');
  try {
    const identity = await client.identify();
    const mandate = await client.queryMandate(operation.mandate_id);
    if (!mandate.verifierIdentities.some((verifier) => verifier.mspId === identity.mspId && verifier.clientId === identity.clientId)) {
      throw new SharedAuthorityDeniedError('Configured verifier certificate is not authorized for this mandate');
    }
    const contractMethod = input.outcome === 'SUCCESS' ? 'CommitOutcome' : 'ReleaseDefinitiveFailure';
    const commit = await client.submit<DrunixReservation>(contractMethod, [operation.mandate_id, operation.reservation_id, evidenceCommitment]);
    const reservation = await client.queryReservation(operation.reservation_id, operation.mandate_id);
    const expected = input.outcome === 'SUCCESS' ? 'SETTLED' : 'RELEASED';
    if (reservation.status !== expected || reservation.evidenceCommitment !== evidenceCommitment || !reservation.outcomeTransactionId) {
      setOperation(input.intentId, { ledger_state: 'OUTCOME_UNKNOWN', last_error: 'Outcome commit response and queried reservation did not match' });
      return { confirmed: false, transactionId: commit.transactionId, message: 'Provider result was verified locally; shared ledger outcome still needs reconciliation' };
    }
    setOperation(input.intentId, {
      ledger_state: expected,
      payment_state: input.outcome === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED_DEFINITIVE',
      // An idempotent retry has its own VALID transaction, while the outcome
      // transition was recorded by the original transaction on the ledger.
      outcome_transaction_id: reservation.outcomeTransactionId,
      validation_code: commit.validationCode,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    return { confirmed: true, transactionId: reservation.outcomeTransactionId };
  } catch (error) {
    setOperation(input.intentId, { ledger_state: 'OUTCOME_UNKNOWN', payment_state: input.outcome === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED_DEFINITIVE', last_error: safeError(error), updated_at: new Date().toISOString() });
    return { confirmed: false, transactionId: error instanceof DrunixOperationError ? error.transactionId : undefined, message: 'Provider result is locally verified; Drunix outcome commit is pending' };
  } finally { client.close(); }
}

export async function querySharedOperation(intentId: string): Promise<{ operation: typeof schema.sharedAuthorityOperations.$inferSelect | null; reservation: DrunixReservation | null }> {
  requireDrunixMode();
  const { db } = getDb();
  const operation = db.select().from(schema.sharedAuthorityOperations).where(eq(schema.sharedAuthorityOperations.intent_id, intentId)).get() || null;
  if (!operation) return { operation: null, reservation: null };
  const client = new DrunixGatewayClient();
  try {
    const reservation = await client.queryReservation(operation.reservation_id, operation.mandate_id);
    return { operation, reservation };
  } finally { client.close(); }
}

function assertMandateMatchesPassport(mandate: DrunixMandate, intent: PurchaseIntent, passportDigest: string): void {
  if (mandate.passportId !== intent.passport_id || mandate.passportDigest !== passportDigest) throw new SharedAuthorityDeniedError('Shared mandate is bound to a different Authority Passport');
  if (intent.currency !== mandate.currency || intent.total_amount_paise > mandate.perTransactionCapPaise || intent.payment_adapter_mode !== mandate.paymentAdapterMode) throw new SharedAuthorityDeniedError('Shared mandate does not authorize this payment mode, transaction amount, or currency');
}

function verifyReservationMatches(reservation: DrunixReservation, intent: PurchaseIntent, mandate: DrunixMandate, reservationId: string, requestId: string, paymentAttemptId: string, proofCommitment: string): void {
  if (reservation.mandateId !== mandate.mandateId || reservation.reservationId !== reservationId || reservation.requestId !== requestId || reservation.paymentAttemptId !== paymentAttemptId || reservation.passportId !== intent.passport_id || reservation.passportDigest !== intent.passport_payload_digest || reservation.amountPaise !== intent.total_amount_paise || reservation.currency !== intent.currency || reservation.paymentAdapterMode !== intent.payment_adapter_mode || reservation.scopeCommitment !== mandate.scopeCommitment || reservation.requestCommitment !== proofCommitment) {
    throw new SharedAuthorityDeniedError('Queried Drunix reservation does not match the local intent and commitment');
  }
}

function setOperation(intentId: string, patch: Partial<typeof schema.sharedAuthorityOperations.$inferInsert>): void {
  const { db } = getDb();
  db.update(schema.sharedAuthorityOperations).set({ ...patch, updated_at: patch.updated_at || new Date().toISOString() }).where(eq(schema.sharedAuthorityOperations.intent_id, intentId)).run();
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown error').slice(0, 500);
}
