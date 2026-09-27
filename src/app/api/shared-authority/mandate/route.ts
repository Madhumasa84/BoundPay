import { z } from 'zod';
import { errorResponse, jsonResponse, readJsonBody, requireAuth } from '@/app/api/api-helpers';
import { issueSharedMandate } from '@/services/shared-authority.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IssueMandateSchema = z.object({
  passportId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  aggregateCapPaise: z.number().int().safe().positive(),
  perTransactionCapPaise: z.number().int().safe().positive(),
  maximumUsageCount: z.number().int().safe().min(1).max(100000),
}).strict();

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const input = IssueMandateSchema.parse(await readJsonBody(req));
    const result = await issueSharedMandate(auth.operator.operatorId, input);
    return jsonResponse(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
