import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/infrastructure/db';
import { verifyPassword } from '@/infrastructure/auth/password';
import { buildSessionCookie, createOperatorSession, validateSameOrigin } from '@/infrastructure/auth/session';
import { checkLoginRateLimit, recordFailedLogin, recordSuccessfulLogin } from '@/infrastructure/auth/rate-limit';
import { appendAuditEvent } from '@/services/audit.service';
import { errorResponse, jsonResponse, readJsonBody } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  if (!validateSameOrigin(req)) {
    return jsonResponse({ error: 'Forbidden', message: 'Cross-origin request rejected' }, 403);
  }
  try {
    const body = await readJsonBody(req);
    const { username, password } = LoginSchema.parse(body);

    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    // The forwarded IP header can be supplied by a client unless a trusted
    // proxy strips it. Account lockout must not depend on that header.
    const rateLimitKey = username;

    const rateLimit = checkLoginRateLimit(rateLimitKey);
    if (rateLimit.locked) {
      return jsonResponse(
        {
          error: 'Too Many Requests',
          message: `Account is temporarily locked due to multiple failed login attempts. Try again after ${rateLimit.lockedUntil}`,
        },
        429
      );
    }

    const { db } = getDb();
    const operator = db.select().from(schema.operators).where(eq(schema.operators.username, username)).get();

    if (!operator) {
      recordFailedLogin(rateLimitKey);
      return jsonResponse({ error: 'Unauthorized', message: 'Invalid credentials' }, 401);
    }

    const passwordMatch = await verifyPassword(password, operator.password_hash);
    if (!passwordMatch) {
      recordFailedLogin(rateLimitKey);
      return jsonResponse({ error: 'Unauthorized', message: 'Invalid credentials' }, 401);
    }

    recordSuccessfulLogin(rateLimitKey);
    const session = createOperatorSession(operator.id);
    const cookieHeader = buildSessionCookie(session.token, session.expiresAt);

    appendAuditEvent({
      eventType: 'OPERATOR_LOGGED_IN',
      operatorId: operator.id,
      payload: { username: operator.username, ip },
    });

    return jsonResponse(
      {
        success: true,
        operator: {
          id: operator.id,
          username: operator.username,
        },
      },
      200,
      { 'Set-Cookie': cookieHeader }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
