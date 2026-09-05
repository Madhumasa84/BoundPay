import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getPassportPublicRecord, revokePassport } from '@/services/passport.service';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { id } = await params;
    const passport = revokePassport(id, auth.operator.operatorId);
    return jsonResponse({ passport: getPassportPublicRecord(passport) });
  } catch (error) {
    return errorResponse(error);
  }
}
