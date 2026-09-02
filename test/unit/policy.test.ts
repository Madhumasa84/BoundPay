import { describe, it, expect } from 'vitest';
import {
  evaluateSpendingPolicy,
  DEFAULT_POLICY,
  SpendingPolicy,
  PolicyUpdateSchema,
} from '@/domain/policy';
import { Product } from '@/domain/catalog';

describe('Spending Policy Evaluation Engine', () => {
  const basePolicy: SpendingPolicy = {
    id: 'pol_test',
    version: 1,
    currency: 'INR',
    max_transaction_amount_paise: 400000, // ₹4,000
    daily_budget_paise: 500000,          // ₹5,000
    approval_threshold_paise: 250000,    // ₹2,500
    allowed_categories: ['electronics', 'books'],
    approved_merchant_id: 'demo_store',
    allow_subscriptions: false,
    expires_at: '2026-10-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
  };

  const baseProduct: Product = {
    id: 'prod_keyboard',
    name: 'Keyboard',
    description: 'Hot-swappable keyboard',
    unit_price_paise: 250000,
    currency: 'INR',
    category: 'electronics',
    is_subscription: false,
    merchant_id: 'demo_store',
    version: 1,
    is_active: true,
    updated_at: '2026-09-01T00:00:00.000Z',
  };

  const nowIso = '2026-09-03T12:00:00.000Z';

  describe('Approval Threshold Boundaries', () => {
    it('is READY exactly at approval threshold (250000 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 250000 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('READY');
      expect(res.verdict).toBe('ALLOWED');
    });

    it('is READY one paise below approval threshold (249999 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 249999 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('READY');
      expect(res.verdict).toBe('ALLOWED');
    });

    it('is NEEDS_APPROVAL one paise above approval threshold (250001 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 250001 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('NEEDS_APPROVAL');
      expect(res.verdict).toBe('NEEDS_APPROVAL');
      expect(res.requiresApprovalReasons).toContain(
        'Total amount exceeds approval threshold of 250000 paise'
      );
    });
  });

  describe('Max Transaction Limit Boundaries', () => {
    it('is allowed exactly at transaction limit (400000 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 400000 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('NEEDS_APPROVAL'); // > 250000 but <= 400000
    });

    it('is allowed one paise below transaction limit (399999 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 399999 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('NEEDS_APPROVAL');
    });

    it('is BLOCKED one paise above transaction limit (400001 paise)', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 400001 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.verdict).toBe('BLOCKED');
      expect(res.blockingReasons.some((r) => r.includes('exceeds max transaction limit'))).toBe(true);
    });
  });

  describe('Explicit Purchase Budget Constraints', () => {
    it('is allowed when total <= explicit purchase budget', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 150000 },
        quantity: 1,
        purchaseBudgetPaise: 150000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('READY');
    });

    it('is BLOCKED when total exceeds explicit purchase budget even if within policy limit', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 150000 },
        quantity: 1,
        purchaseBudgetPaise: 149999, // 1 paise below total
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons.some((r) => r.includes('exceeds explicit purchase budget'))).toBe(true);
    });
  });

  describe('Daily Budget Boundaries and Invariant', () => {
    it('allows reservation when spend + reserved + proposed == daily budget', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 100000 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 200000,
        currentActiveReservationsPaise: 200000, // 200000 + 200000 + 100000 = 500000
        nowIso,
      });
      expect(res.state).toBe('READY');
    });

    it('blocks reservation when spend + reserved + proposed is 1 paise over daily budget', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, unit_price_paise: 100001 },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 200000,
        currentActiveReservationsPaise: 200000, // sum = 500001
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons.some((r) => r.includes('exceeds daily budget'))).toBe(true);
    });
  });

  describe('Trust Boundaries and Prohibited Attributes', () => {
    it('blocks forbidden category', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, category: 'gaming_consoles' },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain("Category 'gaming_consoles' is not allowed");
    });

    it('blocks unapproved merchant', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, merchant_id: 'fraudulent_seller' },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain("Merchant 'fraudulent_seller' is not approved");
    });

    it('blocks subscriptions when prohibited by policy', () => {
      const res = evaluateSpendingPolicy({
        policy: { ...basePolicy, allow_subscriptions: false },
        product: { ...baseProduct, is_subscription: true },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain('Subscriptions are prohibited by policy');
    });

    it('blocks currency mismatch', () => {
      const res = evaluateSpendingPolicy({
        policy: basePolicy,
        product: { ...baseProduct, currency: 'USD' as any },
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain('Currency mismatch: expected INR, got USD');
    });
  });

  describe('Expiry Boundaries', () => {
    const expiryIso = '2026-09-03T12:00:00.000Z';
    const policyWithFixedExpiry = { ...basePolicy, expires_at: expiryIso };

    it('is active 1ms before expiry', () => {
      const justBefore = '2026-09-03T11:59:59.999Z';
      const res = evaluateSpendingPolicy({
        policy: policyWithFixedExpiry,
        product: baseProduct,
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso: justBefore,
      });
      expect(res.state).not.toBe('BLOCKED');
    });

    it('is BLOCKED exactly at expiry timestamp', () => {
      const res = evaluateSpendingPolicy({
        policy: policyWithFixedExpiry,
        product: baseProduct,
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso: expiryIso,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain(`Policy expired at ${expiryIso}`);
    });

    it('is BLOCKED after expiry timestamp', () => {
      const after = '2026-09-03T12:00:01.000Z';
      const res = evaluateSpendingPolicy({
        policy: policyWithFixedExpiry,
        product: baseProduct,
        quantity: 1,
        purchaseBudgetPaise: 500000,
        currentDayConfirmedPaise: 0,
        currentActiveReservationsPaise: 0,
        nowIso: after,
      });
      expect(res.state).toBe('BLOCKED');
      expect(res.blockingReasons).toContain(`Policy expired at ${expiryIso}`);
    });
  });

  describe('Policy Input Schema Validation', () => {
    it('rejects approval threshold higher than max transaction limit', () => {
      expect(() =>
        PolicyUpdateSchema.parse({
          currency: 'INR',
          max_transaction_amount_paise: 300000,
          daily_budget_paise: 500000,
          approval_threshold_paise: 400000, // > max_transaction
          allowed_categories: ['electronics'],
          approved_merchant_id: 'demo_store',
          allow_subscriptions: false,
          expires_at: '2026-10-01T00:00:00.000Z',
        })
      ).toThrow();
    });

    it('rejects max transaction higher than daily budget', () => {
      expect(() =>
        PolicyUpdateSchema.parse({
          currency: 'INR',
          max_transaction_amount_paise: 600000, // > daily budget
          daily_budget_paise: 500000,
          approval_threshold_paise: 200000,
          allowed_categories: ['electronics'],
          approved_merchant_id: 'demo_store',
          allow_subscriptions: false,
          expires_at: '2026-10-01T00:00:00.000Z',
        })
      ).toThrow();
    });

    it('rejects negative or fractional values', () => {
      expect(() =>
        PolicyUpdateSchema.parse({
          currency: 'INR',
          max_transaction_amount_paise: -100,
          daily_budget_paise: 500000,
          approval_threshold_paise: 200000,
          allowed_categories: ['electronics'],
          approved_merchant_id: 'demo_store',
          allow_subscriptions: false,
          expires_at: '2026-10-01T00:00:00.000Z',
        })
      ).toThrow();
    });
  });
});
