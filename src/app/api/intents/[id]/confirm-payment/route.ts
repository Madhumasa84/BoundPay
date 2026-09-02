import { z } from 'zod';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { defaultExecutionService } from '@/services/execution.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ConfirmPaymentBodySchema = z.object({
  razorpay_payment_id: z.string().optional(),
  razorpay_order_id: z.string().optional(),
  razorpay_signature: z.string().optional(),
  paymentId: z.string().optional(),
  orderId: z.string().optional(),
  signature: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const { id } = await params;
    const body = await req.json();
    const validated = ConfirmPaymentBodySchema.parse(body);

    const paymentId = validated.razorpay_payment_id || validated.paymentId;
    const orderId = validated.razorpay_order_id || validated.orderId;
    const signature = validated.razorpay_signature || validated.signature;

    if (!paymentId || !orderId || !signature) {
      return jsonResponse(
        { error: 'Missing paymentId, orderId, or signature in confirmation request', code: 'INVALID_PARAMETERS' },
        400
      );
    }

    const result = await defaultExecutionService.confirmPaymentCapture(id, auth.operator.operatorId, {
      paymentId,
      orderId,
      signature,
    });

    return jsonResponse(result);
  } catch (err: any) {
    return errorResponse(err);
  }
}
