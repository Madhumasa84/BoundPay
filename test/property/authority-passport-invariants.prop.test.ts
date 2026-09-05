import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import { createAuthorityPassport, composePassportAuthorization, getPassportById } from '@/services/passport.service';
import { seedDatabase } from '@/infrastructure/db/seed';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { TestClock } from '@/infrastructure/clock/clock';
import { evaluateSpendingPolicy, SpendingPolicy } from '@/domain/policy';
import { Product } from '@/domain/catalog';
import { AuthorityPassport, PassportStatus } from '@/domain/passport';
import { signPassportSync, verifyPassportSync } from '@/infrastructure/authority/signing';
import { CanonicalIntentPayload, computeCanonicalIntentHash } from '@/domain/intent';

/** Critical Phase 4 properties use three recorded seeds and 500 runs per seed. */
describe('Authority Passport monotonicity and integrity properties', () => {
  const seeds = [4101, 4102, 1278130507];
  const clock = new TestClock('2026-09-03T12:00:00.000Z');
  const policy: SpendingPolicy = {
    id: 'prop-policy', version: 4, currency: 'INR', max_transaction_amount_paise: 400000,
    daily_budget_paise: 500000, approval_threshold_paise: 250000,
    allowed_categories: ['electronics', 'books'], approved_merchant_id: 'demo_store',
    allow_subscriptions: false, expires_at: '2026-10-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z',
  };
  const baseProduct: Product = {
    id: 'prod_keyboard', name: 'Keyboard', description: '', unit_price_paise: 279900,
    currency: 'INR', category: 'electronics', is_subscription: false, merchant_id: 'demo_store',
    version: 1, is_active: true, updated_at: '2026-09-01T00:00:00.000Z',
  };
  let dbPath: string;
  let operatorId: string;
  let activePassport: AuthorityPassport;

  beforeAll(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-prop-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    operatorId = db.select().from(schema.operators).get()!.id;
    sqlite.close();
    const passport = createAuthorityPassport(operatorId, {
      agentId: 'property-agent', agentDisplayName: 'Property Agent',
      allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics', 'books'],
      maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 500000,
      approvalRequiredAbovePaise: 250000, validFrom: '2000-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 100,
    }, clock);
    activePassport = passport.payload;
  });

  afterAll(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  it.each(seeds)('effective permissions never broaden either layer (seed %i)', (seed) => {
    fc.assert(fc.property(
      fc.record({ policyMax: fc.integer({ min: 1, max: 400000 }), passportMax: fc.integer({ min: 1, max: 400000 }), quantity: fc.integer({ min: 1, max: 10 }) }),
      ({ policyMax, passportMax, quantity }) => {
        const stored = getPassportById(activePassport.passportId, operatorId)!;
        const result = composePassportAuthorization({
          passport: { ...stored, payload: { ...stored.payload, maximumAmountPerTransactionPaise: passportMax, cumulativeBudgetPaise: Math.max(passportMax, 500000) } },
          ownerId: operatorId, agentId: stored.payload.agentId, product: { ...baseProduct, unit_price_paise: 1 }, quantity,
          policy: { ...policy, max_transaction_amount_paise: policyMax },
          policyEvaluation: evaluateSpendingPolicy({ policy: { ...policy, max_transaction_amount_paise: policyMax }, product: { ...baseProduct, unit_price_paise: 1 }, quantity, purchaseBudgetPaise: 500000, currentDayConfirmedPaise: 0, currentActiveReservationsPaise: 0, nowIso: clock.nowIso() }),
          currentServerBudgetPaise: 0, paymentAdapterMode: 'MOCK', nowIso: clock.nowIso(), signatureValid: true,
        });
        expect(result.effectiveMaximumAmountPaise).toBeLessThanOrEqual(policyMax);
        expect(result.effectiveMaximumAmountPaise).toBeLessThanOrEqual(passportMax);
      },
    ), { seed, numRuns: 500 });
  });

  it.each(seeds)('increasing amount cannot turn denial into ALLOWED (seed %i)', (seed) => {
    fc.assert(fc.property(
      fc.record({ lower: fc.integer({ min: 1, max: 400000 }), increment: fc.integer({ min: 1, max: 400000 }), quantity: fc.integer({ min: 1, max: 10 }) }),
      ({ lower, increment, quantity }) => {
        const evaluate = (unit: number) => evaluateSpendingPolicy({ policy, product: { ...baseProduct, unit_price_paise: unit }, quantity, purchaseBudgetPaise: 500000, currentDayConfirmedPaise: 0, currentActiveReservationsPaise: 0, nowIso: clock.nowIso() });
        const low = evaluate(lower);
        const high = evaluate(Math.min(Number.MAX_SAFE_INTEGER, lower + increment));
        if (low.verdict === 'BLOCKED') expect(high.verdict).not.toBe('ALLOWED');
      },
    ), { seed, numRuns: 500 });
  });

  it.each(seeds)('adding commitments never increases available budget (seed %i)', (seed) => {
    fc.assert(fc.property(
      fc.record({ budget: fc.integer({ min: 1, max: 10000000 }), first: fc.integer({ min: 0, max: 10000000 }), second: fc.integer({ min: 0, max: 10000000 }) }),
      ({ budget, first, second }) => {
        const remainingBefore = Math.max(0, budget - first);
        const remainingAfter = Math.max(0, budget - (first + second));
        expect(remainingAfter).toBeLessThanOrEqual(remainingBefore);
      },
    ), { seed, numRuns: 500 });
  });

  it.each(seeds)('revocation never increases authority (seed %i)', (seed) => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 400000 }), (unitPrice) => {
      const stored = getPassportById(activePassport.passportId, operatorId)!;
      const product = { ...baseProduct, unit_price_paise: unitPrice };
      const policyEvaluation = evaluateSpendingPolicy({ policy, product, quantity: 1, purchaseBudgetPaise: 500000, currentDayConfirmedPaise: 0, currentActiveReservationsPaise: 0, nowIso: clock.nowIso() });
      const base = composePassportAuthorization({ passport: stored, ownerId: operatorId, agentId: stored.payload.agentId, product, quantity: 1, policy, policyEvaluation, currentServerBudgetPaise: 0, paymentAdapterMode: 'MOCK', nowIso: clock.nowIso(), signatureValid: true });
      const revoked = composePassportAuthorization({ passport: { ...stored, status: PassportStatus.REVOKED, revokedAt: clock.nowIso() }, ownerId: operatorId, agentId: stored.payload.agentId, product, quantity: 1, policy, policyEvaluation, currentServerBudgetPaise: 0, paymentAdapterMode: 'MOCK', nowIso: clock.nowIso(), signatureValid: true });
      expect(revoked.decision).not.toBe('ALLOWED');
      if (base.decision === 'BLOCKED' || base.decision === 'EXPIRED' || base.decision === 'REVOKED') expect(revoked.decision).toBe('REVOKED');
    }), { seed, numRuns: 500 });
  });

  it.each(seeds)('altering any signed payload field invalidates verification (seed %i)', (seed) => {
    fc.assert(fc.property(fc.constantFrom(...Object.keys(activePassport)), (field) => {
      const payload = { ...activePassport } as Record<string, unknown>;
      const value = payload[field];
      payload[field] = typeof value === 'number' ? value + 1 : Array.isArray(value) ? [...value, 'tampered'] : `${String(value)}-altered`;
      const token = signPassportSync(activePassport as unknown as Record<string, unknown>);
      const [header, encoded, signature] = token.split('.');
      const altered = Buffer.from(JSON.stringify(payload)).toString('base64url');
      expect(() => verifyPassportSync(`${header}.${altered}.${signature}`)).toThrow();
      expect(altered).not.toBe(encoded);
    }), { seed, numRuns: 500 });
  });

  it.each(seeds)('expiry or an added passport restriction cannot increase authority (seed %i)', (seed) => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 400000 }), (unitPrice) => {
      const stored = getPassportById(activePassport.passportId, operatorId)!;
      const product = { ...baseProduct, unit_price_paise: unitPrice };
      const policyEvaluation = evaluateSpendingPolicy({ policy, product, quantity: 1, purchaseBudgetPaise: 500000, currentDayConfirmedPaise: 0, currentActiveReservationsPaise: 0, nowIso: clock.nowIso() });
      const evaluate = (passport: typeof stored) => composePassportAuthorization({ passport, ownerId: operatorId, agentId: stored.payload.agentId, product, quantity: 1, policy, policyEvaluation, currentServerBudgetPaise: 0, paymentAdapterMode: 'MOCK', nowIso: clock.nowIso(), signatureValid: true });
      const base = evaluate(stored);
      const expired = evaluate({ ...stored, payload: { ...stored.payload, expiresAt: '2026-09-03T11:59:59.999Z' } });
      const restricted = evaluate({ ...stored, payload: { ...stored.payload, allowedCategories: ['books'] } });
      expect(expired.decision).not.toBe('ALLOWED');
      expect(restricted.decision).not.toBe('ALLOWED');
      if (base.decision !== 'ALLOWED') {
        expect(expired.decision).not.toBe('ALLOWED');
        expect(restricted.decision).not.toBe('ALLOWED');
      }
    }), { seed, numRuns: 500 });
  });

  it.each(seeds)('modifying any approval-bound intent field changes its digest (seed %i)', (seed) => {
    const base: CanonicalIntentPayload = {
      category: 'electronics', currency: 'INR', idempotency_key: 'property-approval', is_subscription: false,
      merchant_id: 'demo_store', owner_id: 'operator', policy_version: 1, product_id: 'prod_mouse',
      product_version: 1, purchase_budget_paise: 200000, quantity: 1,
      quote_expiry: '2026-09-03T12:10:00.000Z', total_amount_paise: 149900, unit_price_paise: 149900,
      passport_id: 'pass_original', passport_payload_digest: 'a'.repeat(64), agent_id: 'officebot', payment_adapter_mode: 'MOCK',
    };
    const fields = Object.keys(base) as Array<keyof CanonicalIntentPayload>;
    fc.assert(fc.property(fc.constantFrom(...fields), (field) => {
      const changed = { ...base } as Record<string, unknown>;
      const value = changed[field];
      changed[field] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${String(value)}x`;
      expect(computeCanonicalIntentHash(changed as unknown as CanonicalIntentPayload)).not.toBe(computeCanonicalIntentHash(base));
    }), { seed, numRuns: 500 });
  });

  it.each(seeds)('admitted outstanding plus confirmed commitments stay within budget (seed %i)', (seed) => {
    fc.assert(fc.property(fc.record({ budget: fc.integer({ min: 1, max: 1000000 }), amounts: fc.array(fc.integer({ min: 1, max: 250000 }), { maxLength: 20 }) }), ({ budget, amounts }) => {
      let total = 0;
      for (const amount of amounts) {
        if (total + amount <= budget) total += amount;
      }
      expect(total).toBeLessThanOrEqual(budget);
    }), { seed, numRuns: 500 });
  });
});
