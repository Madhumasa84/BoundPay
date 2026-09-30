import { z } from 'zod';
import { declineIntent } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth, readOptionalJsonBody } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const DeclineSchema = z.object({
  reason: z.string().max(512).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    const parsed = DeclineSchema.parse(await readOptionalJsonBody(req));

    const updatedIntent = declineIntent(id, auth.operator.operatorId, parsed.reason);
    return jsonResponse({ intent: updatedIntent });
  } catch (err) {
    return errorResponse(err);
  }
}
