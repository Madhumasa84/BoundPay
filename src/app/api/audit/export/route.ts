import { exportAllAuditEvents } from '@/services/audit.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const exportData = exportAllAuditEvents();
    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="boundpay-audit-${Date.now()}.json"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
