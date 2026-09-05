import { jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { resolvePaymentAdapterMode } from '@/domain/intent';
import { validateAuthorityConfiguration, AuthorityConfigurationError } from '@/infrastructure/authority/signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  let paymentMode: ReturnType<typeof resolvePaymentAdapterMode>;
  try {
    paymentMode = resolvePaymentAdapterMode();
  } catch (error) {
    return jsonResponse({ error: 'Payment Configuration Error', message: error instanceof Error ? error.message : 'Payment adapter mode is invalid' }, 503);
  }
  const hasValidTestKey = Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_'));
  const hasSecret = Boolean(process.env.RAZORPAY_KEY_SECRET);
  let authority: { configured: boolean; keyId?: string; issuer?: string; audience?: string; message?: string };
  try {
    const validated = validateAuthorityConfiguration();
    authority = { configured: true, keyId: validated.keyId, issuer: validated.issuer, audience: validated.audience };
  } catch (error) {
    authority = { configured: false, message: error instanceof AuthorityConfigurationError ? 'Authority signing keys are not configured' : 'Authority configuration is invalid' };
  }

  return jsonResponse({
    agentMode: process.env.AGENT_MODE === 'live' ? 'LIVE_MODEL' : 'FIXTURE',
    paymentMode,
    razorpayConfigured: paymentMode === 'RAZORPAY_TEST' && hasValidTestKey && hasSecret,
    razorpayKeyId: paymentMode === 'RAZORPAY_TEST' && hasValidTestKey ? process.env.RAZORPAY_KEY_ID : null,
    authority,
  });
}
