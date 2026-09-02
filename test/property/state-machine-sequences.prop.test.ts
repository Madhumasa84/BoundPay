import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { computeCanonicalIntentHash } from '@/domain/intent';
import { IntentState, IntentStates, isValidTransition } from '@/domain/state-machine';
import { evaluateSpendingPolicy, SpendingPolicy } from '@/domain/policy';
import { Product } from '@/domain/catalog';

describe('Phase 3 generated authorization/state properties', () => {
  const seeds = [424242, 20260903];

  it.each(seeds)('terminal confirmed state never regresses across generated action sequences (seed %i)', (seed) => {
    const candidateStates = Object.values(IntentStates);
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...candidateStates), { minLength: 1, maxLength: 40 }),
      (targets) => {
        let current: IntentState = IntentStates.PAYMENT_CONFIRMED;
        for (const target of targets) {
          expect(isValidTransition(current, target)).toBe(target === IntentStates.PAYMENT_CONFIRMED);
          current = IntentStates.PAYMENT_CONFIRMED;
        }
      }
    ), { seed, numRuns: 200 });
  });

  it.each(seeds)('an exact approval digest cannot authorize a mutated purchase (seed %i)', (seed) => {
    fc.assert(fc.property(
      fc.record({
        unit: fc.integer({ min: 1, max: 400000 }),
        quantity: fc.integer({ min: 1, max: 9 }),
        budget: fc.integer({ min: 1, max: 500000 }),
        policyVersion: fc.integer({ min: 1, max: 1000 }),
      }),
      ({ unit, quantity, budget, policyVersion }) => {
        const base = {
          category: 'electronics', currency: 'INR' as const, idempotency_key: 'prop',
          is_subscription: false, merchant_id: 'demo_store', owner_id: 'operator',
          policy_version: policyVersion, product_id: 'product', product_version: 1,
          purchase_budget_paise: budget, quantity, quote_expiry: '2026-09-03T13:00:00.000Z',
          total_amount_paise: unit * quantity, unit_price_paise: unit,
        };
        const approved = computeCanonicalIntentHash(base);
        const changed = computeCanonicalIntentHash({ ...base, product_version: 2 });
        expect(changed).not.toBe(approved);
      }
    ), { seed, numRuns: 200 });
  });

  it.each(seeds)('budget admission agrees with an independent integer inequality oracle (seed %i)', (seed) => {
    const policy: SpendingPolicy = {
      id: 'policy', version: 1, currency: 'INR', max_transaction_amount_paise: 400000,
      daily_budget_paise: 500000, approval_threshold_paise: 250000,
      allowed_categories: ['electronics'], approved_merchant_id: 'demo_store',
      allow_subscriptions: false, expires_at: '2026-10-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z',
    };
    fc.assert(fc.property(
      fc.record({
        unit: fc.integer({ min: 1, max: 400000 }), quantity: fc.integer({ min: 1, max: 10 }),
        purchaseBudget: fc.integer({ min: 1, max: 500000 }),
        confirmed: fc.integer({ min: 0, max: 500000 }), reserved: fc.integer({ min: 0, max: 500000 }),
      }),
      ({ unit, quantity, purchaseBudget, confirmed, reserved }) => {
        const product: Product = { id: 'p', name: 'P', description: '', unit_price_paise: unit, currency: 'INR', category: 'electronics', is_subscription: false, merchant_id: 'demo_store', version: 1, is_active: true, updated_at: '' };
        const actual = evaluateSpendingPolicy({ policy, product, quantity, purchaseBudgetPaise: purchaseBudget, currentDayConfirmedPaise: confirmed, currentActiveReservationsPaise: reserved, nowIso: '2026-09-03T12:00:00.000Z' });
        const total = unit * quantity;
        const independentAllowed = total <= purchaseBudget && total <= 400000 && confirmed + reserved + total <= 500000;
        expect(actual.verdict !== 'BLOCKED').toBe(independentAllowed);
      }
    ), { seed, numRuns: 200 });
  });
});
