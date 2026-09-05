import crypto from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/infrastructure/db';
import { Clock, defaultClock } from '@/infrastructure/clock/clock';
import { getCurrentPolicy } from '@/services/policy.service';
import { getProductById, listProducts } from '@/services/catalog.service';
import { Product } from '@/domain/catalog';
import { PolicyEvaluation, SpendingPolicy } from '@/domain/policy';
import { calculateTotalPaise } from '@/domain/money';
import {
  AuthorityPassport,
  AuthorityPassportSchema,
  AuthorizationDebugCheck,
  DecisionReceiptPayload,
  DecisionReceiptSchema,
  PassportAuthorizationEvaluation,
  PassportConsumption,
  PassportDecision,
  PassportStatus,
  PassportUsageStatus,
  digestPassportPayload,
  statusForPassport,
} from '@/domain/passport';
import {
  AuthorityConfigurationError,
  AuthorityVerificationError,
  getAuthorityConfig,
  publicKeyFingerprintForKeyId,
  signDecisionReceiptSync,
  signPassportSync,
  verifyDecisionReceiptSync,
  verifyPassportSignatureSync,
  verifyPassportSync,
} from '@/infrastructure/authority/signing';
import { appendAuditEvent } from './audit.service';
import { PurchaseIntent, resolvePaymentAdapterMode } from '@/domain/intent';

export class PassportNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'PassportNotFoundError'; }
}

export class PassportValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'PassportValidationError'; }
}

export class PassportRevokedError extends Error {
  constructor(message: string) { super(message); this.name = 'PassportRevokedError'; }
}

const safeIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const canonicalUtc = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value === new Date(parsed).toISOString();
}, 'Timestamp must be canonical UTC ISO-8601');

export const CreatePassportSchema = z.object({
  agentId: safeIdentifier,
  agentDisplayName: z.string().trim().min(1).max(128),
  allowedMerchantIds: z.array(safeIdentifier).min(1).max(128),
  allowedCategories: z.array(safeIdentifier).min(1).max(128),
  maximumAmountPerTransactionPaise: z.number().int().safe().positive(),
  cumulativeBudgetPaise: z.number().int().safe().positive(),
  approvalRequiredAbovePaise: z.number().int().safe().nonnegative(),
  validFrom: canonicalUtc.optional(),
  expiresAt: canonicalUtc,
  maximumUsageCount: z.number().int().safe().min(1).max(100000),
  idempotencyKey: safeIdentifier.optional(),
}).strict();
export type CreatePassportInput = z.infer<typeof CreatePassportSchema>;

export interface StoredPassport {
  payload: AuthorityPassport;
  payloadDigest: string;
  signedToken: string;
  /** Database copy of the nonce is bound to the immutable signed payload. */
  revocationNonce: string;
  status: PassportStatus;
  revokedAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  consumption: PassportConsumption;
}

export interface DecisionReceiptRecord {
  id: string;
  intentId: string;
  decision: PassportDecision;
  payload: DecisionReceiptPayload;
  signedToken: string;
  issuedAt: string;
  keyId: string;
}

const CONSUMING_USAGE_STATUSES = [
  PassportUsageStatus.RESERVED,
  PassportUsageStatus.COMMITTED,
  PassportUsageStatus.CONFIRMED,
  PassportUsageStatus.UNKNOWN,
] as const;

function safePaiseAdd(left: number, right: number, field = 'paise total'): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new PassportValidationError(`${field} exceeds the safe integer paise range`);
  }
  return left + right;
}

function rowToPassport(row: typeof schema.authorityPassports.$inferSelect, nowIso = new Date().toISOString()): StoredPassport {
  if (![PassportStatus.ACTIVE, PassportStatus.REVOKED, PassportStatus.EXPIRED].includes(row.status as PassportStatus)) {
    throw new PassportValidationError('Stored authority passport lifecycle status is invalid');
  }
  let payload: AuthorityPassport;
  try {
    payload = AuthorityPassportSchema.parse(JSON.parse(row.payload_json));
  } catch {
    throw new PassportValidationError('Stored authority passport payload is invalid');
  }
  const status = statusForPassport({ status: row.status as PassportStatus, revokedAt: row.revoked_at, expiresAt: payload.expiresAt }, nowIso);
  return {
    payload,
    payloadDigest: row.payload_digest,
    signedToken: row.signed_token,
    revocationNonce: row.revocation_nonce,
    status,
    revokedAt: row.revoked_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    consumption: getPassportConsumption(row.id, undefined),
  };
}

function validateCatalogAllowLists(input: CreatePassportInput): void {
  const products = listProducts().filter((product) => product.is_active);
  const knownMerchants = new Set(products.map((product) => product.merchant_id));
  const knownCategories = new Set(products.map((product) => product.category));
  if (input.allowedMerchantIds.some((merchant) => !knownMerchants.has(merchant))) {
    throw new PassportValidationError('Passport contains an unknown merchant; access is fail-closed');
  }
  if (input.allowedCategories.some((category) => !knownCategories.has(category))) {
    throw new PassportValidationError('Passport contains an unknown category; access is fail-closed');
  }
  if (new Set(input.allowedMerchantIds).size !== input.allowedMerchantIds.length || new Set(input.allowedCategories).size !== input.allowedCategories.length) {
    throw new PassportValidationError('Passport allowlists must not contain duplicates');
  }
}

