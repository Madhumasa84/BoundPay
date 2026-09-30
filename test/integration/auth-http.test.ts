import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { POST as intentProposalRoute } from '@/app/api/intents/route';
import { PUT as policyUpdateRoute } from '@/app/api/policy/route';
import { POST as approveRoute } from '@/app/api/intents/[id]/approve/route';
import { POST as declineRoute } from '@/app/api/intents/[id]/decline/route';
import { POST as executeRoute } from '@/app/api/intents/[id]/execute/route';
import { POST as confirmRoute } from '@/app/api/intents/[id]/confirm-payment/route';
import { POST as addProductRoute } from '@/app/api/catalog/route';
import { PUT as updateProductRoute } from '@/app/api/catalog/[id]/route';
import { POST as agentRoute } from '@/app/api/agent/propose/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { seedDatabase } from '@/infrastructure/db/seed';
import { createOperatorSession, setAuthClock, resetAuthClock } from '@/infrastructure/auth/session';
import { getDb, schema, closeDefaultDb } from '@/infrastructure/db';
import { TestClock } from '@/infrastructure/clock/clock';

describe('Authentication and HTTP Security Route Tests', () => {
  const testDbDir = path.resolve(process.cwd(), 'data/test');
  let testDbPath: string;
  let clock: TestClock;

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    closeDefaultDb();
    testDbPath = path.resolve(testDbDir, `test-http-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.sqlite`);
    clock = new TestClock('2026-09-03T12:00:00.000Z');
    setAuthClock(clock);
    process.env.DATABASE_PATH = testDbPath;
    seedDatabase(testDbPath);
  });

  afterEach(() => {
    resetAuthClock();
    closeDefaultDb();
    try {
      const files = [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`];
      for (const f of files) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch {}
  });

  it('Rejects unauthenticated writes (POST /api/intents) with 401', async () => {
    const req = new Request('http://localhost:3000/api/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'unauth-key-1',
      }),
    });

    const res = await intentProposalRoute(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('Rejects cross-origin state-changing requests with 403 Forbidden', async () => {
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);

    const req = new Request('http://localhost:3000/api/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        Origin: 'http://evil-attacker.com', // Cross-origin attacker
        Cookie: `boundpay_session=${session.token}`,
      },
      body: JSON.stringify({
        product_id: 'prod_mouse',
        quantity: 1,
        purchase_budget_paise: 200000,
        idempotency_key: 'csrf-key-1',
      }),
    });

    const res = await intentProposalRoute(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('Rejects expired or forged session tokens with 401', async () => {
    // 1. Forged token
    const reqForged = new Request('http://localhost:3000/api/auth/me', {
      method: 'GET',
      headers: {
        Cookie: 'boundpay_session=invalid_forged_token_1234567890',
      },
    });
    const resForged = await meRoute(reqForged);
    expect(resForged.status).toBe(401);

    // 2. Expired session
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);

    // Advance clock past session lifetime (24 hours)
    clock.advanceDays(2);

    const reqExpired = new Request('http://localhost:3000/api/auth/me', {
      method: 'GET',
      headers: {
        Cookie: `boundpay_session=${session.token}`,
      },
    });
    const resExpired = await meRoute(reqExpired);
    expect(resExpired.status).toBe(401);
  });

  it('rejects a session at its exact expiry time', async () => {
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);
    clock.setTime(session.expiresAt);
    const res = await meRoute(new Request('http://localhost:3000/api/auth/me', {
      headers: { Cookie: `boundpay_session=${session.token}` },
    }));
    expect(res.status).toBe(401);
  });

  it('rejects malformed session cookies without throwing', async () => {
    const res = await meRoute(new Request('http://localhost:3000/api/auth/me', {
      headers: { Cookie: 'boundpay_session=%E0%A4%A' },
    }));
    expect(res.status).toBe(401);
  });

  it('authenticates with a valid session despite a malformed unrelated cookie', async () => {
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);
    const res = await meRoute(new Request('http://localhost:3000/api/auth/me', {
      headers: { Cookie: `other=%E0%A4%A; boundpay_session=${session.token}` },
    }));
    expect(res.status).toBe(200);
  });

  it('returns a validation error for malformed login JSON', async () => {
    const res = await loginRoute(new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));
    expect(res.status).toBe(400);
  });

  it('rejects client-supplied approval flags and trusted-price mass assignment', async () => {
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);

    // Client maliciously attempts to inject approved: true and custom price into keyboard proposal
    const req = new Request('http://localhost:3000/api/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        Origin: 'http://localhost:3000',
        Cookie: `boundpay_session=${session.token}`,
      },
      body: JSON.stringify({
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 300000,
        idempotency_key: 'tampered-approval-flag-key',
        // Malicious client fields:
        approved: true,
        state: 'APPROVED',
        unit_price_paise: 100, // Attempting to alter price
      }),
    });

    const res = await intentProposalRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Validation Error');
    expect(db.select().from(schema.purchaseIntents).all()).toHaveLength(0);
  });

  it('Returns controlled error messages without stack traces on invalid payloads', async () => {
    const { db } = getDb();
    const operator = db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);

    // Malformed body: negative budget, invalid quantity 0
    const req = new Request('http://localhost:3000/api/intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        Origin: 'http://localhost:3000',
        Cookie: `boundpay_session=${session.token}`,
      },
      body: JSON.stringify({
        product_id: 'prod_keyboard',
        quantity: 0, // illegal
        purchase_budget_paise: -500, // illegal
        idempotency_key: 'invalid-payload-key',
      }),
    });

    const res = await intentProposalRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();

    expect(data.error).toBe('Validation Error');
    expect(data.details).toBeDefined();
    // Verify no secret internal stack traces leaked
    expect(data.stack).toBeUndefined();
  });

  const params = { params: Promise.resolve({ id: 'nonexistent' }) };
  const writers = [
    { name: 'policy', method: 'PUT', call: policyUpdateRoute },
    { name: 'catalog add', method: 'POST', call: addProductRoute },
    { name: 'catalog update', method: 'PUT', call: (req: Request) => updateProductRoute(req, params) },
    { name: 'agent', method: 'POST', call: agentRoute },
    { name: 'approve', method: 'POST', call: (req: Request) => approveRoute(req, params) },
    { name: 'decline', method: 'POST', call: (req: Request) => declineRoute(req, params) },
    { name: 'execute', method: 'POST', call: (req: Request) => executeRoute(req, params) },
    { name: 'confirm', method: 'POST', call: (req: Request) => confirmRoute(req, params) },
  ];

  function authenticatedRequest(method: string, body: string) {
    const operator = getDb().db.select().from(schema.operators).get()!;
    const session = createOperatorSession(operator.id, clock);
    return new Request('http://localhost:3000/api/review', {
      method, headers: { 'Content-Type': 'application/json', Cookie: `boundpay_session=${session.token}` }, body,
    });
  }

  it.each(writers)('$name rejects malformed JSON before taking action', async ({ method, call }) => {
    const res = await call(authenticatedRequest(method, '{'));
    expect(res.status).toBe(400);
  });

  it.each(writers)('$name rejects oversized JSON before taking action', async ({ method, call }) => {
    const res = await call(authenticatedRequest(method, JSON.stringify({ content: 'x'.repeat(128 * 1024) })));
    expect(res.status).toBe(413);
  });

  it.each(writers.filter(({ name }) => ['approve', 'decline', 'execute'].includes(name)))('$name rejects an invalid optional payload', async ({ method, call }) => {
    const res = await call(authenticatedRequest(method, 'null'));
    expect(res.status).toBe(400);
  });

  it('rejects same-host requests from a different scheme', async () => {
    const req = authenticatedRequest('PUT', '{}');
    req.headers.set('Host', 'localhost:3000');
    req.headers.set('Origin', 'https://localhost:3000');
    expect((await policyUpdateRoute(req)).status).toBe(403);
  });

  it('uses the HTTP host when Next.js synthesizes a different request hostname', async () => {
    const req = authenticatedRequest('POST', '{}');
    req.headers.set('Host', '127.0.0.1:3000');
    req.headers.set('Origin', 'http://127.0.0.1:3000');
    // The empty login object is invalid JSON schema; a valid origin gets 400.
    expect((await loginRoute(req)).status).toBe(400);
  });

  it('rejects cross-origin login and logout without revoking the session', async () => {
    const req = authenticatedRequest('POST', '{}');
    req.headers.set('Origin', 'http://attacker.example');
    expect((await loginRoute(req)).status).toBe(403);
    expect((await logoutRoute(req)).status).toBe(403);
    const me = new Request('http://localhost:3000/api/auth/me', { headers: { Cookie: req.headers.get('cookie')! } });
    expect((await meRoute(me)).status).toBe(200);
  });

  it('does not let forwarded IP spoofing bypass the account lockout', async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const req = new Request('http://localhost:3000/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `192.0.2.${attempt}` },
        body: JSON.stringify({ username: 'operator', password: 'incorrect-test-password' }),
      });
      const res = await loginRoute(req);
      expect(res.status).toBe(attempt < 5 ? 401 : 429);
    }
  });
});
