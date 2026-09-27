import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { revokeSharedMandate } from '@/services/shared-authority.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    return jsonResponse(await revokeSharedMandate(auth.operator.operatorId));
  } catch (error) {
    return errorResponse(error);
  }
}