function passportConstraintsMatch(payload: AuthorityPassport, input: CreatePassportInput, paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST'): boolean {
  return payload.agentId === input.agentId
    && payload.agentDisplayName === input.agentDisplayName
    && payload.paymentAdapterMode === paymentAdapterMode
    && JSON.stringify(payload.allowedMerchantIds) === JSON.stringify(input.allowedMerchantIds)
    && JSON.stringify(payload.allowedCategories) === JSON.stringify(input.allowedCategories)
    && payload.maximumAmountPerTransactionPaise === input.maximumAmountPerTransactionPaise
    && payload.cumulativeBudgetPaise === input.cumulativeBudgetPaise
    && payload.approvalRequiredAbovePaise === input.approvalRequiredAbovePaise
    && payload.expiresAt === input.expiresAt
    && (!input.validFrom || payload.validFrom === input.validFrom)
    && payload.maximumUsageCount === input.maximumUsageCount;
}

export function createAuthorityPassport(ownerId: string, rawInput: CreatePassportInput, clock: Clock = defaultClock, requestedPaymentAdapterMode?: 'MOCK' | 'RAZORPAY_TEST'): StoredPassport {
  const input = CreatePassportSchema.parse(rawInput);
  validateCatalogAllowLists(input);
  const { db } = getDb();
  if (!db.select({ id: schema.operators.id }).from(schema.operators).where(eq(schema.operators.id, ownerId)).get()) {
    throw new PassportNotFoundError('Authenticated operator not found');
  }
  if (input.approvalRequiredAbovePaise > input.maximumAmountPerTransactionPaise) throw new PassportValidationError('Approval threshold cannot exceed per-transaction maximum');
  if (input.maximumAmountPerTransactionPaise > input.cumulativeBudgetPaise) throw new PassportValidationError('Cumulative budget cannot be below per-transaction maximum');
  const nowIso = clock.nowIso();
  const paymentAdapterMode = requestedPaymentAdapterMode || resolvePaymentAdapterMode();
  const validFrom = input.validFrom || nowIso;
  if (Date.parse(validFrom) >= Date.parse(input.expiresAt)) throw new PassportValidationError('expiresAt must be after validFrom');

  if (input.idempotencyKey) {
    const existing = db.select().from(schema.authorityPassports).where(and(eq(schema.authorityPassports.owner_id, ownerId), eq(schema.authorityPassports.idempotency_key, input.idempotencyKey))).get();
    if (existing) {
      const existingPassport = rowToPassport(existing, nowIso);
      if (!passportConstraintsMatch(existingPassport.payload, input, paymentAdapterMode)) throw new PassportValidationError('Passport idempotency key was already used with different constraints');
      return existingPassport;
    }
  }

  const config = getAuthorityConfig({ requirePrivate: true });
  const policy = getCurrentPolicy();
  const passportId = `pass_${crypto.randomUUID()}`;
  const payload: AuthorityPassport = AuthorityPassportSchema.parse({
    schemaVersion: 1,
    passportId,
    issuer: config.issuer,
    audience: config.audience,
    operatorId: ownerId,
    ownerId,
    agentId: input.agentId,
    agentDisplayName: input.agentDisplayName,
    currency: 'INR',
    paymentAdapterMode,
    allowedMerchantIds: input.allowedMerchantIds,
    allowedCategories: input.allowedCategories,
    maximumAmountPerTransactionPaise: input.maximumAmountPerTransactionPaise,
    cumulativeBudgetPaise: input.cumulativeBudgetPaise,
    approvalRequiredAbovePaise: input.approvalRequiredAbovePaise,
    validFrom,
    expiresAt: input.expiresAt,
    maximumUsageCount: input.maximumUsageCount,
    policyVersion: policy.version,
    revocationNonce: crypto.randomBytes(32).toString('hex'),
    issuedAt: nowIso,
    keyId: config.keyId,
  });
  const payloadDigest = digestPassportPayload(payload);
  const signedToken = signPassportSync(payload as unknown as Record<string, unknown>);
  try {
    db.insert(schema.authorityPassports).values({
      id: passportId,
      owner_id: ownerId,
      agent_id: payload.agentId,
      issuer: payload.issuer,
      audience: payload.audience,
      policy_version: payload.policyVersion,
      payload_json: JSON.stringify(payload),
      payload_digest: payloadDigest,
      signed_token: signedToken,
      key_id: payload.keyId,
      status: PassportStatus.ACTIVE,
      valid_from: payload.validFrom,
      expires_at: payload.expiresAt,
      revocation_nonce: payload.revocationNonce,
      revoked_at: null,
      idempotency_key: input.idempotencyKey || null,
      created_at: nowIso,
    }).run();
  } catch (error) {
    // Two authenticated retries can race before either sees the idempotency
    // row.  Let SQLite's unique constraint elect the winner, then return that
    // exact immutable passport when the request is equivalent.
    if (input.idempotencyKey && error instanceof Error && /unique constraint/i.test(error.message)) {
      const winner = db.select().from(schema.authorityPassports).where(and(eq(schema.authorityPassports.owner_id, ownerId), eq(schema.authorityPassports.idempotency_key, input.idempotencyKey))).get();
      if (winner) {
        const winnerPassport = rowToPassport(winner, nowIso);
        if (!passportConstraintsMatch(winnerPassport.payload, input, paymentAdapterMode)) throw new PassportValidationError('Passport idempotency key was already used with different constraints');
        return winnerPassport;
      }
    }
    throw error;
  }
  appendAuditEvent({
    eventType: 'PASSPORT_ISSUED',
    operatorId: ownerId,
    policyVersion: policy.version,
    payload: {
      passportId,
      payloadDigest,
      agentId: payload.agentId,
      keyId: payload.keyId,
      validFrom: payload.validFrom,
      expiresAt: payload.expiresAt,
    },
    clock,
  });
  return {
    payload,
    payloadDigest,
    signedToken,
    revocationNonce: payload.revocationNonce,
    status: PassportStatus.ACTIVE,
    revokedAt: null,
    idempotencyKey: input.idempotencyKey || null,
    createdAt: nowIso,
    consumption: emptyConsumption(payload),
  };
}

