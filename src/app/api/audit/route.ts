import { exportAllAuditEvents, getAuditEvents } from '@/services/audit.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const url = new URL(req.url);
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    const events = getAuditEvents(limit, offset);
    return jsonResponse({
      events: events.map((e) => ({
        ...e,
        payload: JSON.parse(e.payload_json),
      })),
      limit,
      offset,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
