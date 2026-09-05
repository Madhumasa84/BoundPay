import { z } from 'zod';
import { errorResponse, jsonResponse, requireAuth, readJsonBody } from '@/app/api/api-helpers';
import { verifyStoredPassport, getPassportById } from '@/services/passport.service';
import { verifyPassportSync } from '@/infrastructure/authority/signing';

export const runtime = 'nodejs';

const VerifySchema = z.object({ signedPassport: z.string().min(1).max(32768) });

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const body = VerifySchema.parse(await readJsonBody(req, 64 * 1024));
    const payload = verifyPassportSync(body.signedPassport);
    const stored = getPassportById(payload.passportId, auth.operator.operatorId);
    if (!stored) return jsonResponse({ valid: false, message: 'Passport is not owned by the authenticated operator' }, 403);
    verifyStoredPassport(stored, auth.operator.operatorId, payload.agentId);
    return jsonResponse({ valid: true, passport: payload, passportPayloadDigest: stored.payloadDigest, keyId: payload.keyId });
  } catch (error) {
    return errorResponse(error);
  }
}
