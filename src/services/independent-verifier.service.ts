import crypto from 'node:crypto';
import { z } from 'zod';
import { createCommitment } from '../infrastructure/shared-authority/commitment';
import type { DrunixGatewayClient, DrunixReservation } from '../infrastructure/shared-authority/drunix-gateway';
import type { PaymentAdapter } from '../infrastructure/payment/adapter.interface';

export const VerificationRequestSchema = z.object({
  intentId: z.string().min(1).max(128), mandateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  reservationId: z.string().regex(/^res-[a-f0-9]{32}$/), paymentAttemptId: z.string().regex(/^pay-[a-f0-9]{32}$/),
  outcome: z.enum(['SUCCESS', 'DEFINITIVE_FAILURE']), providerMode: z.enum(['MOCK', 'RAZORPAY_TEST']),
  orderId: z.string().min(1).max(128).optional(), paymentId: z.string().min(1).max(128).optional(),
  evidenceSalt: z.string().regex(/^[A-Za-z0-9_-]{43}$/), evidenceCommitment: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type VerifierLedger = Pick<DrunixGatewayClient, 'identify' | 'queryMandate' | 'queryReservation' | 'submit'>;

/** Never trusts the caller's claimed outcome: independently queries the provider and the ledger. */
export async function verifySharedOutcome(raw: unknown, ledger: VerifierLedger, provider: PaymentAdapter) {
  const request = VerificationRequestSchema.parse(raw);
  if (request.providerMode !== provider.mode) throw new Error('Verifier provider mode does not match the requested mode');
  const hash = crypto.createHash('sha256').update(request.intentId).digest('hex').slice(0, 32);
  if (request.reservationId !== `res-${hash}` || request.paymentAttemptId !== `pay-${hash}`) throw new Error('Intent and reservation binding do not match');
  const identity = await ledger.identify();
  const mandate = await ledger.queryMandate(request.mandateId);
  if (!mandate.verifierIdentities.some((value) => value.mspId === identity.mspId && value.clientId === identity.clientId)) throw new Error('Verifier identity is not authorized for this mandate');
  const reservation = await ledger.queryReservation(request.reservationId, request.mandateId);
  if (reservation.mandateId !== request.mandateId || reservation.reservationId !== request.reservationId || reservation.paymentAttemptId !== request.paymentAttemptId || reservation.requestId !== `req-${hash}` || reservation.paymentAdapterMode !== provider.mode || mandate.paymentAdapterMode !== provider.mode) {
    throw new Error('Ledger reservation does not match the payment attempt');
  }
  const evidence = {
    schemaVersion: 1,
    evidenceType: request.outcome === 'SUCCESS' ? 'PROVIDER_CAPTURED' : 'PROVIDER_DEFINITIVE_FAILURE',
    providerMode: request.providerMode,
    paymentAttemptId: request.paymentAttemptId,
    orderReferenceDigest: request.orderId ? crypto.createHash('sha256').update(request.orderId).digest('hex') : null,
  };
  if (createCommitment('payment-outcome', evidence, Buffer.from(request.evidenceSalt, 'base64url')).digest !== request.evidenceCommitment) throw new Error('Outcome commitment does not match its evidence');
  const expected = request.outcome === 'SUCCESS' ? 'SETTLED' : 'RELEASED';
  // Already committed outcomes can be read back after provider evidence retention expires.
  if (reservation.status === expected && reservation.outcome === request.outcome && reservation.evidenceCommitment === request.evidenceCommitment && reservation.outcomeTransactionId) {
    return { confirmed: true, transactionId: reservation.outcomeTransactionId };
  }
  if (!['DISPATCHING', 'UNKNOWN'].includes(reservation.status)) throw new Error('Reservation is not awaiting a provider outcome');
  const receipt = `rcpt_${request.intentId.replace(/-/g, '').substring(0, 16)}`;
  const status = await provider.reconcileOrderByReceipt?.(receipt);
  if (!status || !request.orderId || status.orderId !== request.orderId || status.amountPaise !== reservation.amountPaise || status.currency !== reservation.currency || status.isMock !== (provider.mode === 'MOCK') || status.rawResponse.intent_id !== request.intentId) {
    return { confirmed: false, message: 'Independent provider evidence is missing or does not match the reserved purchase; hold retained' };
  }
  const provenSuccess = status.status === 'CAPTURED' && Boolean(status.paymentId) && status.paymentId === request.paymentId;
  // A failed Razorpay payment alone does not prove the order cannot later be paid.
  // Only the synthetic provider exposes a terminal failed order in this prototype.
  const provenFailure = provider.mode === 'MOCK' && status.status === 'FAILED';
  if (!(request.outcome === 'SUCCESS' ? provenSuccess : provenFailure)) {
    return { confirmed: false, message: 'Provider has not independently established the requested terminal outcome; hold retained' };
  }
  const method = request.outcome === 'SUCCESS' ? 'CommitOutcome' : 'ReleaseDefinitiveFailure';
  const commit = await ledger.submit<DrunixReservation>(method, [request.mandateId, request.reservationId, request.evidenceCommitment]);
  const readback = await ledger.queryReservation(request.reservationId, request.mandateId);
  if (readback.status !== expected || readback.evidenceCommitment !== request.evidenceCommitment || readback.outcome !== request.outcome || !readback.outcomeTransactionId) {
    return { confirmed: false, message: 'Outcome commit could not be confirmed by ledger readback; hold retained' };
  }
  return { confirmed: true, transactionId: readback.outcomeTransactionId, validationCode: commit.validationCode };
}
