import { z } from 'zod';
import { defaultExecutionService } from '@/services/execution.service';
import { errorResponse, jsonResponse, requireAuth, readOptionalJsonBody } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const ExecuteSchema = z.object({
  fault_injection: z.enum([
    'NONE',
    'SIMULATE_REJECTION',
    'SIMULATE_TIMEOUT',
    'SIMULATE_RESPONSE_LOSS',
    'SIMULATE_PENDING',
    'SIMULATE_DUPLICATE',
  ]).optional().default('NONE'),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    const parsed = ExecuteSchema.parse(await readOptionalJsonBody(req));

    const result = await defaultExecutionService.executeIntent(
      id,
      auth.operator.operatorId,
      parsed.fault_injection
    );

    return jsonResponse({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