export function getPassportConsumption(passportId: string, paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST' | undefined): PassportConsumption {
  const { db } = getDb();
  const conditions = [eq(schema.passportUsages.passport_id, passportId), inArray(schema.passportUsages.usage_status, [...CONSUMING_USAGE_STATUSES])];
  if (paymentAdapterMode) conditions.push(eq(schema.passportUsages.payment_adapter_mode, paymentAdapterMode));
  const rows = db.select().from(schema.passportUsages).where(and(...conditions)).all();
  const sumRows = (matchingRows: typeof rows, field: string) => matchingRows.reduce((sum, row) => safePaiseAdd(sum, row.amount_paise, field), 0);
  const total = sumRows(rows, 'Passport commitment total');
  const confirmed = sumRows(rows.filter((row) => row.usage_status === PassportUsageStatus.CONFIRMED), 'Passport confirmed total');
  const committed = sumRows(rows.filter((row) => row.usage_status === PassportUsageStatus.COMMITTED), 'Passport committed total');
  const outstanding = sumRows(rows.filter((row) => row.usage_status === PassportUsageStatus.RESERVED || row.usage_status === PassportUsageStatus.UNKNOWN), 'Passport outstanding total');
  return { confirmedPaise: confirmed, committedPaise: committed, outstandingPaise: outstanding, totalCommittedPaise: total, usedCount: rows.length, remainingBudgetPaise: 0, remainingUsageCount: 0 };
}

function emptyConsumption(payload: AuthorityPassport): PassportConsumption {
  return {
    confirmedPaise: 0,
    committedPaise: 0,
    outstandingPaise: 0,
    totalCommittedPaise: 0,
    usedCount: 0,
    remainingBudgetPaise: payload.cumulativeBudgetPaise,
    remainingUsageCount: payload.maximumUsageCount,
  };
}

export function getPassportById(passportId: string, ownerId?: string, nowIso = new Date().toISOString()): StoredPassport | null {
  const { db } = getDb();
  const row = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, passportId)).get();
  if (!row) return null;
  if (ownerId && row.owner_id !== ownerId) throw new PassportNotFoundError('Authority passport not found');
  const stored = rowToPassport(row, nowIso);
  // Expiry is derived from the signed UTC window, then durably materialized
  // when observed. Revoked rows are never deleted or rewritten to active.
  if (stored.status === PassportStatus.EXPIRED && row.status === PassportStatus.ACTIVE) {
    db.update(schema.authorityPassports).set({ status: PassportStatus.EXPIRED }).where(and(eq(schema.authorityPassports.id, passportId), eq(schema.authorityPassports.status, PassportStatus.ACTIVE))).run();
  }
  const consumption = getPassportConsumption(passportId, undefined);
  stored.consumption = {
    ...consumption,
    remainingBudgetPaise: Math.max(0, stored.payload.cumulativeBudgetPaise - consumption.totalCommittedPaise),
    remainingUsageCount: Math.max(0, stored.payload.maximumUsageCount - consumption.usedCount),
  };
  return stored;
}

export function listOwnedPassports(ownerId: string, nowIso = new Date().toISOString()): StoredPassport[] {
  const { db } = getDb();
  return db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.owner_id, ownerId)).orderBy(desc(schema.authorityPassports.created_at)).all().map((row) => getPassportById(row.id, ownerId, nowIso)!).filter(Boolean);
}

export function findDefaultPassport(ownerId: string, nowIso = new Date().toISOString(), requestedPaymentAdapterMode?: 'MOCK' | 'RAZORPAY_TEST'): StoredPassport | null {
  const passports = listOwnedPassports(ownerId, nowIso);
  const paymentAdapterMode = requestedPaymentAdapterMode || resolvePaymentAdapterMode();
  return passports.find((passport) => passport.status === PassportStatus.ACTIVE && passport.payload.agentId === 'officebot' && passport.payload.paymentAdapterMode === paymentAdapterMode)
    || passports.find((passport) => passport.status === PassportStatus.ACTIVE && passport.payload.paymentAdapterMode === paymentAdapterMode)
    || null;
}

export function ensureDefaultPassport(ownerId: string, clock: Clock = defaultClock, requestedPaymentAdapterMode?: 'MOCK' | 'RAZORPAY_TEST'): StoredPassport {
  const nowIso = clock.nowIso();
  const paymentAdapterMode = requestedPaymentAdapterMode || resolvePaymentAdapterMode();
  const existing = findDefaultPassport(ownerId, nowIso, paymentAdapterMode);
  if (existing) return existing;
  try {
    return createAuthorityPassport(ownerId, {
      agentId: 'officebot',
      agentDisplayName: 'OfficeBot',
      allowedMerchantIds: ['demo_store'],
      allowedCategories: ['electronics', 'books'],
      maximumAmountPerTransactionPaise: 400000,
      cumulativeBudgetPaise: 1500000,
      approvalRequiredAbovePaise: 300000,
      validFrom: '2000-01-01T00:00:00.000Z',
      // A fixed explicit demo expiry keeps legacy Phase 3 callers deterministic
      // even when they evaluate with a TestClock that is not today's wall clock.
      expiresAt: '2099-01-01T00:00:00.000Z',
      maximumUsageCount: 10,
      idempotencyKey: `seed-officebot-v1-${paymentAdapterMode.toLowerCase()}`,
    }, clock, paymentAdapterMode);
  } catch (error) {
    if (error instanceof AuthorityConfigurationError && process.env.NODE_ENV !== 'test' && process.env.AUTHORITY_TEST_MODE !== 'true') {
      throw new AuthorityConfigurationError('Configure authority signing keys before issuing a passport');
    }
    throw error;
  }
}

