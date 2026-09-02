import { jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  return jsonResponse({
    agentMode: process.env.AGENT_MODE === 'live' ? 'LIVE_MODEL' : 'FIXTURE',
    paymentMode: process.env.PAYMENT_ADAPTER_MODE === 'RAZORPAY_TEST' ? 'RAZORPAY_TEST' : 'MOCK',
    razorpayConfigured:
      process.env.PAYMENT_ADAPTER_MODE === 'RAZORPAY_TEST' &&
      Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) &&
      Boolean(process.env.RAZORPAY_KEY_SECRET),
  });
}
