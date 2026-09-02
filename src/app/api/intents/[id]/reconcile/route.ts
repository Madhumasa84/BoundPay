import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { defaultExecutionService } from '@/services/execution.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    // Reuse the process-scoped adapter. This matters for the explicitly labeled
    // in-memory mock provider: a new adapter would erase its accepted orders and
    // make response-loss reconciliation falsely report "not found".
    const result = await defaultExecutionService.reconcileUncertainIntent(id, auth.operator.operatorId);
    return jsonResponse(result);
  } catch (err: any) {
    return errorResponse(err);
  }
}