export function revokePassport(passportId: string, ownerId: string, clock: Clock = defaultClock): StoredPassport {
  const nowIso = clock.nowIso();
  const passport = getPassportById(passportId, ownerId, nowIso);
  if (!passport) throw new PassportNotFoundError('Authority passport not found');
  if (passport.status === PassportStatus.REVOKED) return passport;
  const { db } = getDb();
  db.update(schema.authorityPassports).set({ status: PassportStatus.REVOKED, revoked_at: nowIso }).where(and(eq(schema.authorityPassports.id, passportId), eq(schema.authorityPassports.owner_id, ownerId))).run();
  appendAuditEvent({ eventType: 'PASSPORT_REVOKED', operatorId: ownerId, payload: { passportId, revocationNonce: passport.payload.revocationNonce }, clock });
  return getPassportById(passportId, ownerId, nowIso)!;
}

export function verifyStoredPassport(passport: StoredPassport, ownerId: string, agentId?: string, nowIso = new Date().toISOString()): AuthorityPassport {
  let verified: AuthorityPassport;
  try {
    // The authorization clock may intentionally be a deterministic fixture
    // clock (and can therefore lag the wall clock used when the seed row was
    // issued).  Never let that test-only skew weaken the future-issuance
    // check: use the later of the trusted evaluation instant and wall clock
    // for the signature freshness check.  The signed validFrom/expiresAt
    // window is still evaluated against `nowIso` by the composer/claim path.
    const evaluationNow = Date.parse(nowIso);
    const freshnessNow = Math.max(Number.isFinite(evaluationNow) ? evaluationNow : 0, Date.now());
    verified = verifyPassportSignatureSync(passport.signedToken, freshnessNow);
  } catch (error) { throw new AuthorityVerificationError(error instanceof Error ? error.message : 'Passport signature verification failed'); }
  if (verified.passportId !== passport.payload.passportId || digestPassportPayload(verified) !== passport.payloadDigest || digestPassportPayload(passport.payload) !== passport.payloadDigest || verified.revocationNonce !== passport.revocationNonce || verified.operatorId !== ownerId || verified.ownerId !== ownerId) throw new AuthorityVerificationError('Stored passport binding or payload digest mismatch');
  if (agentId && verified.agentId !== agentId) throw new AuthorityVerificationError('Agent identity does not match passport audience binding');
  return verified;
}

function pushCheck(checks: AuthorizationDebugCheck[], check: AuthorizationDebugCheck): void { checks.push(check); }

export interface ComposePassportAuthorizationInput {
  passport: StoredPassport;
  ownerId: string;
  agentId: string;
  product: Product;
  quantity: number;
  policy: SpendingPolicy;
  policyEvaluation: PolicyEvaluation;
  currentServerBudgetPaise: number;
  paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST';
  nowIso: string;
  signatureValid: boolean;
}

