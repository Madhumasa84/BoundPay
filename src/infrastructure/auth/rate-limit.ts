import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_SECONDS = 60;

export function checkLoginRateLimit(identifier: string): { locked: boolean; lockedUntil?: string } {
  const { db } = getDb();
  const attempt = db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier)).get();
  
  if (!attempt || !attempt.locked_until) {
    return { locked: false };
  }

  const now = new Date();
  const lockedUntilDate = new Date(attempt.locked_until);

  if (now < lockedUntilDate) {
    return { locked: true, lockedUntil: attempt.locked_until };
  }

  return { locked: false };
}

export function recordFailedLogin(identifier: string): void {
  const { db } = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  const attempt = db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier)).get();

  if (!attempt) {
    db.insert(schema.loginAttempts).values({
      identifier,
      consecutive_failures: 1,
      locked_until: null,
      updated_at: nowIso,
    }).run();
    return;
  }

  const newFailures = attempt.consecutive_failures + 1;
  let lockedUntil: string | null = null;

  if (newFailures >= MAX_FAILED_ATTEMPTS) {
    lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_SECONDS * 1000).toISOString();
  }

  db.update(schema.loginAttempts)
    .set({
      consecutive_failures: newFailures,
      locked_until: lockedUntil,
      updated_at: nowIso,
    })
    .where(eq(schema.loginAttempts.identifier, identifier))
    .run();
}

export function recordSuccessfulLogin(identifier: string): void {
  const { db } = getDb();
  db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier)).run();
}
