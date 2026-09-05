import crypto from 'crypto';
import { z } from 'zod';
import { CURRENCY, Currency } from './money';

export const AUTHORITY_PASSPORT_SCHEMA_VERSION = 1 as const;
export const AUTHORITY_RECEIPT_SCHEMA_VERSION = 1 as const;

export const PassportStatus = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type PassportStatus = (typeof PassportStatus)[keyof typeof PassportStatus];

export const PassportUsageStatus = {
  RESERVED: 'RESERVED',
  COMMITTED: 'COMMITTED',
  CONFIRMED: 'CONFIRMED',
  UNKNOWN: 'UNKNOWN',
  RELEASED: 'RELEASED',
} as const;
export type PassportUsageStatus = (typeof PassportUsageStatus)[keyof typeof PassportUsageStatus];

export const PassportDecision = {
  ALLOWED: 'ALLOWED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  BLOCKED: 'BLOCKED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
} as const;
export type PassportDecision = (typeof PassportDecision)[keyof typeof PassportDecision];

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Must be a safe identifier');
// Issuer/audience are JWT claims and may legitimately be URI-like values
// (for example, https://authority.example); only control characters are
// prohibited rather than forcing them through the local-ID grammar.
const authorityClaim = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Claim contains control characters');
const isoTimestamp = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value === new Date(parsed).toISOString();
}, 'Timestamp must be a canonical UTC ISO-8601 string');
const positivePaise = z.number().int().safe().positive('Amount must be a positive integer in paise');
const nonNegativePaise = z.number().int().safe().nonnegative('Amount must be a non-negative integer in paise');

/** The immutable, signed claims carried by an Authority Passport. */
export const AuthorityPassportSchema = z.object({
  schemaVersion: z.literal(AUTHORITY_PASSPORT_SCHEMA_VERSION),
  passportId: identifier,
  issuer: authorityClaim,
  audience: authorityClaim,
  operatorId: identifier,
  ownerId: identifier,
  agentId: identifier,
  agentDisplayName: z.string().trim().min(1).max(128),
  currency: z.literal(CURRENCY),
  paymentAdapterMode: z.enum(['MOCK', 'RAZORPAY_TEST']),
  allowedMerchantIds: z.array(identifier).min(1, 'At least one merchant must be explicitly allowed').max(128),
  allowedCategories: z.array(identifier).min(1, 'At least one category must be explicitly allowed').max(128),
  maximumAmountPerTransactionPaise: positivePaise,
  cumulativeBudgetPaise: positivePaise,
  approvalRequiredAbovePaise: nonNegativePaise,
  validFrom: isoTimestamp,
  expiresAt: isoTimestamp,
  maximumUsageCount: z.number().int().safe().min(1).max(100000),
  policyVersion: z.number().int().safe().positive(),
  revocationNonce: z.string().regex(/^[a-f0-9]{32,128}$/, 'Invalid revocation nonce'),
  issuedAt: isoTimestamp,
  keyId: identifier,
}).strict().superRefine((value, ctx) => {
  if (value.approvalRequiredAbovePaise > value.maximumAmountPerTransactionPaise) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalRequiredAbovePaise'], message: 'Approval threshold cannot exceed transaction maximum' });
  }
  if (value.cumulativeBudgetPaise < value.maximumAmountPerTransactionPaise) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cumulativeBudgetPaise'], message: 'Cumulative budget cannot be below per-transaction maximum' });
  }
  if (Date.parse(value.validFrom) >= Date.parse(value.expiresAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Expiry must be after validFrom' });
  }
  if (new Set(value.allowedMerchantIds).size !== value.allowedMerchantIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedMerchantIds'], message: 'Merchant allowlist must not contain duplicates' });
  }
  if (new Set(value.allowedCategories).size !== value.allowedCategories.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedCategories'], message: 'Category allowlist must not contain duplicates' });
  }
});

export type AuthorityPassport = z.infer<typeof AuthorityPassportSchema>;

export interface PassportConsumption {
  confirmedPaise: number;
  committedPaise: number;
  outstandingPaise: number;
  totalCommittedPaise: number;
  usedCount: number;
  remainingBudgetPaise: number;
  remainingUsageCount: number;
}

