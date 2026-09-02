import crypto from 'crypto';
import { z } from 'zod';
import { CURRENCY, Currency } from './money';
import { IntentState, IntentStates } from './state-machine';

export type SourceMode = 'MANUAL' | 'FIXTURE' | 'AGENT_PROPOSAL';
export type PaymentAdapterMode = 'MOCK' | 'RAZORPAY_TEST';

export interface CanonicalIntentPayload {
  category: string;
  currency: Currency;
  idempotency_key: string;
  is_subscription: boolean;
  merchant_id: string;
  owner_id: string;
  policy_version: number;
  product_id: string;
  product_version: number;
  purchase_budget_paise: number;
  quantity: number;
  quote_expiry: string;
  total_amount_paise: number;
  unit_price_paise: number;
}

export interface PurchaseIntent {
  id: string;
  owner_id: string;
  idempotency_key: string;
  canonical_request_hash: string;
  product_id: string;
  merchant_id: string;
  quantity: number;
  unit_price_paise: number;
  total_amount_paise: number;
  currency: Currency;
  category: string;
  is_subscription: boolean;
  product_version: number;
  policy_version: number;
  purchase_budget_paise: number;
  quote_expiry: string;
  source_mode: SourceMode;
  payment_adapter_mode: PaymentAdapterMode;
  state: IntentState;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntentApproval {
  id: string;
  intent_id: string;
  operator_id: string;
  canonical_hash: string;
  status: 'APPROVED' | 'DECLINED';
  notes?: string;
  approved_at: string;
}

/**
 * Computes a deterministic SHA-256 hash over canonically sorted keys of the intent payload.
 * Any modification of price, quantity, policy version, product version, or budget produces a different hash.
 */
export function computeCanonicalIntentHash(payload: CanonicalIntentPayload): string {
  const sortedEntries = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b));
  const canonicalJson = JSON.stringify(Object.fromEntries(sortedEntries));
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Validates that an approval is bound to the exact current canonical hash of the intent.
 */
export function isApprovalValidForIntent(
  approvalHash: string,
  currentCanonicalHash: string
): boolean {
  if (!approvalHash || !currentCanonicalHash) return false;
  return approvalHash === currentCanonicalHash;
}

/**
 * Boundary schema for purchase proposal request (untrusted model / operator input).
 * Notice: the client/model NEVER supplies price, currency, merchant, category, or approval flags!
 */
export const CreateProposalRequestSchema = z.object({
  product_id: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
  purchase_budget_paise: z.number().int().positive('Purchase budget must be a positive integer in paise'),
  idempotency_key: z.string().min(1).max(128),
  source_mode: z.enum(['MANUAL', 'FIXTURE', 'AGENT_PROPOSAL']).default('MANUAL'),
  reason: z.string().max(1024).optional().default(''),
  fault_injection: z.enum([
    'NONE',
    'SIMULATE_REJECTION',
    'SIMULATE_TIMEOUT',
    'SIMULATE_RESPONSE_LOSS',
    'SIMULATE_PENDING',
    'SIMULATE_DUPLICATE',
  ]).optional().default('NONE'),
});

export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>;