export function composePassportAuthorization(input: ComposePassportAuthorizationInput): PassportAuthorizationEvaluation {
  const { passport, product, quantity, policy, policyEvaluation, nowIso } = input;
  const payload = passport.payload;
  const consumption = getPassportConsumption(payload.passportId, input.paymentAdapterMode);
  const total = calculateTotalPaise(product.unit_price_paise, quantity);
  const projectedPassportSpend = safePaiseAdd(consumption.totalCommittedPaise, total, 'Projected passport commitment');
  const checks: AuthorizationDebugCheck[] = [];
  const blockingReasons: string[] = [];
  const approvalReasons: string[] = [];
  const currentStatus = statusForPassport({ status: passport.status, revokedAt: passport.revokedAt, expiresAt: payload.expiresAt }, nowIso);

  pushCheck(checks, { id: 'passport-signature', status: input.signatureValid ? 'PASS' : 'FAIL', reasonCode: input.signatureValid ? 'PASSPORT_SIGNATURE_VALID' : 'PASSPORT_SIGNATURE_INVALID', explanation: input.signatureValid ? 'Ed25519 signature is valid under the configured BoundPay key registry.' : 'The passport signature could not be verified; authority is rejected.', source: 'SIGNED_PASSPORT', actual: input.signatureValid, required: true });
  if (!input.signatureValid) blockingReasons.push('Signed passport verification failed');
  const statusPass = currentStatus === PassportStatus.ACTIVE && Date.parse(nowIso) >= Date.parse(payload.validFrom);
  const statusCode = currentStatus === PassportStatus.REVOKED ? 'PASSPORT_REVOKED' : currentStatus === PassportStatus.EXPIRED ? 'PASSPORT_EXPIRED' : Date.parse(nowIso) < Date.parse(payload.validFrom) ? 'PASSPORT_NOT_YET_VALID' : 'PASSPORT_ACTIVE';
  pushCheck(checks, { id: 'passport-status', status: statusPass ? 'PASS' : 'FAIL', reasonCode: statusCode, explanation: statusPass ? `Passport is active until ${payload.expiresAt}.` : currentStatus === PassportStatus.REVOKED ? 'Passport was durably revoked and cannot authorize future execution.' : Date.parse(nowIso) < Date.parse(payload.validFrom) ? `Passport becomes valid at ${payload.validFrom}.` : `Passport expired at ${payload.expiresAt}.`, source: 'SIGNED_PASSPORT', actual: currentStatus, required: PassportStatus.ACTIVE });
  if (!statusPass) blockingReasons.push(statusCode === 'PASSPORT_REVOKED' ? 'Passport has been revoked' : statusCode === 'PASSPORT_EXPIRED' ? 'Passport has expired' : 'Passport is not yet valid');
  const ownerPass = payload.operatorId === input.ownerId && payload.ownerId === input.ownerId;
  pushCheck(checks, { id: 'owner-binding', status: ownerPass ? 'PASS' : 'FAIL', reasonCode: ownerPass ? 'PASSPORT_OWNER_MATCH' : 'PASSPORT_OWNER_MISMATCH', explanation: ownerPass ? 'Authenticated operator matches the signed owner binding.' : 'Authenticated operator does not match the signed owner binding.', source: 'AUTHENTICATED_OPERATOR', actual: input.ownerId, required: payload.ownerId });
  if (!ownerPass) blockingReasons.push('Passport owner binding mismatch');
  const agentPass = payload.agentId === input.agentId;
  pushCheck(checks, { id: 'agent-binding', status: agentPass ? 'PASS' : 'FAIL', reasonCode: agentPass ? 'PASSPORT_AGENT_MATCH' : 'PASSPORT_AGENT_MISMATCH', explanation: agentPass ? `Agent '${input.agentId}' is the signed passport subject.` : 'The requested agent does not match the signed passport subject.', source: 'SIGNED_PASSPORT', actual: input.agentId, required: payload.agentId });
  if (!agentPass) blockingReasons.push('Passport agent binding mismatch');
  const modePass = payload.paymentAdapterMode === input.paymentAdapterMode;
  pushCheck(checks, { id: 'payment-mode-binding', status: modePass ? 'PASS' : 'FAIL', reasonCode: modePass ? 'PASSPORT_PAYMENT_MODE_MATCH' : 'PASSPORT_PAYMENT_MODE_MISMATCH', explanation: modePass ? `Passport is bound to the ${input.paymentAdapterMode} adapter namespace.` : `Passport was issued for ${payload.paymentAdapterMode} and cannot authorize ${input.paymentAdapterMode}.`, source: 'SIGNED_PASSPORT', actual: input.paymentAdapterMode, required: payload.paymentAdapterMode });
  if (!modePass) blockingReasons.push('Passport payment adapter namespace mismatch');

  const merchantPass = payload.allowedMerchantIds.includes(product.merchant_id) && product.merchant_id === policy.approved_merchant_id;
  pushCheck(checks, { id: 'merchant', status: merchantPass ? 'PASS' : 'FAIL', reasonCode: merchantPass ? 'MERCHANT_INTERSECTION_ALLOWED' : 'MERCHANT_INTERSECTION_DENIED', explanation: merchantPass ? `Merchant '${product.merchant_id}' is allowed by both passport and current policy.` : 'Merchant must be allowed by both the passport and current server policy.', source: 'TRUSTED_CATALOG', actual: product.merchant_id, required: { passport: payload.allowedMerchantIds, policy: policy.approved_merchant_id } });
  if (!merchantPass) blockingReasons.push(`Merchant '${product.merchant_id}' is not allowed by the effective policy`);
  const categoryPass = payload.allowedCategories.includes(product.category) && policy.allowed_categories.includes(product.category);
  pushCheck(checks, { id: 'category', status: categoryPass ? 'PASS' : 'FAIL', reasonCode: categoryPass ? 'CATEGORY_INTERSECTION_ALLOWED' : 'CATEGORY_INTERSECTION_DENIED', explanation: categoryPass ? `Category '${product.category}' is allowed by both authority layers.` : 'Category must be allowed by both the passport and current server policy.', source: 'TRUSTED_CATALOG', actual: product.category, required: { passport: payload.allowedCategories, policy: policy.allowed_categories } });
  if (!categoryPass) blockingReasons.push(`Category '${product.category}' is not allowed by the effective policy`);
  const subscriptionPass = !product.is_subscription || policy.allow_subscriptions;
  pushCheck(checks, { id: 'subscription', status: subscriptionPass ? 'PASS' : 'FAIL', reasonCode: subscriptionPass ? 'SUBSCRIPTION_POLICY_ALLOWED' : 'SUBSCRIPTION_POLICY_DENIED', explanation: subscriptionPass ? 'Product is not a subscription or the current server policy permits subscriptions.' : 'Current server policy prohibits subscriptions; a passport cannot widen it.', source: 'CURRENT_SERVER_POLICY', actual: product.is_subscription, required: policy.allow_subscriptions });
  if (!subscriptionPass) blockingReasons.push('Subscriptions are prohibited by current server policy');
  const txLimit = Math.min(policy.max_transaction_amount_paise, payload.maximumAmountPerTransactionPaise);
  const txPass = total <= txLimit;
  pushCheck(checks, { id: 'transaction-limit', status: txPass ? 'PASS' : 'FAIL', reasonCode: txPass ? 'TRANSACTION_LIMIT_INTERSECTION_ALLOWED' : 'TRANSACTION_LIMIT_EXCEEDED', explanation: txPass ? `Total ${total} paise is within the stricter ${txLimit}-paise effective limit.` : `Total ${total} paise exceeds the effective ${txLimit}-paise limit.`, source: 'SIGNED_PASSPORT', actual: total, required: txLimit });
  if (!txPass) blockingReasons.push('Transaction exceeds effective passport/server limit');
  const cumulativePass = projectedPassportSpend <= payload.cumulativeBudgetPaise;
  pushCheck(checks, { id: 'passport-budget', status: cumulativePass ? 'PASS' : 'FAIL', reasonCode: cumulativePass ? 'PASSPORT_CUMULATIVE_BUDGET_AVAILABLE' : 'PASSPORT_CUMULATIVE_BUDGET_EXCEEDED', explanation: cumulativePass ? `Projected passport commitments ${projectedPassportSpend} paise remain within the cumulative budget.` : `Projected passport commitments ${projectedPassportSpend} paise exceed the cumulative budget.`, source: 'LEDGER', actual: projectedPassportSpend, required: payload.cumulativeBudgetPaise });
  if (!cumulativePass) blockingReasons.push('Passport cumulative budget exceeded');
  const usagePass = consumption.usedCount < payload.maximumUsageCount;
  pushCheck(checks, { id: 'passport-usage', status: usagePass ? 'PASS' : 'FAIL', reasonCode: usagePass ? 'PASSPORT_USAGE_AVAILABLE' : 'PASSPORT_USAGE_EXHAUSTED', explanation: usagePass ? `${payload.maximumUsageCount - consumption.usedCount} passport usage(s) remain.` : 'Maximum passport usage count has been reached.', source: 'LEDGER', actual: consumption.usedCount, required: payload.maximumUsageCount });
  if (!usagePass) blockingReasons.push('Passport usage count exhausted');
  const projectedServerSpend = safePaiseAdd(input.currentServerBudgetPaise, total, 'Projected server commitment');
  const serverBudgetPass = projectedServerSpend <= policy.daily_budget_paise;
  pushCheck(checks, { id: 'server-budget', status: serverBudgetPass ? 'PASS' : 'FAIL', reasonCode: serverBudgetPass ? 'SERVER_BUDGET_AVAILABLE' : 'SERVER_BUDGET_EXCEEDED', explanation: serverBudgetPass ? 'Current server budget has room after existing confirmed and reserved spend.' : 'Current server budget does not have room; passport cannot expand it.', source: 'LEDGER', actual: projectedServerSpend, required: policy.daily_budget_paise });
  if (!serverBudgetPass) blockingReasons.push('Current server daily budget exceeded');
  const passportApproval = total > payload.approvalRequiredAbovePaise;
  const policyApproval = policyEvaluation.state === 'NEEDS_APPROVAL';
  const approvalRequired = passportApproval || policyApproval;
  pushCheck(checks, { id: 'approval', status: approvalRequired ? 'REQUIRES_ACTION' : 'PASS', reasonCode: approvalRequired ? (passportApproval ? 'PASSPORT_APPROVAL_REQUIRED' : 'SERVER_APPROVAL_REQUIRED') : 'APPROVAL_NOT_REQUIRED', explanation: approvalRequired ? 'Human approval is required because at least one effective authority layer requires it.' : 'Amount is below both approval thresholds.', source: approvalRequired && passportApproval ? 'SIGNED_PASSPORT' : 'CURRENT_SERVER_POLICY', actual: total, required: { passport: payload.approvalRequiredAbovePaise, policy: policy.approval_threshold_paise } });
  if (approvalRequired) approvalReasons.push(passportApproval ? `Passport requires approval above ${payload.approvalRequiredAbovePaise} paise` : `Server policy requires approval above ${policy.approval_threshold_paise} paise`);
  for (const check of policyEvaluation.checks) {
    pushCheck(checks, { id: `policy-${check.rule.toLowerCase()}`, status: check.passed ? 'PASS' : 'FAIL', reasonCode: check.passed ? `SERVER_${check.rule}_PASS` : `SERVER_${check.rule}_FAIL`, explanation: check.message, source: 'CURRENT_SERVER_POLICY', actual: check.actual, required: check.required });
  }
  const policyBlocking = policyEvaluation.blockingReasons;
  blockingReasons.push(...policyBlocking);
  const decision: PassportDecision = currentStatus === PassportStatus.REVOKED ? PassportDecision.REVOKED : currentStatus === PassportStatus.EXPIRED || Date.parse(nowIso) < Date.parse(payload.validFrom) ? PassportDecision.EXPIRED : blockingReasons.length > 0 ? PassportDecision.BLOCKED : approvalRequired ? PassportDecision.NEEDS_APPROVAL : PassportDecision.ALLOWED;
  pushCheck(checks, {
    id: 'quote-policy-current',
    status: 'PASS',
    reasonCode: 'QUOTE_AND_POLICY_VERSIONS_CURRENT',
    explanation: `The proposal is evaluated against current server policy v${policy.version}; the signed passport records issuance policy v${payload.policyVersion}. Any later policy or quote change is revalidated before execution.`,
    source: 'CURRENT_SERVER_POLICY',
    actual: { policyVersion: policy.version, passportPolicyVersion: payload.policyVersion },
    required: 'current server policy and quote revalidation',
  });
  pushCheck(checks, {
    id: 'execution-permitted',
    status: decision === PassportDecision.ALLOWED ? 'PASS' : decision === PassportDecision.NEEDS_APPROVAL ? 'REQUIRES_ACTION' : 'FAIL',
    reasonCode: decision === PassportDecision.ALLOWED ? 'EXECUTION_PERMITTED' : decision === PassportDecision.NEEDS_APPROVAL ? 'EXECUTION_REQUIRES_APPROVAL' : 'EXECUTION_BLOCKED',
    explanation: decision === PassportDecision.ALLOWED ? 'All deterministic checks pass; execution may proceed to atomic reservation.' : decision === PassportDecision.NEEDS_APPROVAL ? 'Execution is held until an authenticated human approves the exact intent digest.' : 'Execution is not permitted for this decision; a fresh valid authorization is required.',
    source: 'SYSTEM',
    actual: decision,
    required: 'ALLOWED or APPROVED intent',
  });
  return {
    decision,
    checks,
    blockingReasons: [...new Set(blockingReasons)],
    approvalReasons: [...new Set(approvalReasons)],
    totalAmountPaise: total,
    effectiveMaximumAmountPaise: Math.min(policyEvaluation.effectiveMaxTransactionPaise, payload.maximumAmountPerTransactionPaise),
    projectedPassportSpendPaise: projectedPassportSpend,
    remainingPassportBudgetPaise: Math.max(0, payload.cumulativeBudgetPaise - consumption.totalCommittedPaise),
    remainingPassportUsageCount: Math.max(0, payload.maximumUsageCount - consumption.usedCount),
    policyVersion: policy.version,
    passportId: payload.passportId,
  };
}

