import { errorResponse, jsonResponse, requireAuth, readJsonBody } from '@/app/api/api-helpers';
import { CreatePassportSchema, createAuthorityPassport, getPassportPublicRecord, listOwnedPassports } from '@/services/passport.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rejectOversized(req: Request): Response | null {
  const length = Number(req.headers.get('content-length') || 0);
  return length > 128 * 1024 ? jsonResponse({ error: 'Payload Too Large', message: 'Passport payload exceeds the 128KB limit' }, 413) : null;
}

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    return jsonResponse({ passports: listOwnedPassports(auth.operator.operatorId).map(getPassportPublicRecord) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  const oversized = rejectOversized(req);
  if (oversized) return oversized;
  try {
    const body = await readJsonBody(req);
    const input = CreatePassportSchema.parse(body);
    const passport = createAuthorityPassport(auth.operator.operatorId, input);
    return jsonResponse({ passport: getPassportPublicRecord(passport) }, input.idempotencyKey ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
