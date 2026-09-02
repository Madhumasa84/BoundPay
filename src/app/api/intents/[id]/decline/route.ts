import { z } from 'zod';
import { declineIntent } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const DeclineSchema = z.object({
  reason: z.string().max(512).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    let reason: string | undefined;
    try {
      const body = await req.json();
      const parsed = DeclineSchema.parse(body);
      reason = parsed.reason;
    } catch {
      // Empty body is allowed
    }

    const updatedIntent = declineIntent(params.id, auth.operator.operatorId, reason);
    return jsonResponse({ intent: updatedIntent });
  } catch (err) {
    return errorResponse(err);
  }
}
