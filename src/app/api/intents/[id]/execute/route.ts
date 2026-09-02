import { z } from 'zod';
import { defaultExecutionService } from '@/services/execution.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

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

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    let faultInjection = 'NONE' as const;
    try {
      const body = await req.json();
      const parsed = ExecuteSchema.parse(body);
      faultInjection = parsed.fault_injection as any;
    } catch {
      // Empty body is acceptable
    }

    const result = await defaultExecutionService.executeIntent(
      params.id,
      auth.operator.operatorId,
      faultInjection
    );

    return jsonResponse({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
