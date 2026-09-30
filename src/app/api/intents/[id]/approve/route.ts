import { z } from 'zod';
import { approveIntent } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth, readOptionalJsonBody } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const ApproveSchema = z.object({
  notes: z.string().max(512).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    const parsed = ApproveSchema.parse(await readOptionalJsonBody(req));

    const updatedIntent = approveIntent(id, auth.operator.operatorId, parsed.notes);
    return jsonResponse({ intent: updatedIntent });
  } catch (err) {
    return errorResponse(err);
  }
}
