import { PolicyUpdateSchema } from '@/domain/policy';
import { getCurrentPolicy, getDailyBudgetUsage, updatePolicy } from '@/services/policy.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const policy = getCurrentPolicy();
    const usage = getDailyBudgetUsage('MOCK', undefined, policy);
    return jsonResponse({ policy, usage });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const body = await req.json();
    const validated = PolicyUpdateSchema.parse(body);
    const updated = updatePolicy(validated, auth.operator.operatorId);
    const usage = getDailyBudgetUsage('MOCK', undefined, updated);
    return jsonResponse({ policy: updated, usage });
  } catch (err) {
    return errorResponse(err);
  }
}
