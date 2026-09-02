import { getIntentById } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const intent = getIntentById(params.id, auth.operator.operatorId);
    if (!intent) {
      return jsonResponse({ error: 'Not Found', message: `Intent '${params.id}' not found` }, 404);
    }
    return jsonResponse({ intent });
  } catch (err) {
    return errorResponse(err);
  }
}