export function issueDecisionReceipt(intent: PurchaseIntent, passport: StoredPassport, evaluation: PassportAuthorizationEvaluation, clock: Clock = defaultClock): DecisionReceiptRecord {
  const nowIso = clock.nowIso();
  const failedCodes = evaluation.checks.filter((check) => check.status !== 'PASS').map((check) => check.reasonCode);
  const reasonCodes = [...new Set(failedCodes.length ? failedCodes : ['AUTHORIZATION_ALLOWED'])].slice(0, 32);
  const explanation = evaluation.decision === PassportDecision.ALLOWED ? 'Request satisfies the intersection of the signed passport and current server policy.' : evaluation.decision === PassportDecision.NEEDS_APPROVAL ? evaluation.approvalReasons.join('; ') : evaluation.blockingReasons.join('; ');
  const payload: DecisionReceiptPayload = {
    receiptSchemaVersion: 1,
    receiptId: `drcpt_${crypto.randomUUID()}`,
    intentId: intent.id,
    requestHash: intent.canonical_request_hash,
    passportId: passport.payload.passportId,
    passportPayloadDigest: passport.payloadDigest,
    agentId: passport.payload.agentId,
    productId: intent.product_id,
    trustedProductId: intent.product_id,
    merchantId: intent.merchant_id,
    trustedMerchantId: intent.merchant_id,
    category: intent.category,
    trustedCategory: intent.category,
    quantity: intent.quantity,
    unitPricePaise: intent.unit_price_paise,
    trustedUnitPricePaise: intent.unit_price_paise,
    totalAmountPaise: intent.total_amount_paise,
    currency: intent.currency,
    policyVersion: evaluation.policyVersion,
    decision: evaluation.decision,
    reasonCodes,
    explanation: explanation || 'No additional explanation was recorded.',
    budgetObservedPaise: evaluation.projectedPassportSpendPaise - evaluation.totalAmountPaise,
    projectedBudgetAfterPaise: evaluation.projectedPassportSpendPaise,
    projectedBudgetAfterIsProjection: true,
    // Keep the actual requirement visible even when another check blocks the
    // request. A BLOCKED high-value request still requires approval on any
    // fresh authorization; this field is not a claim that approval alone could
    // make a prohibited request allowable.
    approvalRequired: evaluation.approvalReasons.length > 0,
    decisionTimestamp: nowIso,
    issuer: passport.payload.issuer,
    audience: passport.payload.audience,
    keyId: passport.payload.keyId,
  };
  const signedToken = signDecisionReceiptSync(payload);
  const { db } = getDb();
  db.insert(schema.decisionReceipts).values({
    id: payload.receiptId,
    intent_id: intent.id,
    receipt_schema_version: payload.receiptSchemaVersion,
    decision: payload.decision,
    request_hash: payload.requestHash,
    passport_id: payload.passportId,
    passport_payload_digest: payload.passportPayloadDigest,
    payload_json: JSON.stringify(payload),
    signed_token: signedToken,
    key_id: payload.keyId,
    issued_at: nowIso,
  }).run();
  appendAuditEvent({ eventType: 'AUTHORIZATION_DECISION_RECEIPT_ISSUED', intentId: intent.id, operatorId: intent.owner_id, policyVersion: evaluation.policyVersion, amountPaise: intent.total_amount_paise, payload: { receiptId: payload.receiptId, decision: payload.decision, passportId: payload.passportId, passportPayloadDigest: payload.passportPayloadDigest }, clock });
  return { id: payload.receiptId, intentId: intent.id, decision: payload.decision, payload, signedToken, issuedAt: nowIso, keyId: payload.keyId };
}

