import { PolicyUpdateSchema } from '@/domain/policy';
import { resolvePaymentAdapterMode } from '@/domain/intent';
import { getCurrentPolicy, getDailyBudgetUsage, updatePolicy } from '@/services/policy.service';
import { errorResponse, jsonResponse, requireAuth, readJsonBody } from '@/app/api/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const policy = getCurrentPolicy();
    const usage = getDailyBudgetUsage(resolvePaymentAdapterMode(), undefined, policy);
    return jsonResponse({ policy, usage });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const body = await readJsonBody(req);
    const validated = PolicyUpdateSchema.parse(body);
    const updated = updatePolicy(validated, auth.operator.operatorId);
    const usage = getDailyBudgetUsage(resolvePaymentAdapterMode(), undefined, updated);
    return jsonResponse({ policy: updated, usage });
  } catch (err) {
    return errorResponse(err);
  }
}
