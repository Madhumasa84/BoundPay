import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getLatestDecisionReceipt, verifyDecisionReceipt } from '@/services/passport.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { id } = await params;
    const receipt = getLatestDecisionReceipt(id, auth.operator.operatorId);
    if (!receipt) return jsonResponse({ error: 'Not Found', message: 'No signed authorization decision receipt exists for this intent' }, 404);
    let verification: { valid: boolean; algorithm: string; keyId: string; fingerprint?: string } = { valid: false, algorithm: 'EdDSA', keyId: receipt.keyId };
    try {
      const verified = verifyDecisionReceipt(receipt.signedToken);
      verification = { valid: verified.valid, algorithm: 'EdDSA', keyId: verified.keyId, fingerprint: verified.fingerprint };
    } catch {
      // Keep the receipt inspectable while making an altered/stale signature
      // visible to the UI; do not turn verifier failures into a server error or
      // expose cryptographic/configuration internals.
    }
    return jsonResponse({ receipt: { ...receipt, verification } });
  } catch (error) {
    return errorResponse(error);
  }
}
