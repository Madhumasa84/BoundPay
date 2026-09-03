import crypto from 'crypto';
import { z } from 'zod';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { ShoppingAgentRequestSchema } from '@/domain/agent';
import {
  invokeShoppingAgent,
  AgentConfigError,
  AgentInvocationError,
} from '@/services/agent.service';
import { createProposal } from '@/services/purchase.service';
import { resolvePaymentAdapterMode } from '@/domain/intent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AgentProposeBodySchema = ShoppingAgentRequestSchema.extend({
  idempotency_key: z.string().min(1).max(128).optional(),
});

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const body = await req.json();
    const validated = AgentProposeBodySchema.parse(body);

    const agentResult = await invokeShoppingAgent(
      validated.shopping_request,
      validated.purchase_budget_paise
    );

    if (!agentResult.suitable || !agentResult.product_id || !agentResult.quantity) {
      return jsonResponse({
        suitable: false,
        reason: agentResult.reason,
        source_mode: agentResult.source_mode,
        model_provider: agentResult.model_provider,
        model_name: agentResult.model_name,
      });
    }

    const idempotencyKey =
      validated.idempotency_key || `agent_prop_${crypto.randomUUID()}`;

    const paymentAdapterMode = resolvePaymentAdapterMode();

    const proposal = createProposal(
      auth.operator.operatorId,
      {
        product_id: agentResult.product_id,
        quantity: agentResult.quantity,
        purchase_budget_paise: validated.purchase_budget_paise,
        idempotency_key: idempotencyKey,
        source_mode: agentResult.source_mode,
        model_provider: agentResult.model_provider,
        model_name: agentResult.model_name,
        reason: agentResult.reason,
        fault_injection: 'NONE',
      },
      paymentAdapterMode
    );

    return jsonResponse({
      suitable: true,
      intent: proposal.intent,
      evaluation: proposal.evaluation,
      source_mode: agentResult.source_mode,
      model_provider: agentResult.model_provider,
      model_name: agentResult.model_name,
      reason: agentResult.reason,
    }, 201);
  } catch (err: any) {
    if (err instanceof AgentConfigError) {
      return jsonResponse({ error: err.message, code: 'AGENT_CONFIG_ERROR' }, 400);
    }
    if (err instanceof AgentInvocationError) {
      return jsonResponse({ error: err.message, code: 'AGENT_INVOCATION_ERROR' }, 502);
    }
    return errorResponse(err);
  }
}
