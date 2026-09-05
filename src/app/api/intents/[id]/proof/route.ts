import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';
import { getLatestDecisionReceipt, getPassportById, verifyDecisionReceipt } from '@/services/passport.service';
import { getPublicJwkForKeyId, publicKeyFingerprintForKeyId } from '@/infrastructure/authority/signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { id } = await params;
    const receipt = getLatestDecisionReceipt(id, auth.operator.operatorId);
    if (!receipt) return jsonResponse({ error: 'Not Found', message: 'No signed authorization receipt exists for this intent' }, 404);
    const passport = getPassportById(receipt.payload.passportId, auth.operator.operatorId);
    if (!passport) return jsonResponse({ error: 'Not Found', message: 'Authority passport not found' }, 404);
    let receiptSignatureValid = false;
    try { verifyDecisionReceipt(receipt.signedToken); receiptSignatureValid = true; } catch { /* proof remains inspectable, but is marked invalid */ }
    return jsonResponse({
      proofBundleSchemaVersion: 1,
      receipt: { compactJws: receipt.signedToken, payload: receipt.payload },
      passport: { compactJws: passport.signedToken, payload: passport.payload, payloadDigest: passport.payloadDigest },
      verificationKey: await getPublicJwkForKeyId(receipt.keyId),
      keyId: receipt.keyId,
      keyFingerprintSha256: publicKeyFingerprintForKeyId(receipt.keyId),
      receiptSignatureValid,
      verificationInstructions: 'Verify the EdDSA compact JWS with the supplied public JWK, then compare the signed payload fields with the displayed payload. This proves BoundPay signed the contents; it does not prove database completeness, host integrity, or bank settlement.',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
