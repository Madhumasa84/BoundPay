import { describe, it, expect } from 'vitest';
import {
  CanonicalIntentPayload,
  computeCanonicalIntentHash,
  isApprovalValidForIntent,
} from '@/domain/intent';

describe('Canonical Intent Hashing and Exact Approval Binding', () => {
  const basePayload: CanonicalIntentPayload = {
    category: 'electronics',
    currency: 'INR',
    idempotency_key: 'idem_key_123',
    is_subscription: false,
    merchant_id: 'demo_store',
    owner_id: 'op_user_1',
    policy_version: 1,
    product_id: 'prod_keyboard',
    product_version: 1,
    purchase_budget_paise: 300000,
    quantity: 1,
    quote_expiry: '2026-09-03T12:00:00.000Z',
    total_amount_paise: 279900,
    unit_price_paise: 279900,
  };

  it('produces identical hash regardless of object key order', () => {
    const hash1 = computeCanonicalIntentHash(basePayload);

    // Create an object with inverted property order
    const reorderedPayload: CanonicalIntentPayload = {
      unit_price_paise: basePayload.unit_price_paise,
      total_amount_paise: basePayload.total_amount_paise,
      quantity: basePayload.quantity,
      quote_expiry: basePayload.quote_expiry,
      purchase_budget_paise: basePayload.purchase_budget_paise,
      product_version: basePayload.product_version,
      product_id: basePayload.product_id,
      policy_version: basePayload.policy_version,
      owner_id: basePayload.owner_id,
      merchant_id: basePayload.merchant_id,
      is_subscription: basePayload.is_subscription,
      idempotency_key: basePayload.idempotency_key,
      currency: basePayload.currency,
      category: basePayload.category,
    };

    const hash2 = computeCanonicalIntentHash(reorderedPayload);
    expect(hash1).toBe(hash2);
  });

  it('changes hash when price or amount changes', () => {
    const originalHash = computeCanonicalIntentHash(basePayload);
    const modifiedHash = computeCanonicalIntentHash({
      ...basePayload,
      unit_price_paise: 280000,
      total_amount_paise: 280000,
    });
    expect(originalHash).not.toBe(modifiedHash);
  });

  it('changes hash when quantity changes', () => {
    const originalHash = computeCanonicalIntentHash(basePayload);
    const modifiedHash = computeCanonicalIntentHash({
      ...basePayload,
      quantity: 2,
      total_amount_paise: 559800,
    });
    expect(originalHash).not.toBe(modifiedHash);
  });

  it('changes hash when product version increments (price update)', () => {
    const originalHash = computeCanonicalIntentHash(basePayload);
    const modifiedHash = computeCanonicalIntentHash({
      ...basePayload,
      product_version: 2,
    });
    expect(originalHash).not.toBe(modifiedHash);
  });

  it('changes hash when policy version increments', () => {
    const originalHash = computeCanonicalIntentHash(basePayload);
    const modifiedHash = computeCanonicalIntentHash({
      ...basePayload,
      policy_version: 2,
    });
    expect(originalHash).not.toBe(modifiedHash);
  });

  it('verifies exact approval binding', () => {
    const canonicalHash = computeCanonicalIntentHash(basePayload);
    expect(isApprovalValidForIntent(canonicalHash, canonicalHash)).toBe(true);

    const tamperedHash = computeCanonicalIntentHash({
      ...basePayload,
      quantity: 5,
    });
    expect(isApprovalValidForIntent(canonicalHash, tamperedHash)).toBe(false);
  });
});