/** Issues an immutable receipt for a durable post-proposal expiry/revocation decision. */
export function issueLifecycleDecisionReceipt(intent: PurchaseIntent, decision: Extract<PassportDecision, 'EXPIRED' | 'REVOKED' | 'BLOCKED'>, reasonCode: string, explanation: string, clock: Clock = defaultClock): DecisionReceiptRecord | null {
  if (!intent.passport_id) return null;
  const passport = getPassportById(intent.passport_id, intent.owner_id, clock.nowIso());
  if (!passport) return null;
  const { db } = getDb();
  const policy = getCurrentPolicy();
  const consumption = getPassportConsumption(passport.payload.passportId, intent.payment_adapter_mode);
  const payload: DecisionReceiptPayload = {
    receiptSchemaVersion: 1,
    receiptId: `drcpt_${crypto.randomUUID()}`,
    intentId: intent.id,
    requestHash: intent.canonical_request_hash,
    passportId: passport.payload.passportId,
    passportPayloadDigest: passport.payloadDigest,
    agentId: passport.payload.agentId,
    productId: intent.product_id,
    trustedProductId: intent.product_id,
    merchantId: intent.merchant_id,
    trustedMerchantId: intent.merchant_id,
    category: intent.category,
    trustedCategory: intent.category,
    quantity: intent.quantity,
    unitPricePaise: intent.unit_price_paise,
    trustedUnitPricePaise: intent.unit_price_paise,
    totalAmountPaise: intent.total_amount_paise,
    currency: intent.currency,
    policyVersion: policy.version,
    decision,
    reasonCodes: [reasonCode],
    explanation,
    budgetObservedPaise: consumption.totalCommittedPaise,
    projectedBudgetAfterPaise: consumption.totalCommittedPaise,
    projectedBudgetAfterIsProjection: true,
    approvalRequired: false,
    decisionTimestamp: clock.nowIso(),
    issuer: passport.payload.issuer,
    audience: passport.payload.audience,
    keyId: passport.payload.keyId,
  };
  const signedToken = signDecisionReceiptSync(payload);
  db.insert(schema.decisionReceipts).values({
    id: payload.receiptId,
    intent_id: intent.id,
    receipt_schema_version: payload.receiptSchemaVersion,
    decision: payload.decision,
    request_hash: payload.requestHash,
    passport_id: payload.passportId,
    passport_payload_digest: payload.passportPayloadDigest,
    payload_json: JSON.stringify(payload),
    signed_token: signedToken,
    key_id: payload.keyId,
    issued_at: payload.decisionTimestamp,
  }).run();
  appendAuditEvent({ eventType: 'AUTHORIZATION_DECISION_RECEIPT_ISSUED', intentId: intent.id, operatorId: intent.owner_id, policyVersion: policy.version, amountPaise: intent.total_amount_paise, payload: { receiptId: payload.receiptId, decision, passportId: payload.passportId, reasonCode }, clock });
  return { id: payload.receiptId, intentId: intent.id, decision, payload, signedToken, issuedAt: payload.decisionTimestamp, keyId: payload.keyId };
}

