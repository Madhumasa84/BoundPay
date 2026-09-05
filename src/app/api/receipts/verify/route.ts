import { z } from 'zod';
import { errorResponse, jsonResponse, requireAuth, readJsonBody } from '@/app/api/api-helpers';
import { verifyDecisionReceipt } from '@/services/passport.service';

export const runtime = 'nodejs';

const VerifyReceiptSchema = z.object({ signedReceipt: z.string().min(1).max(32768) });

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;
  try {
    const { signedReceipt } = VerifyReceiptSchema.parse(await readJsonBody(req, 64 * 1024));
    const result = verifyDecisionReceipt(signedReceipt);
    return jsonResponse(result);
  } catch (error) {
    // A tampered receipt is a verification result, not a server failure.
    if (error instanceof Error && (error.name === 'AuthorityVerificationError' || error.name === 'ZodError')) {
      return jsonResponse({ valid: false, message: 'Signed decision receipt verification failed' }, 200);
    }
    return errorResponse(error);
  }
}