export type DebugCheckStatus = 'PASS' | 'FAIL' | 'REQUIRES_ACTION';
export type DebugValueSource = 'MODEL' | 'AUTHENTICATED_OPERATOR' | 'SIGNED_PASSPORT' | 'TRUSTED_CATALOG' | 'CURRENT_SERVER_POLICY' | 'LEDGER' | 'PROVIDER' | 'SYSTEM';

export interface AuthorizationDebugCheck {
  id: string;
  status: DebugCheckStatus;
  reasonCode: string;
  explanation: string;
  source: DebugValueSource;
  actual?: unknown;
  required?: unknown;
}

export interface PassportAuthorizationEvaluation {
  decision: PassportDecision;
  checks: AuthorizationDebugCheck[];
  blockingReasons: string[];
  approvalReasons: string[];
  totalAmountPaise: number;
  effectiveMaximumAmountPaise: number;
  projectedPassportSpendPaise: number;
  remainingPassportBudgetPaise: number;
  remainingPassportUsageCount: number;
  policyVersion: number;
  passportId: string;
}

export interface DecisionReceiptPayload {
  receiptSchemaVersion: typeof AUTHORITY_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  intentId: string;
  requestHash: string;
  passportId: string;
  passportPayloadDigest: string;
  agentId: string;
  productId: string;
  trustedProductId: string;
  merchantId: string;
  trustedMerchantId: string;
  category: string;
  trustedCategory: string;
  quantity: number;
  unitPricePaise: number;
  trustedUnitPricePaise: number;
  totalAmountPaise: number;
  currency: Currency;
  policyVersion: number;
  decision: PassportDecision;
  reasonCodes: string[];
  explanation: string;
  budgetObservedPaise: number;
  projectedBudgetAfterPaise: number;
  projectedBudgetAfterIsProjection: true;
  approvalRequired: boolean;
  decisionTimestamp: string;
  issuer: string;
  audience: string;
  keyId: string;
}

export const DecisionReceiptSchema = z.object({
  receiptSchemaVersion: z.literal(AUTHORITY_RECEIPT_SCHEMA_VERSION),
  receiptId: identifier,
  intentId: identifier,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  passportId: identifier,
  passportPayloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: identifier,
  productId: identifier,
  trustedProductId: identifier,
  merchantId: identifier,
  trustedMerchantId: identifier,
  category: identifier,
  trustedCategory: identifier,
  quantity: z.number().int().min(1).max(100000),
  unitPricePaise: positivePaise,
  trustedUnitPricePaise: positivePaise,
  totalAmountPaise: positivePaise,
  currency: z.literal(CURRENCY),
  policyVersion: z.number().int().positive(),
  decision: z.enum(['ALLOWED', 'NEEDS_APPROVAL', 'BLOCKED', 'EXPIRED', 'REVOKED']),
  reasonCodes: z.array(identifier).min(1).max(32),
  explanation: z.string().min(1).max(2048),
  budgetObservedPaise: nonNegativePaise,
  projectedBudgetAfterPaise: nonNegativePaise,
  projectedBudgetAfterIsProjection: z.literal(true),
  approvalRequired: z.boolean(),
  decisionTimestamp: isoTimestamp,
  issuer: authorityClaim,
  audience: authorityClaim,
  keyId: identifier,
}).strict();

export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export function digestPassportPayload(payload: AuthorityPassport): string {
  const parsed = AuthorityPassportSchema.parse(payload);
  return crypto.createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

export function digestReceiptPayload(payload: DecisionReceiptPayload): string {
  return crypto.createHash('sha256').update(canonicalJson(payload as unknown as Record<string, unknown>)).digest('hex');
}

export function statusForPassport(passport: Pick<AuthorityPassport, 'expiresAt'> & { status?: PassportStatus; revokedAt?: string | null }, nowIso: string): PassportStatus {
  if (passport.status === PassportStatus.REVOKED || passport.revokedAt) return PassportStatus.REVOKED;
  if (Date.parse(nowIso) >= Date.parse(passport.expiresAt)) return PassportStatus.EXPIRED;
  return PassportStatus.ACTIVE;
}
