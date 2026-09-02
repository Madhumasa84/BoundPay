import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { ExecutionService } from '@/services/execution.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const executionService = new ExecutionService();
    const result = await executionService.refreshPaymentStatus(params.id, auth.operator.operatorId);
    return jsonResponse(result);
  } catch (err: any) {
    return errorResponse(err);
  }
}
