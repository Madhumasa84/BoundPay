import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { POST as intentProposalRoute } from '@/app/api/intents/route';
import { PUT as policyUpdateRoute } from '@/app/api/policy/route';
import { POST as approveRoute } from '@/app/api/intents/[id]/approve/route';
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

  it('Safely ignores or rejects client-supplied approval flags in proposal requests', async () => {
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
    expect(res.status).toBe(201);
    const data = await res.json();

    // The keyboard is 279,900 paise which requires approval (>250,000 paise).
    // Client-supplied "approved: true" MUST have been completely ignored!
    expect(data.intent.state).toBe('NEEDS_APPROVAL');
    expect(data.intent.unit_price_paise).toBe(279900); // trusted catalog price preserved!
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
});
