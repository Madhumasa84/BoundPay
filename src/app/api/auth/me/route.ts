import { authenticateRequest } from '@/infrastructure/auth/session';
import { jsonResponse } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const operator = authenticateRequest(req);
  if (!operator) {
    return jsonResponse({ authenticated: false, operator: null }, 401);
  }

  return jsonResponse({
    authenticated: true,
    operator: {
      id: operator.operatorId,
      username: operator.username,
    },
  });
}
