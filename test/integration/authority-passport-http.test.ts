import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { POST as passportCreateRoute, GET as passportListRoute } from '@/app/api/passports/route';
import { GET as passportGetRoute } from '@/app/api/passports/[id]/route';
import { POST as passportRevokeRoute } from '@/app/api/passports/[id]/revoke/route';
import { POST as passportVerifyRoute } from '@/app/api/passports/verify/route';
import { POST as intentRoute } from '@/app/api/intents/route';
import { GET as receiptRoute } from '@/app/api/intents/[id]/receipt/route';
import { GET as proofRoute } from '@/app/api/intents/[id]/proof/route';
import { createOperatorSession, resetAuthClock, setAuthClock } from '@/infrastructure/auth/session';
import { closeDefaultDb, createDrizzleClient, createSqliteConnection, getDb, schema } from '@/infrastructure/db';
import { seedDatabase } from '@/infrastructure/db/seed';
import { TestClock } from '@/infrastructure/clock/clock';

describe('Authority Passport authenticated HTTP boundary', () => {
  let dbPath: string;
  let ownerId: string;
  let otherOwnerId: string;
  let ownerToken: string;
  let otherToken: string;
  const clock = new TestClock('2026-09-03T12:00:00.000Z');

  beforeEach(() => {
    process.env.AUTHORITY_TEST_MODE = 'true';
    process.env.AUTHORITY_SIGNING_KEY_ID = 'test-only-key-v1';
    process.env.AUTHORITY_ISSUER = 'boundpay-test-authority';
    process.env.AUTHORITY_AUDIENCE = 'boundpay-agent';
    dbPath = path.resolve(process.cwd(), 'data/test', `passport-http-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    closeDefaultDb();
    setAuthClock(clock);
    seedDatabase(dbPath);
    const { db } = getDb();
    ownerId = db.select().from(schema.operators).get()!.id;
    otherOwnerId = `operator-${cryptoRandomSuffix()}`;
    db.insert(schema.operators).values({ id: otherOwnerId, username: `other-${cryptoRandomSuffix()}`, password_hash: 'test', created_at: clock.nowIso() }).run();
    ownerToken = createOperatorSession(ownerId, clock).token;
    otherToken = createOperatorSession(otherOwnerId, clock).token;
  });

  afterEach(() => {
    resetAuthClock();
    closeDefaultDb();
    for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  });

  function cryptoRandomSuffix() { return Math.random().toString(36).slice(2, 10); }
  function request(method: string, url: string, token?: string, body?: unknown, contentLength?: string): Request {
    const headers: Record<string, string> = { Host: 'localhost:3000', Origin: 'http://localhost:3000' };
    if (token) headers.Cookie = `boundpay_session=${token}`;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (contentLength) headers['Content-Length'] = contentLength; }
    return new Request(`http://localhost:3000${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  function passportBody(agentId = 'http-agent') {
    return { agentId, agentDisplayName: 'HTTP Agent', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics', 'books'], maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000, approvalRequiredAbovePaise: 300000, expiresAt: '2099-01-01T00:00:00.000Z', maximumUsageCount: 10, idempotencyKey: `http-${agentId}` };
  }

  it('requires authentication and same-origin for every passport mutation', async () => {
    expect((await passportListRoute(request('GET', '/api/passports'))).status).toBe(401);
    expect((await passportCreateRoute(request('POST', '/api/passports', undefined, passportBody()))).status).toBe(401);
    const csrf = request('POST', '/api/passports', ownerToken, passportBody('csrf-agent'));
    csrf.headers.set('Origin', 'http://evil.example');
    expect((await passportCreateRoute(csrf)).status).toBe(403);
    expect((await passportRevokeRoute(request('POST', '/api/passports/pass_missing/revoke', ownerToken), { params: Promise.resolve({ id: 'pass_missing' }) })).status).toBe(404);
  });

  it('creates, lists, verifies, exports a proof bundle, and preserves sanitized fields only', async () => {
    const created = await passportCreateRoute(request('POST', '/api/passports', ownerToken, passportBody()));
    expect([200, 201]).toContain(created.status);
    const createdData = await created.json();
    const record = createdData.passport;
    expect(record.status).toBe('ACTIVE');
    expect(record.signature.algorithm).toBe('EdDSA');
    expect(JSON.stringify(createdData)).not.toMatch(/PRIVATE KEY|privateKeyPem|AUTHORITY_SIGNING_PRIVATE_KEY/);
    const listed = await passportListRoute(request('GET', '/api/passports', ownerToken));
    expect(listed.status).toBe(200);
    expect((await listed.json()).passports.some((item: any) => item.passportId === record.passportId)).toBe(true);
    const verified = await passportVerifyRoute(request('POST', '/api/passports/verify', ownerToken, { signedPassport: record.signedToken }));
    expect(verified.status).toBe(200);
    expect((await verified.json()).valid).toBe(true);
    const fetched = await passportGetRoute(request('GET', `/api/passports/${record.passportId}`, ownerToken), { params: Promise.resolve({ id: record.passportId }) });
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).passport.passportId).toBe(record.passportId);
  });

  it('binds passport, intent, receipt, and proof endpoints to the owner (horizontal IDOR denied)', async () => {
    const created = await passportCreateRoute(request('POST', '/api/passports', ownerToken, passportBody('idor-agent')));
    const record = (await created.json()).passport;
    const forgedVerify = await passportVerifyRoute(request('POST', '/api/passports/verify', otherToken, { signedPassport: record.signedToken }));
    expect(forgedVerify.status).toBe(404);
    const crossPassport = await passportGetRoute(request('GET', `/api/passports/${record.passportId}`, otherToken), { params: Promise.resolve({ id: record.passportId }) });
    expect(crossPassport.status).toBe(404);
    const proposalResponse = await intentRoute(request('POST', '/api/intents', ownerToken, { product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000, idempotency_key: 'http-receipt-intent', source_mode: 'FIXTURE', fault_injection: 'NONE', passport_id: record.passportId, agent_id: 'idor-agent' }));
    expect(proposalResponse.status).toBe(201);
    const proposal = await proposalResponse.json();
    const crossReceipt = await receiptRoute(request('GET', `/api/intents/${proposal.intent.id}/receipt`, otherToken), { params: Promise.resolve({ id: proposal.intent.id }) });
    expect(crossReceipt.status).toBe(404);
    const crossProof = await proofRoute(request('GET', `/api/intents/${proposal.intent.id}/proof`, otherToken), { params: Promise.resolve({ id: proposal.intent.id }) });
    expect(crossProof.status).toBe(404);
    const proof = await proofRoute(request('GET', `/api/intents/${proposal.intent.id}/proof`, ownerToken), { params: Promise.resolve({ id: proposal.intent.id }) });
    expect(proof.status).toBe(200);
    const proofData = await proof.json();
    expect(proofData.verificationKey.kty).toBe('OKP');
    expect(proofData.keyFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proofData)).not.toMatch(/PRIVATE KEY|privateKeyPem|AUTHORITY_SIGNING_PRIVATE_KEY/);
  });

  it('returns controlled errors for malformed, oversized, altered, and duplicate requests', async () => {
    const oversized = await passportCreateRoute(request('POST', '/api/passports', ownerToken, passportBody('oversized'), '200000'));
    expect(oversized.status).toBe(413);
    const malformed = await passportVerifyRoute(request('POST', '/api/passports/verify', ownerToken, { signedPassport: 'a.b.c' }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).stack).toBeUndefined();
    const created = await passportCreateRoute(request('POST', '/api/passports', ownerToken, passportBody('revoke-http')));
    const record = (await created.json()).passport;
    const altered = `${record.signedToken.slice(0, -1)}${record.signedToken.endsWith('a') ? 'b' : 'a'}`;
    const alteredResponse = await passportVerifyRoute(request('POST', '/api/passports/verify', ownerToken, { signedPassport: altered }));
    expect(alteredResponse.status).toBe(400);
    const revokeOne = await passportRevokeRoute(request('POST', `/api/passports/${record.passportId}/revoke`, ownerToken), { params: Promise.resolve({ id: record.passportId }) });
    const revokeTwo = await passportRevokeRoute(request('POST', `/api/passports/${record.passportId}/revoke`, ownerToken), { params: Promise.resolve({ id: record.passportId }) });
    expect(revokeOne.status).toBe(200);
    expect(revokeTwo.status).toBe(200);
    expect((await revokeTwo.json()).passport.status).toBe('REVOKED');
  });

  it('rejects missing passports, non-JSON and lifecycle mass-assignment, and marks private responses non-cacheable', async () => {
    const missingPassport = await intentRoute(request('POST', '/api/intents', ownerToken, {
      product_id: 'prod_mouse', quantity: 1, purchase_budget_paise: 200000,
      idempotency_key: 'http-missing-passport', source_mode: 'FIXTURE', fault_injection: 'NONE',
    }));
    expect(missingPassport.status).toBe(400);

    const massAssigned = await passportCreateRoute(request('POST', '/api/passports', ownerToken, {
      ...passportBody('mass-assignment'), status: 'ACTIVE', revokedAt: null, usageCount: 0,
    }));
    expect(massAssigned.status).toBe(400);

    const wrongType = request('POST', '/api/passports', ownerToken, passportBody('wrong-content-type'));
    wrongType.headers.set('Content-Type', 'text/plain');
    expect((await passportCreateRoute(wrongType)).status).toBe(415);

    const listed = await passportListRoute(request('GET', '/api/passports', ownerToken));
    expect(listed.headers.get('cache-control')).toMatch(/no-store/i);
  });
});
