import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getSharedAuthorityLabel, getSharedAuthorityMode } from '@/infrastructure/shared-authority/config';
import { querySharedMandate } from '@/services/shared-authority.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const mode = getSharedAuthorityMode();
    if (mode !== 'DRUNIX') {
      return jsonResponse({
        mode,
        label: getSharedAuthorityLabel(),
        networkConnected: false,
        message: mode === 'SIMULATED'
          ? 'SIMULATED is a local-only ledger label and cannot authorize payment dispatch.'
          : 'Shared authorization is disabled. Payment mode is configured independently.',
      });
    }
    return jsonResponse({ mode, label: getSharedAuthorityLabel(), networkConnected: true, ...(await querySharedMandate()) });
  } catch (error) {
    return errorResponse(error);
  }
}
