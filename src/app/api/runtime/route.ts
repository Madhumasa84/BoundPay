import { jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { resolvePaymentAdapterMode } from '@/domain/intent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  const paymentMode = resolvePaymentAdapterMode();
  const hasValidTestKey = Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_'));
  const hasSecret = Boolean(process.env.RAZORPAY_KEY_SECRET);

  return jsonResponse({
    agentMode: process.env.AGENT_MODE === 'live' ? 'LIVE_MODEL' : 'FIXTURE',
    paymentMode,
    razorpayConfigured: paymentMode === 'RAZORPAY_TEST' && hasValidTestKey && hasSecret,
    razorpayKeyId: paymentMode === 'RAZORPAY_TEST' && hasValidTestKey ? process.env.RAZORPAY_KEY_ID : null,
  });
}
