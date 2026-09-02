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
    const result = await defaultExecutionService.refreshPaymentStatus(id, auth.operator.operatorId);
    return jsonResponse(result);
  } catch (err: any) {
    return errorResponse(err);
  }
}
