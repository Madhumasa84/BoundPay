import crypto from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { Clock, defaultClock } from '../clock/clock';

export const SESSION_COOKIE_NAME = 'boundpay_session';
export const SESSION_DURATION_SECONDS = 24 * 60 * 60; // 24 hours

export interface OperatorSession {
  sessionId: string;
  operatorId: string;
  username: string;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

let currentAuthClock: Clock = defaultClock;

export function setAuthClock(clock: Clock): void {
  currentAuthClock = clock;
}

export function resetAuthClock(): void {
  currentAuthClock = defaultClock;
}

export function createOperatorSession(
  operatorId: string,
  clock: Clock = currentAuthClock
): { token: string; expiresAt: string } {
  const { db } = getDb();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1000).toISOString();

  db.insert(schema.operatorSessions).values({
    id: crypto.randomUUID(),
    operator_id: operatorId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_at: now.toISOString(),
    revoked_at: null,
  }).run();

  return { token, expiresAt };
}

export function validateSessionToken(
  token: string,
  clock: Clock = currentAuthClock
): OperatorSession | null {
  if (!token) return null;
  const { db } = getDb();
  const tokenHash = hashSessionToken(token);
  const nowIso = clock.nowIso();

  const sessionRecord = db
    .select({
      sessionId: schema.operatorSessions.id,
      operatorId: schema.operatorSessions.operator_id,
      expiresAt: schema.operatorSessions.expires_at,
      revokedAt: schema.operatorSessions.revoked_at,
      username: schema.operators.username,
    })
    .from(schema.operatorSessions)
    .innerJoin(schema.operators, eq(schema.operatorSessions.operator_id, schema.operators.id))
    .where(
      and(
        eq(schema.operatorSessions.token_hash, tokenHash),
        isNull(schema.operatorSessions.revoked_at)
      )
    )
    .get();

  if (!sessionRecord) {
    return null;
  }

  if (sessionRecord.expiresAt < nowIso) {
    return null;
  }

  return {
    sessionId: sessionRecord.sessionId,
    operatorId: sessionRecord.operatorId,
    username: sessionRecord.username,
  };
}

export function revokeSessionToken(token: string, clock: Clock = defaultClock): boolean {
  if (!token) return false;
  const { db } = getDb();
  const tokenHash = hashSessionToken(token);
  const nowIso = clock.nowIso();

  const result = db
    .update(schema.operatorSessions)
    .set({ revoked_at: nowIso })
    .where(eq(schema.operatorSessions.token_hash, tokenHash))
    .run();

  return result.changes > 0;
}

/**
 * Parses cookies from Cookie header.
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  }
  return cookies;
}

/**
 * Validates request same-origin to prevent CSRF on state-changing operations.
 */
export function validateSameOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');

  if (!origin) {
    // If no origin, check referer
    const referer = req.headers.get('referer');
    if (!referer) {
      // In non-browser automated integration tests or curl, Sec-Fetch-Site might be absent
      // But reject if Sec-Fetch-Site indicates cross-site
      const secFetchSite = req.headers.get('sec-fetch-site');
      if (secFetchSite === 'cross-site') {
        return false;
      }
      return true;
    }
    try {
      const refererUrl = new URL(referer);
      return refererUrl.host === host;
    } catch {
      return false;
    }
  }

  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch {
    return false;
  }
}

/**
 * Extracts and authenticates operator from an incoming Request.
 * Returns operator or null if unauthorized.
 */
export function authenticateRequest(req: Request, clock: Clock = currentAuthClock): OperatorSession | null {
  const cookieHeader = req.headers.get('cookie');
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return validateSessionToken(token, clock);
}

/**
 * Builds standard Set-Cookie string for the session.
 */
export function buildSessionCookie(token: string, expiresAtIso: string, isProduction = process.env.NODE_ENV === 'production'): string {
  const expires = new Date(expiresAtIso).toUTCString();
  const secure = isProduction ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax${secure}`;
}

export function buildLogoutCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;
}
