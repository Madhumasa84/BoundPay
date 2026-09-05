import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { createAuthorityPassport, createAuthorityPassport as issuePassport, getPassportById, getLatestDecisionReceipt, revokePassport, verifyDecisionReceipt } from '@/services/passport.service';
import { createProposal, approveIntent } from '@/services/purchase.service';
import { ExecutionService } from '@/services/execution.service';
import { MockPaymentAdapter } from '@/infrastructure/payment/mock-adapter';
import { verifyPassportSync, verifyPassportSignatureSync, signPassportSync } from '@/infrastructure/authority/signing';
import { AuthorityPassportSchema } from '@/domain/passport';

describe('Authority Passport domain, signing, composition, and lifecycle', () => {
  let dbPath: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    closeDefaultDb();
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  function operator() {
    const db = createDrizzleClient(createSqliteConnection(dbPath));
    return db.select().from(schema.operators).get()!;
  }

  function passportInput(overrides: Record<string, unknown> = {}) {
    return {
      agentId: 'officebot', agentDisplayName: 'OfficeBot', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics', 'books'],
      maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000, approvalRequiredAbovePaise: 300000,
      validFrom: '2000-01-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z', maximumUsageCount: 10,
      ...overrides,
    };
  }

  it('issues an immutable EdDSA passport with explicit constraints and verifies it', () => {
    const op = operator();
    const issued = createAuthorityPassport(op.id, passportInput(), clock);
    expect(issued.payload.currency).toBe('INR');
    expect(issued.payload.allowedMerchantIds).toEqual(['demo_store']);
    expect(issued.payload.maximumAmountPerTransactionPaise).toBe(400000);
    expect(issued.payload.revocationNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyPassportSync(issued.signedToken).passportId).toBe(issued.payload.passportId);
    const stored = getPassportById(issued.payload.passportId, op.id)!;
    expect(stored.payloadDigest).toBe(issued.payloadDigest);
    expect(stored.signedToken).toBe(issued.signedToken);
  });

  it('rejects empty or unknown allowlists and invalid monetary boundaries', () => {
    const op = operator();
    expect(() => issuePassport(op.id, passportInput({ allowedMerchantIds: [] }), clock)).toThrow();
    expect(() => issuePassport(op.id, passportInput({ allowedCategories: [] }), clock)).toThrow();
    expect(() => issuePassport(op.id, passportInput({ allowedMerchantIds: ['unknown_merchant'] }), clock)).toThrow(/unknown merchant/i);
    expect(() => issuePassport(op.id, passportInput({ allowedCategories: ['unknown_category'] }), clock)).toThrow(/unknown category/i);
    expect(() => issuePassport(op.id, passportInput({ allowedCategories: ['Electronics'] }), clock)).toThrow(/unknown category/i);
    expect(() => issuePassport(op.id, passportInput({ maximumAmountPerTransactionPaise: -1 }), clock)).toThrow();
    expect(() => issuePassport(op.id, passportInput({ maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1 }), clock)).toThrow(/cumulative/i);
    expect(() => issuePassport(op.id, passportInput({ approvalRequiredAbovePaise: 400001 }), clock)).toThrow(/threshold/i);
  });

  it('rejects duplicate/empty allowlists, non-canonical UTC, unsupported schema/currency, unsafe paise, and malformed IDs', () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput(), clock);
    const cases = [
      { ...issued.payload, allowedMerchantIds: ['demo_store', 'demo_store'] },
      { ...issued.payload, allowedCategories: [] },
      { ...issued.payload, validFrom: '2026-09-03T12:00:00+05:30' },
      { ...issued.payload, schemaVersion: 2 },
      { ...issued.payload, currency: 'USD' },
      { ...issued.payload, maximumAmountPerTransactionPaise: Number.MAX_SAFE_INTEGER + 1, cumulativeBudgetPaise: Number.MAX_SAFE_INTEGER + 1 },
      { ...issued.payload, agentId: '../forged-agent' },
      { ...issued.payload, unexpectedAuthority: true },
      { ...issued.payload, allowedMerchantIds: [' demo_store'] },
    ];
    for (const candidate of cases) expect(() => AuthorityPassportSchema.parse(candidate)).toThrow();
  });

  it('fails closed for altered payload, altered signature, unknown kid, alg none, and wrong issuer', () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput(), clock);
    const [header, payload, signature] = issued.signedToken.split('.');
    const alteredPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), agentId: 'attacker' })).toString('base64url');
    expect(() => verifyPassportSync(`${header}.${alteredPayload}.${signature}`)).toThrow();
    const alteredSignature = `${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyPassportSync(`${header}.${payload}.${alteredSignature}`)).toThrow();
    const unknownHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'unknown-key', typ: 'boundpay-authority-passport+jwt' })).toString('base64url');
    expect(() => verifyPassportSignatureSync(`${unknownHeader}.${payload}.${signature}`)).toThrow(/key ID/i);
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-only-key-v1', typ: 'boundpay-authority-passport+jwt' })).toString('base64url');
    expect(() => verifyPassportSignatureSync(`${noneHeader}.${payload}.`)).toThrow();
    process.env.AUTHORITY_ISSUER = 'wrong-issuer';
    expect(() => verifyPassportSignatureSync(issued.signedToken)).toThrow(/issuer/i);
  });

  it('intersects passport constraints with server policy and emits a signed decision receipt', () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput({ maximumAmountPerTransactionPaise: 100000, cumulativeBudgetPaise: 200000, approvalRequiredAbovePaise: 100000 }), clock);
    const proposal = createProposal(op.id, { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 300000, idempotency_key: 'passport-restrict', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: issued.payload.passportId, agent_id: 'officebot' }, 'MOCK', clock);
    expect(proposal.intent.state).toBe('BLOCKED');
    expect(proposal.evaluation.state).toBe('BLOCKED');
    expect(proposal.passportEvaluation.decision).toBe('BLOCKED');
    expect(proposal.passportEvaluation.checks.some((check) => check.reasonCode === 'TRANSACTION_LIMIT_EXCEEDED')).toBe(true);
    expect(proposal.decisionReceipt?.payload.decision).toBe('BLOCKED');
    expect(verifyDecisionReceipt(proposal.decisionReceipt!.signedToken).valid).toBe(true);
    expect(getLatestDecisionReceipt(proposal.intent.id, op.id)?.signedToken).toBe(proposal.decisionReceipt!.signedToken);
  });

  it('requires approval when either passport or server threshold requires it', () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput({ approvalRequiredAbovePaise: 100000 }), clock);
    const proposal = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-approval', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: issued.payload.passportId }, 'MOCK', clock);
    expect(proposal.intent.state).toBe('NEEDS_APPROVAL');
    expect(proposal.passportEvaluation.decision).toBe('NEEDS_APPROVAL');
    expect(proposal.evaluation.requiresApprovalReasons.length).toBeGreaterThan(0);
  });

  it('rejects a passport issued for a different payment adapter namespace', () => {
    const op = operator();
    process.env.PAYMENT_ADAPTER_MODE = 'MOCK';
    const issued = issuePassport(op.id, passportInput(), clock);
    const crossMode = createProposal(op.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'passport-cross-mode', source_mode: 'FIXTURE',
      fault_injection: 'NONE', passport_id: issued.payload.passportId,
    }, 'RAZORPAY_TEST', clock);
    expect(crossMode.intent.state).toBe('BLOCKED');
    expect(crossMode.passportEvaluation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'PASSPORT_PAYMENT_MODE_MISMATCH', status: 'FAIL' }),
    ]));
  });

  it('rejects replacing the passport or agent behind an existing intent idempotency key', () => {
    const op = operator();
    const firstPassport = issuePassport(op.id, passportInput({ agentId: 'first-agent' }), clock);
    const secondPassport = issuePassport(op.id, passportInput({ agentId: 'second-agent' }), clock);
    const request = {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'passport-replacement', source_mode: 'FIXTURE' as const,
      fault_injection: 'NONE' as const,
    };
    createProposal(op.id, { ...request, passport_id: firstPassport.payload.passportId, agent_id: 'first-agent' }, 'MOCK', clock);
    expect(() => createProposal(op.id, { ...request, passport_id: secondPassport.payload.passportId, agent_id: 'second-agent' }, 'MOCK', clock)).toThrow(/idempotency|different/i);
  });

  it('durably consumes passport usage and cumulative budget, including replay protection', async () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput({ maximumAmountPerTransactionPaise: 149900, cumulativeBudgetPaise: 149900, maximumUsageCount: 1, approvalRequiredAbovePaise: 149900 }), clock);
    const first = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-use-1', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: issued.payload.passportId }, 'MOCK', clock);
    const execution = new ExecutionService(new MockPaymentAdapter(), clock);
    const result = await execution.executeIntent(first.intent.id, op.id);
    expect(result.status).toBe('PAYMENT_CONFIRMED');
    const second = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-use-2', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: issued.payload.passportId }, 'MOCK', clock);
    expect(second.intent.state).toBe('BLOCKED');
    const db = createDrizzleClient(createSqliteConnection(dbPath));
    const usage = db.select().from(schema.passportUsages).where(eq(schema.passportUsages.passport_id, issued.payload.passportId)).all();
    expect(usage).toHaveLength(1);
    expect(usage[0].usage_status).toBe('CONFIRMED');
    expect(usage[0].amount_paise).toBe(149900);
    const replay = await execution.executeIntent(first.intent.id, op.id);
    expect(replay.status).toBe('PAYMENT_CONFIRMED');
    expect(db.select().from(schema.passportUsages).where(eq(schema.passportUsages.passport_id, issued.payload.passportId)).all()).toHaveLength(1);
  });

  it('checks ownership before returning an idempotent execution result', async () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput(), clock);
    const proposal = createProposal(op.id, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'passport-replay-owner', source_mode: 'FIXTURE',
      fault_injection: 'NONE', passport_id: issued.payload.passportId,
    }, 'MOCK', clock);
    const execution = new ExecutionService(new MockPaymentAdapter(), clock);
    await execution.executeIntent(proposal.intent.id, op.id);

    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    const otherOperatorId = 'operator-replay-attacker';
    db.insert(schema.operators).values({
      id: otherOperatorId,
      username: 'replay-attacker',
      password_hash: 'test-only-unused',
      created_at: clock.nowIso(),
    }).run();
    sqlite.close();

    await expect(execution.executeIntent(proposal.intent.id, otherOperatorId)).rejects.toThrow(/own|unauthor/i);
  });

  it('revocation after approval blocks execution without provider dispatch', async () => {
    const op = operator();
    const issued = issuePassport(op.id, passportInput({ approvalRequiredAbovePaise: 100000 }), clock);
    const proposal = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-revoke', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: issued.payload.passportId }, 'MOCK', clock);
    approveIntent(proposal.intent.id, op.id, 'test approval', clock);
    revokePassport(issued.payload.passportId, op.id, clock);
    let calls = 0;
    const adapter = new MockPaymentAdapter();
    const wrapped = { ...adapter, async createOrder(params: any) { calls++; return adapter.createOrder(params); } } as any;
    await expect(new ExecutionService(wrapped, clock).executeIntent(proposal.intent.id, op.id)).rejects.toThrow(/revoked|passport/i);
    expect(calls).toBe(0);
    const db = createDrizzleClient(createSqliteConnection(dbPath));
    expect(db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, proposal.intent.id)).get()!.state).toBe('BLOCKED');
  });

  it('expired and future not-before passports produce explicit fail-closed decisions', () => {
    const op = operator();
    const expired = issuePassport(op.id, passportInput({ expiresAt: '2026-01-01T00:00:00.000Z' }), clock);
    const expiredProposal = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-expired', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: expired.payload.passportId }, 'MOCK', clock);
    expect(expiredProposal.passportEvaluation.decision).toBe('EXPIRED');
    expect(expiredProposal.decisionReceipt?.payload.decision).toBe('EXPIRED');
    const future = issuePassport(op.id, passportInput({ agentId: 'futurebot', validFrom: '2026-10-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' }), clock);
    const futureProposal = createProposal(op.id, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'passport-future', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: future.payload.passportId, agent_id: 'futurebot' }, 'MOCK', clock);
    expect(futureProposal.passportEvaluation.decision).toBe('EXPIRED');
  });
});
