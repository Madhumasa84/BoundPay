import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommitment } from '@/infrastructure/shared-authority/commitment';
import { verifySharedOutcome } from '@/services/independent-verifier.service';

const intentId = 'intent-independent-verifier';
const hash = crypto.createHash('sha256').update(intentId).digest('hex').slice(0, 32);
let request: any;
let ledger: any;
let provider: any;
let reservation: any;

beforeEach(() => {
  const evidence = { schemaVersion: 1, evidenceType: 'PROVIDER_CAPTURED', providerMode: 'MOCK', paymentAttemptId: `pay-${hash}`, orderReferenceDigest: crypto.createHash('sha256').update('order-1').digest('hex') };
  const commitment = createCommitment('payment-outcome', evidence);
  request = { intentId, mandateId: 'mandate-1', reservationId: `res-${hash}`, paymentAttemptId: `pay-${hash}`, outcome: 'SUCCESS', providerMode: 'MOCK', orderId: 'order-1', paymentId: 'payment-1', evidenceSalt: commitment.saltBase64Url, evidenceCommitment: commitment.digest };
  reservation = { mandateId: request.mandateId, reservationId: request.reservationId, requestId: `req-${hash}`, paymentAttemptId: request.paymentAttemptId, paymentAdapterMode: 'MOCK', amountPaise: 279900, currency: 'INR', status: 'DISPATCHING' };
  ledger = {
    identify: vi.fn(async () => ({ mspId: 'VerifierMSP', clientId: 'verifier-cert' })),
    queryMandate: vi.fn(async () => ({ paymentAdapterMode: 'MOCK', verifierIdentities: [{ mspId: 'VerifierMSP', clientId: 'verifier-cert' }] })),
    queryReservation: vi.fn(async () => ({ ...reservation })),
    submit: vi.fn(async () => {
      reservation = { ...reservation, status: request.outcome === 'SUCCESS' ? 'SETTLED' : 'RELEASED', outcome: request.outcome, evidenceCommitment: request.evidenceCommitment, outcomeTransactionId: 'outcome-original' };
      return { transactionId: 'outcome-original', validationCode: 'VALID' };
    }),
  };
  provider = { mode: 'MOCK', reconcileOrderByReceipt: vi.fn(async () => ({ isMock: true, orderId: 'order-1', paymentId: 'payment-1', status: 'CAPTURED', amountPaise: 279900, currency: 'INR', rawResponse: { intent_id: intentId } })) };
});

describe('independent outcome verification', () => {
  it('independently verifies the provider and reads the committed outcome', async () => {
    expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: true, transactionId: 'outcome-original' });
    expect(provider.reconcileOrderByReceipt).toHaveBeenCalledWith(`rcpt_${intentId.replace(/-/g, '').substring(0, 16)}`);
    expect(ledger.submit).toHaveBeenCalledWith('CommitOutcome', [request.mandateId, request.reservationId, request.evidenceCommitment]);
  });
  for (const [name, override] of Object.entries({
    amount: { amountPaise: 1 }, currency: { currency: 'USD' }, order: { orderId: 'another-order' },
    payment: { paymentId: 'another-payment' }, pending: { status: 'PENDING' }, unknown: { status: 'UNKNOWN' },
    syntheticLabel: { isMock: false }, anotherIntent: { rawResponse: { intent_id: 'another-intent' } },
  })) {
    it(`retains the hold for mismatched ${name} provider evidence`, async () => {
      const original = await provider.reconcileOrderByReceipt();
      provider.reconcileOrderByReceipt.mockResolvedValue({ ...original, ...override });
      expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: false });
      expect(ledger.submit).not.toHaveBeenCalled();
    });
  }
  it('retains the hold when no provider order is found', async () => {
    provider.reconcileOrderByReceipt.mockResolvedValue(null);
    expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: false });
    expect(ledger.submit).not.toHaveBeenCalled();
  });
  it('rejects an unauthorized verifier certificate before querying the provider', async () => {
    ledger.identify.mockResolvedValue({ mspId: 'VerifierMSP', clientId: 'another-cert' });
    await expect(verifySharedOutcome(request, ledger, provider)).rejects.toThrow('not authorized');
    expect(provider.reconcileOrderByReceipt).not.toHaveBeenCalled();
  });
  it('rejects substitution of another intent or reservation', async () => {
    await expect(verifySharedOutcome({ ...request, intentId: 'another-intent' }, ledger, provider)).rejects.toThrow('binding');
    reservation.requestId = 'req-another';
    await expect(verifySharedOutcome(request, ledger, provider)).rejects.toThrow('reservation');
    expect(ledger.submit).not.toHaveBeenCalled();
  });
  it('rejects tampered evidence commitments', async () => {
    await expect(verifySharedOutcome({ ...request, evidenceCommitment: 'a'.repeat(64) }, ledger, provider)).rejects.toThrow('commitment');
    expect(ledger.submit).not.toHaveBeenCalled();
  });
  it('requires matching readback even after a successful commit response', async () => {
    ledger.submit.mockResolvedValue({ transactionId: 'tx', validationCode: 'VALID' });
    expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: false });
  });
  it('recovers an already committed outcome without another provider lookup or transaction', async () => {
    await verifySharedOutcome(request, ledger, provider);
    ledger.submit.mockClear(); provider.reconcileOrderByReceipt.mockClear();
    expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: true, transactionId: 'outcome-original' });
    expect(ledger.submit).not.toHaveBeenCalled();
    expect(provider.reconcileOrderByReceipt).not.toHaveBeenCalled();
  });
  it('only releases a proven terminal synthetic failure', async () => {
    request.outcome = 'DEFINITIVE_FAILURE';
    const evidence = { schemaVersion: 1, evidenceType: 'PROVIDER_DEFINITIVE_FAILURE', providerMode: 'MOCK', paymentAttemptId: request.paymentAttemptId, orderReferenceDigest: crypto.createHash('sha256').update(request.orderId).digest('hex') };
    request.evidenceCommitment = createCommitment('payment-outcome', evidence, Buffer.from(request.evidenceSalt, 'base64url')).digest;
    provider.reconcileOrderByReceipt.mockResolvedValue({ isMock: true, orderId: 'order-1', status: 'FAILED', amountPaise: 279900, currency: 'INR', rawResponse: { intent_id: intentId } });
    expect(await verifySharedOutcome(request, ledger, provider)).toMatchObject({ confirmed: true });
    expect(ledger.submit).toHaveBeenCalledWith('ReleaseDefinitiveFailure', expect.any(Array));
  });
});
