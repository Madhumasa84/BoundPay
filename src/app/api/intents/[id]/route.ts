import { getIntentById } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    const intent = getIntentById(id, auth.operator.operatorId);
    if (!intent) {
      return jsonResponse({ error: 'Not Found', message: `Intent '${id}' not found` }, 404);
    }
    return jsonResponse({ intent });
  } catch (err) {
    return errorResponse(err);
  }
}
