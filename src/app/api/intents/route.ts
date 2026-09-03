import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/infrastructure/db';
import { CreateProposalRequestSchema, resolvePaymentAdapterMode } from '@/domain/intent';
import { createProposal } from '@/services/purchase.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const rawBody = await req.json();
    
    // Explicit security rule: reject or ignore client-supplied approval flags, prices, merchants
    const validatedRequest = CreateProposalRequestSchema.parse(rawBody);

    const paymentAdapterMode = resolvePaymentAdapterMode();
    const result = createProposal(
      auth.operator.operatorId,
      validatedRequest,
      paymentAdapterMode
    );

    return jsonResponse(result, result.isExisting ? 200 : 201);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { db } = getDb();
    const intents = db
      .select()
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.owner_id, auth.operator.operatorId))
      .orderBy(desc(schema.purchaseIntents.created_at))
      .limit(50)
      .all();

    return jsonResponse({ intents });
  } catch (err) {
    return errorResponse(err);
  }
}
