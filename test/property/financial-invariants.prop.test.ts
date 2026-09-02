import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { assertValidPaise, calculateTotalPaise, MoneyValidationError } from '@/domain/money';
import { evaluateSpendingPolicy, SpendingPolicy } from '@/domain/policy';
import { Product } from '@/domain/catalog';

describe('Financial Invariants Property-Based Tests', () => {
  const deterministicSeed = 42;

  const validPolicy: SpendingPolicy = {
    id: 'pol_prop',
    version: 1,
    currency: 'INR',
    max_transaction_amount_paise: 400000,
    daily_budget_paise: 500000,
    approval_threshold_paise: 250000,
    allowed_categories: ['electronics', 'books'],
    approved_merchant_id: 'demo_store',
    allow_subscriptions: false,
    expires_at: '2026-10-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
  };

  const baseProduct: Product = {
    id: 'prod_prop',
    name: 'Test Item',
    description: 'Test Description',
    unit_price_paise: 100000,
    currency: 'INR',
    category: 'electronics',
    is_subscription: false,
    merchant_id: 'demo_store',
    version: 1,
    is_active: true,
    updated_at: '2026-09-01T00:00:00.000Z',
  };

  const nowIso = '2026-09-03T12:00:00.000Z';

  it('Property 1: Invalid monetary inputs (negative, fractional, unsafe) are never validated as safe paise', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ max: -0.001 }), // negative floats
          fc.double({ min: 0.001, noInteger: true }), // fractional numbers
          fc.double({ min: Number.MAX_SAFE_INTEGER + 1000 }), // unsafe overflows
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity)
        ),
        (invalidAmount) => {
          expect(() => assertValidPaise(invalidAmount)).toThrow(MoneyValidationError);
        }
      ),
      { seed: deterministicSeed, numRuns: 1000 }
    );
  });

  it('Property 2: Monotonicity - Increasing purchase amount cannot turn a BLOCKED request into an ALLOWED request', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000000 }), // base price in paise
        fc.integer({ min: 1, max: 10 }),      // quantity
        fc.integer({ min: 1, max: 500000 }),  // additional price
        (basePrice, quantity, additionalPrice) => {
          const lowerProduct: Product = { ...baseProduct, unit_price_paise: basePrice };
          const higherProduct: Product = { ...baseProduct, unit_price_paise: basePrice + additionalPrice };

          const lowerResult = evaluateSpendingPolicy({
            policy: validPolicy,
            product: lowerProduct,
            quantity,
            purchaseBudgetPaise: 500000,
            currentDayConfirmedPaise: 0,
            currentActiveReservationsPaise: 0,
            nowIso,
          });

          const higherResult = evaluateSpendingPolicy({
            policy: validPolicy,
            product: higherProduct,
            quantity,
            purchaseBudgetPaise: 500000,
            currentDayConfirmedPaise: 0,
            currentActiveReservationsPaise: 0,
            nowIso,
          });

          // If the lower amount was already BLOCKED, the higher amount MUST also be BLOCKED
          if (lowerResult.verdict === 'BLOCKED') {
            expect(higherResult.verdict).toBe('BLOCKED');
          }
        }
      ),
      { seed: deterministicSeed, numRuns: 500 }
    );
  });

  it('Property 3: Total amount invariance - Every authorized total strictly equals server price * quantity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 400000 }), // positive price up to limit
        fc.integer({ min: 1, max: 10 }),     // legal quantity 1-10
        (unitPricePaise, quantity) => {
          const product: Product = { ...baseProduct, unit_price_paise: unitPricePaise };

          const result = evaluateSpendingPolicy({
            policy: validPolicy,
            product,
            quantity,
            purchaseBudgetPaise: 500000,
            currentDayConfirmedPaise: 0,
            currentActiveReservationsPaise: 0,
            nowIso,
          });

          const expectedTotal = unitPricePaise * quantity;
          expect(result.totalAmountPaise).toBe(expectedTotal);
          expect(calculateTotalPaise(unitPricePaise, quantity)).toBe(expectedTotal);
        }
      ),
      { seed: deterministicSeed, numRuns: 500 }
    );
  });
});
