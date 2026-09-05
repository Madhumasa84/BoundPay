import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';
import { createAuthorityPassport, getLatestDecisionReceipt, getPassportById, revokePassport, verifyStoredPassport } from '@/services/passport.service';
import { createProposal } from '@/services/purchase.service';
import { AuthorityVerificationError, getAuthorityConfig, signDecisionReceiptSync, signPassportSync, verifyDecisionReceiptSync, verifyPassportSync, verifySignedToken, verifySignedTokenOffline } from '@/infrastructure/authority/signing';

describe('Authority Passport cryptographic and ownership fail-closed tests', () => {
  let dbPath: string;
  let operatorId: string;
  let otherOperatorId: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  const input = (overrides: Record<string, unknown> = {}) => ({
    agentId: 'security-agent', agentDisplayName: 'Security Agent', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics', 'books'],
    maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000, approvalRequiredAbovePaise: 250000,
    validFrom: '2000-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 10, ...overrides,
  });

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    closeDefaultDb();
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-security-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    seedDatabase(dbPath);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    const operators = db.select().from(schema.operators).all();
    operatorId = operators[0].id;
    otherOperatorId = crypto.randomUUID();
    db.insert(schema.operators).values({ id: otherOperatorId, username: `other-${Date.now()}`, password_hash: 'test', created_at: clock.nowIso() }).run();
    sqlite.close();
  });

  afterEach(() => {
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    delete process.env.AUTHORITY_SIGNING_PUBLIC_KEY;
    delete process.env.AUTHORITY_SIGNING_PRIVATE_KEY;
    delete process.env.AUTHORITY_VERIFICATION_KEYS_JSON;
  });

  it('verifies valid EdDSA, rejects altered payload/signature, wrong key, wrong kid, alg none, and malformed JWS', () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    const [header, encodedPayload, signature] = passport.signedToken.split('.');
    const alteredPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()), agentDisplayName: 'Tampered' })).toString('base64url');
    expect(() => verifyPassportSync(`${header}.${alteredPayload}.${signature}`)).toThrow(AuthorityVerificationError);
    expect(() => verifyPassportSync(`${header}.${encodedPayload}.${signature.slice(0, -2)}aa`)).toThrow(AuthorityVerificationError);
    const alternate = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    process.env.AUTHORITY_SIGNING_PUBLIC_KEY = alternate;
    expect(() => verifyPassportSync(passport.signedToken)).toThrow(AuthorityVerificationError);
    delete process.env.AUTHORITY_SIGNING_PUBLIC_KEY;
    process.env.AUTHORITY_SIGNING_KEY_ID = 'unknown-key';
    expect(() => verifyPassportSync(passport.signedToken)).toThrow(/key ID/i);
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-only-key-v1', typ: 'boundpay-authority-passport+jwt' })).toString('base64url');
    expect(() => verifyPassportSync(`${noneHeader}.${encodedPayload}.`)).toThrow();
    expect(() => verifyPassportSync('not.a.valid.jws')).toThrow();
  });

  it('rejects issuer, audience, expiry, and future not-before mismatches', () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    process.env.AUTHORITY_ISSUER = 'wrong-issuer';
    expect(() => verifyPassportSync(passport.signedToken)).toThrow(/issuer/i);
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'wrong-audience';
    expect(() => verifyPassportSync(passport.signedToken)).toThrow(/audience/i);
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    const expired = { ...passport.payload, expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(() => verifyPassportSync(signPassportSync(expired))).toThrow(/validity|outside/i);
    const future = { ...passport.payload, validFrom: '2098-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
    expect(() => verifyPassportSync(signPassportSync(future))).toThrow(/validity|outside/i);
  });

  it('binds passport and receipt access to the authenticated owner and agent', () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    expect(() => getPassportById(passport.payload.passportId, otherOperatorId)).toThrow(/not found/i);
    expect(() => createAuthorityPassport('forged-owner', input(), clock)).toThrow(/operator/i);
    expect(() => createProposal(operatorId, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'agent-forge', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passport.payload.passportId, agent_id: 'attacker' }, 'MOCK', clock)).toThrow(/verification|agent/i);
    const proposal = createProposal(operatorId, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'receipt-owner', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passport.payload.passportId }, 'MOCK', clock);
    expect(() => getLatestDecisionReceipt(proposal.intent.id, otherOperatorId)).toThrow(/not found/i);
  });

  it('detects database payload/signature alteration, duplicate revocation, and idempotent issuance', () => {
    const first = createAuthorityPassport(operatorId, input({ idempotencyKey: 'same-passport-request' }), clock);
    const replay = createAuthorityPassport(operatorId, input({ idempotencyKey: 'same-passport-request' }), clock);
    expect(replay.payload.passportId).toBe(first.payload.passportId);
    const sqlite = createSqliteConnection(dbPath);
    const db = createDrizzleClient(sqlite);
    db.update(schema.authorityPassports).set({ payload_json: JSON.stringify({ ...first.payload, agentId: 'tampered' }) }).where(eq(schema.authorityPassports.id, first.payload.passportId)).run();
    sqlite.close();
    const corrupted = getPassportById(first.payload.passportId, operatorId)!;
    expect(() => verifyStoredPassport(corrupted, operatorId)).toThrow(/binding|digest|verification/i);
    closeDefaultDb();
    const restored = createAuthorityPassport(operatorId, input({ agentId: 'restored', idempotencyKey: 'restored-passport' }), clock);
    const revoked = revokePassport(restored.payload.passportId, operatorId, clock);
    expect(revoked.status).toBe('REVOKED');
    expect(revokePassport(restored.payload.passportId, operatorId, clock).status).toBe('REVOKED');
  });

  it('verifies an immutable signed decision receipt offline and rejects any altered receipt', () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    const proposal = createProposal(operatorId, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'receipt-integrity', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passport.payload.passportId }, 'MOCK', clock);
    const receipt = proposal.decisionReceipt!;
    expect(verifyDecisionReceiptSync(receipt.signedToken).intentId).toBe(proposal.intent.id);
    const [header, payload, signature] = receipt.signedToken.split('.');
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), totalAmountPaise: 1 })).toString('base64url');
    expect(() => verifyDecisionReceiptSync(`${header}.${altered}.${signature}`)).toThrow();
    expect(() => verifyDecisionReceiptSync(`${header}.${payload}.${signature.slice(0, -1)}a`)).toThrow();
  });

  it('checks custom issuer/audience claims in both server-bound and offline JOSE verification', async () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    const config = getAuthorityConfig();
    await expect(verifySignedToken(passport.signedToken, 'passport')).resolves.toMatchObject({ passportId: passport.payload.passportId });
    await expect(verifySignedTokenOffline(passport.signedToken, 'passport', config.publicKeyPem, { issuer: config.issuer, audience: config.audience })).resolves.toMatchObject({ passportId: passport.payload.passportId });
    await expect(verifySignedTokenOffline(passport.signedToken, 'passport', config.publicKeyPem, { audience: 'wrong-audience' })).rejects.toThrow(/issuer|audience/i);
  });

  it('rejects header confusion, malformed encodings, token-role swaps, embedded keys, unsafe kid, and oversized input', () => {
    const passport = createAuthorityPassport(operatorId, input(), clock);
    const proposal = createProposal(operatorId, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'crypto-role-swap', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: passport.payload.passportId }, 'MOCK', clock);
    const receipt = proposal.decisionReceipt!;
    const [, payload, signature] = passport.signedToken.split('.');
    const header = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');

    expect(() => verifyPassportSync(`${header({ alg: 'HS256', kid: passport.payload.keyId, typ: 'boundpay-authority-passport+jwt' })}.${payload}.${signature}`)).toThrow();
    expect(() => verifyPassportSync(`${header({ alg: 'EdDSA', kid: passport.payload.keyId, typ: 'boundpay-decision-receipt+jwt' })}.${payload}.${signature}`)).toThrow();
    expect(() => verifyPassportSync(`${header({ alg: 'EdDSA', kid: '../test-only-key-v1', typ: 'boundpay-authority-passport+jwt' })}.${payload}.${signature}`)).toThrow();
    expect(() => verifyPassportSync(`${header({ alg: 'EdDSA', kid: 'attacker', typ: 'boundpay-authority-passport+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'untrusted' } })}.${payload}.${signature}`)).toThrow(/key|signature|unsupported/i);
    expect(() => verifyPassportSync(`*.${payload}.${signature}`)).toThrow(/malformed/i);
    expect(() => verifyPassportSync(passport.signedToken.split('.').slice(0, 2).join('.'))).toThrow(/malformed/i);
    expect(() => verifyPassportSync(`${passport.signedToken}.extra`)).toThrow(/malformed/i);
    expect(() => verifyPassportSync('a'.repeat(32769))).toThrow(/malformed/i);
    expect(() => verifyPassportSync(receipt.signedToken)).toThrow(/type|unsupported/i);
    expect(() => verifyDecisionReceiptSync(passport.signedToken)).toThrow(/type|unsupported/i);
    expect(() => verifyPassportSync(signDecisionReceiptSync(passport.payload as any))).toThrow(/type|unsupported/i);
    expect(() => verifyDecisionReceiptSync(signPassportSync(receipt.payload as any))).toThrow(/type|unsupported/i);
  });

  it('supports retained verification keys and fails closed once an old kid is retired', () => {
    const template = createAuthorityPassport(operatorId, input(), clock);
    const oldPair = crypto.generateKeyPairSync('ed25519');
    const oldPrivate = oldPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const oldPublic = oldPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    process.env.AUTHORITY_SIGNING_KEY_ID = 'retained-old-key';
    process.env.AUTHORITY_SIGNING_PRIVATE_KEY = oldPrivate;
    process.env.AUTHORITY_SIGNING_PUBLIC_KEY = oldPublic;
    const oldPayload = { ...template.payload, keyId: 'retained-old-key' };
    const oldToken = signPassportSync(oldPayload);

    delete process.env.AUTHORITY_SIGNING_PRIVATE_KEY;
    delete process.env.AUTHORITY_SIGNING_PUBLIC_KEY;
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_VERIFICATION_KEYS_JSON = JSON.stringify({ 'retained-old-key': oldPublic });
    expect(verifyPassportSync(oldToken).keyId).toBe('retained-old-key');

    delete process.env.AUTHORITY_VERIFICATION_KEYS_JSON;
    expect(() => verifyPassportSync(oldToken)).toThrow(/unknown.*key|key ID/i);
  });
});