export function getLatestDecisionReceipt(intentId: string, ownerId: string): DecisionReceiptRecord | null {
  const { db } = getDb();
  const intent = db.select().from(schema.purchaseIntents).where(and(eq(schema.purchaseIntents.id, intentId), eq(schema.purchaseIntents.owner_id, ownerId))).get();
  if (!intent) throw new PassportNotFoundError('Intent not found');
  const row = db.select().from(schema.decisionReceipts).where(eq(schema.decisionReceipts.intent_id, intentId)).orderBy(desc(schema.decisionReceipts.issued_at)).get();
  if (!row) return null;
  let payload: DecisionReceiptPayload;
  try {
    payload = DecisionReceiptSchema.parse(JSON.parse(row.payload_json)) as DecisionReceiptPayload;
  } catch {
    throw new PassportValidationError('Stored decision receipt is malformed');
  }
  return { id: row.id, intentId: row.intent_id, decision: row.decision as PassportDecision, payload, signedToken: row.signed_token, issuedAt: row.issued_at, keyId: row.key_id };
}

export function verifyDecisionReceipt(receiptToken: string): { valid: true; payload: DecisionReceiptPayload; keyId: string; fingerprint: string } {
  const payload = verifyDecisionReceiptSync(receiptToken);
  return { valid: true, payload, keyId: payload.keyId, fingerprint: publicKeyFingerprintForKeyId(payload.keyId) };
}

export function markPassportUsageStatus(passportId: string, intentId: string, status: PassportUsageStatus, timestamp: string): void {
  const { db } = getDb();
  db.update(schema.passportUsages).set({ usage_status: status, released_or_committed_timestamp: timestamp }).where(and(eq(schema.passportUsages.passport_id, passportId), eq(schema.passportUsages.intent_id, intentId))).run();
}

export function getPassportUsageForIntent(passportId: string, intentId: string) {
  const { db } = getDb();
  return db.select().from(schema.passportUsages).where(and(eq(schema.passportUsages.passport_id, passportId), eq(schema.passportUsages.intent_id, intentId))).get() || null;
}

export function refreshExpiredPassportStatus(passportId: string, clock: Clock = defaultClock): void {
  const { db } = getDb();
  const row = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, passportId)).get();
  if (row && row.status === PassportStatus.ACTIVE && Date.parse(clock.nowIso()) >= Date.parse(row.expires_at)) db.update(schema.authorityPassports).set({ status: PassportStatus.EXPIRED }).where(eq(schema.authorityPassports.id, passportId)).run();
}

export function getPassportPublicRecord(passport: StoredPassport) {
  let signatureVerified = false;
  try {
    // Public records are displayed as signed only after checking both the
    // compact JWS and the database's immutable payload/digest/owner binding.
    // This keeps a corrupted row from being presented as a valid authority
    // merely because it still parses as JSON.
    verifyStoredPassport(passport, passport.payload.ownerId, passport.payload.agentId);
    signatureVerified = true;
  } catch {
    // The record remains inspectable so the UI can surface a failed signature
    // indicator without leaking verifier internals.
  }
  return {
    passport: passport.payload,
    passportId: passport.payload.passportId,
    payloadDigest: passport.payloadDigest,
    signedToken: passport.signedToken,
    status: passport.status,
    revokedAt: passport.revokedAt,
    idempotencyKey: passport.idempotencyKey,
    createdAt: passport.createdAt,
    consumption: passport.consumption,
    signature: { algorithm: 'EdDSA', keyId: passport.payload.keyId, verified: signatureVerified },
  };
}
