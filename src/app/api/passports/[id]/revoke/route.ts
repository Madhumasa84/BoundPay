import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getPassportPublicRecord, revokePassport } from '@/services/passport.service';
import { revokeSharedMandateForPassport } from '@/services/shared-authority.service';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { id } = await params;
    const passport = revokePassport(id, auth.operator.operatorId);
    try {
      const shared = await revokeSharedMandateForPassport(auth.operator.operatorId, id);
      return jsonResponse({ passport: getPassportPublicRecord(passport), sharedRevocation: shared.revoked ? { status: 'COMMITTED', transactionId: shared.transactionId } : { status: 'NOT_CONFIGURED' } });
    } catch (error) {
      return jsonResponse({
        passport: getPassportPublicRecord(passport),
        sharedRevocation: { status: 'PENDING', message: error instanceof Error ? error.message : 'Drunix revocation is pending' },
      }, 503);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
