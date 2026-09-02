import { z } from 'zod';
import { assertPositivePaise, assertValidPaise, CURRENCY, Currency } from './money';
import { Product } from './catalog';

export interface SpendingPolicy {
  id: string;
  version: number;
  currency: Currency;
  max_transaction_amount_paise: number;
  daily_budget_paise: number;
  approval_threshold_paise: number;
  allowed_categories: string[];
  approved_merchant_id: string;
  allow_subscriptions: boolean;
  expires_at: string; // ISO 8601
  created_at: string;
}

export const PolicyUpdateSchema = z.object({
  currency: z.literal(CURRENCY).default(CURRENCY),
  max_transaction_amount_paise: z.number().int().positive('Max transaction amount must be positive'),
  daily_budget_paise: z.number().int().positive('Daily budget must be positive'),
  approval_threshold_paise: z.number().int().nonnegative('Approval threshold must be non-negative'),
  allowed_categories: z.array(z.string().min(1)).min(1, 'At least one allowed category is required'),
  approved_merchant_id: z.string().min(1, 'Approved merchant ID is required'),
  allow_subscriptions: z.boolean(),
  expires_at: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Invalid ISO date string for expires_at',
  }),
}).refine((data) => data.approval_threshold_paise <= data.max_transaction_amount_paise, {
  message: 'Approval threshold cannot exceed the maximum transaction limit',
  path: ['approval_threshold_paise'],
}).refine((data) => data.max_transaction_amount_paise <= data.daily_budget_paise, {
  message: 'Transaction limit cannot exceed the daily budget',
  path: ['max_transaction_amount_paise'],
});

export type PolicyUpdateInput = z.infer<typeof PolicyUpdateSchema>;

