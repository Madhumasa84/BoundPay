import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getPassportById, getPassportPublicRecord, PassportNotFoundError } from '@/services/passport.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { id } = await params;
    const passport = getPassportById(id, auth.operator.operatorId);
    if (!passport) throw new PassportNotFoundError('Authority passport not found');
    return jsonResponse({ passport: getPassportPublicRecord(passport) });
  } catch (error) {
    return errorResponse(error);
  }
}