export const DEFAULT_POLICY: Omit<SpendingPolicy, 'id' | 'version' | 'created_at'> = {
  currency: CURRENCY,
  max_transaction_amount_paise: 400000, // ₹4,000
  daily_budget_paise: 500000, // ₹5,000
  approval_threshold_paise: 250000, // ₹2,500
  allowed_categories: ['electronics', 'books'],
  approved_merchant_id: 'demo_store',
  allow_subscriptions: false,
  // Default to 30 days in the future
  expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

export interface PolicyCheckResult {
  rule: string;
  passed: boolean;
  message: string;
  required?: string | number | boolean;
  actual?: string | number | boolean;
}

export interface PolicyEvaluation {
  verdict: 'ALLOWED' | 'NEEDS_APPROVAL' | 'BLOCKED';
  state: 'READY' | 'NEEDS_APPROVAL' | 'BLOCKED';
  checks: PolicyCheckResult[];
  blockingReasons: string[];
  requiresApprovalReasons: string[];
  effectiveMaxTransactionPaise: number;
  totalAmountPaise: number;
}

export interface EvaluatePolicyParams {
  policy: SpendingPolicy;
  product: Product;
  quantity: number;
  purchaseBudgetPaise: number;
  currentDayConfirmedPaise: number;
  currentActiveReservationsPaise: number;
  nowIso: string;
}

/**
 * Deterministically evaluates a proposed purchase against the spending policy and purchase budget.
 */
export function evaluateSpendingPolicy(params: EvaluatePolicyParams): PolicyEvaluation {
  const {
    policy,
    product,
    quantity,
    purchaseBudgetPaise,
    currentDayConfirmedPaise,
    currentActiveReservationsPaise,
    nowIso,
  } = params;

  assertPositivePaise(product.unit_price_paise, 'unit_price_paise');
  assertPositivePaise(purchaseBudgetPaise, 'purchaseBudgetPaise');
  assertValidPaise(currentDayConfirmedPaise, 'currentDayConfirmedPaise');
  assertValidPaise(currentActiveReservationsPaise, 'currentActiveReservationsPaise');

  const checks: PolicyCheckResult[] = [];
  const blockingReasons: string[] = [];
  const requiresApprovalReasons: string[] = [];

  const totalAmountPaise = product.unit_price_paise * quantity;
  const effectiveMaxTransactionPaise = Math.min(policy.max_transaction_amount_paise, purchaseBudgetPaise);

  // 1. Currency Check
  const currencyPassed = product.currency === policy.currency;
  checks.push({
    rule: 'CURRENCY_MATCH',
    passed: currencyPassed,
    message: currencyPassed
      ? `Currency matches policy currency (${policy.currency})`
      : `Product currency (${product.currency}) does not match policy currency (${policy.currency})`,
    required: policy.currency,
    actual: product.currency,
  });
  if (!currencyPassed) {
    blockingReasons.push(`Currency mismatch: expected ${policy.currency}, got ${product.currency}`);
  }

  // 2. Merchant Check
  const merchantPassed = product.merchant_id === policy.approved_merchant_id;
  checks.push({
    rule: 'APPROVED_MERCHANT',
    passed: merchantPassed,
    message: merchantPassed
      ? `Merchant '${product.merchant_id}' is approved`
      : `Merchant '${product.merchant_id}' is not approved (allowed: '${policy.approved_merchant_id}')`,
    required: policy.approved_merchant_id,
    actual: product.merchant_id,
  });
  if (!merchantPassed) {
    blockingReasons.push(`Merchant '${product.merchant_id}' is not approved`);
  }

  // 3. Subscription Check
  const subscriptionPassed = !product.is_subscription || policy.allow_subscriptions;
  checks.push({
    rule: 'SUBSCRIPTION_ALLOWED',
    passed: subscriptionPassed,
    message: subscriptionPassed
      ? (product.is_subscription ? 'Subscriptions permitted by policy' : 'One-time product (not a subscription)')
      : 'Subscriptions are strictly prohibited by standing policy',
    required: policy.allow_subscriptions,
    actual: product.is_subscription,
  });
  if (!subscriptionPassed) {
    blockingReasons.push('Subscriptions are prohibited by policy');
  }

  // 4. Category Check
  const categoryPassed = policy.allowed_categories.includes(product.category);
  checks.push({
    rule: 'CATEGORY_ALLOWED',
    passed: categoryPassed,
    message: categoryPassed
      ? `Category '${product.category}' is allowed`
      : `Category '${product.category}' is not in allowed categories: [${policy.allowed_categories.join(', ')}]`,
    required: policy.allowed_categories.join(','),
    actual: product.category,
  });
  if (!categoryPassed) {
    blockingReasons.push(`Category '${product.category}' is not allowed`);
  }

  // 5. Policy Expiry Check
  const nowTime = new Date(nowIso).getTime();
  const policyExpiryTime = new Date(policy.expires_at).getTime();
  const policyNotExpired = nowTime < policyExpiryTime;
  checks.push({
    rule: 'POLICY_ACTIVE',
    passed: policyNotExpired,
    message: policyNotExpired
      ? `Policy is active (expires at ${policy.expires_at})`
      : `Spending policy expired at ${policy.expires_at}`,
    required: `< ${policy.expires_at}`,
    actual: nowIso,
  });
  if (!policyNotExpired) {
    blockingReasons.push(`Policy expired at ${policy.expires_at}`);
  }

  // 6. Explicit Purchase Budget Check
  const purchaseBudgetPassed = totalAmountPaise <= purchaseBudgetPaise;
  checks.push({
    rule: 'PURCHASE_BUDGET_LIMIT',
    passed: purchaseBudgetPassed,
    message: purchaseBudgetPassed
      ? `Total amount (${totalAmountPaise} paise) is within explicit purchase budget (${purchaseBudgetPaise} paise)`
      : `Total amount (${totalAmountPaise} paise) exceeds explicit purchase budget (${purchaseBudgetPaise} paise)`,
    required: purchaseBudgetPaise,
    actual: totalAmountPaise,
  });
  if (!purchaseBudgetPassed) {
    blockingReasons.push(`Total amount (${totalAmountPaise} paise) exceeds explicit purchase budget (${purchaseBudgetPaise} paise)`);
  }

  // 7. Policy Max Transaction Limit Check
  const maxTxPassed = totalAmountPaise <= policy.max_transaction_amount_paise;
  checks.push({
    rule: 'MAX_TRANSACTION_LIMIT',
    passed: maxTxPassed,
    message: maxTxPassed
      ? `Total amount (${totalAmountPaise} paise) is within maximum transaction limit (${policy.max_transaction_amount_paise} paise)`
      : `Total amount (${totalAmountPaise} paise) exceeds policy transaction limit (${policy.max_transaction_amount_paise} paise)`,
    required: policy.max_transaction_amount_paise,
    actual: totalAmountPaise,
  });
  if (!maxTxPassed) {
    blockingReasons.push(`Total amount (${totalAmountPaise} paise) exceeds max transaction limit (${policy.max_transaction_amount_paise} paise)`);
  }

  // 8. Daily Budget Available Check
  const projectedTotalSpend = currentDayConfirmedPaise + currentActiveReservationsPaise + totalAmountPaise;
  const dailyBudgetPassed = projectedTotalSpend <= policy.daily_budget_paise;
  checks.push({
    rule: 'DAILY_BUDGET_AVAILABLE',
    passed: dailyBudgetPassed,
    message: dailyBudgetPassed
      ? `Projected daily spend (${projectedTotalSpend} paise) is within daily budget (${policy.daily_budget_paise} paise)`
      : `Projected daily spend (${projectedTotalSpend} paise = ${currentDayConfirmedPaise} confirmed + ${currentActiveReservationsPaise} reserved + ${totalAmountPaise} proposed) exceeds daily budget (${policy.daily_budget_paise} paise)`,
    required: policy.daily_budget_paise,
    actual: projectedTotalSpend,
  });
  if (!dailyBudgetPassed) {
    blockingReasons.push(`Projected spend (${projectedTotalSpend} paise) exceeds daily budget (${policy.daily_budget_paise} paise)`);
  }

  // 9. Human Approval Threshold Check
  // Note: Only evaluated if not already blocked
  const requiresApproval = totalAmountPaise > policy.approval_threshold_paise;
  checks.push({
    rule: 'APPROVAL_THRESHOLD',
    passed: !requiresApproval,
    message: requiresApproval
      ? `Total amount (${totalAmountPaise} paise) exceeds auto-approval threshold (${policy.approval_threshold_paise} paise); human approval required`
      : `Total amount (${totalAmountPaise} paise) is within auto-approval threshold (${policy.approval_threshold_paise} paise)`,
    required: `<= ${policy.approval_threshold_paise}`,
    actual: totalAmountPaise,
  });
  if (requiresApproval) {
    requiresApprovalReasons.push(`Total amount exceeds approval threshold of ${policy.approval_threshold_paise} paise`);
  }

  // Verdict determination
  if (blockingReasons.length > 0) {
    return {
      verdict: 'BLOCKED',
      state: 'BLOCKED',
      checks,
      blockingReasons,
      requiresApprovalReasons,
      effectiveMaxTransactionPaise,
      totalAmountPaise,
    };
  }

  if (requiresApproval) {
    return {
      verdict: 'NEEDS_APPROVAL',
      state: 'NEEDS_APPROVAL',
      checks,
      blockingReasons,
      requiresApprovalReasons,
      effectiveMaxTransactionPaise,
      totalAmountPaise,
    };
  }

  return {
    verdict: 'ALLOWED',
    state: 'READY',
    checks,
    blockingReasons,
    requiresApprovalReasons,
    effectiveMaxTransactionPaise,
    totalAmountPaise,
  };
}
