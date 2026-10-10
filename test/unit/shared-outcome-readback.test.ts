import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ call: vi.fn(), query: vi.fn(), close: vi.fn(), operation: {} as Record<string, unknown> }));
vi.mock('@/infrastructure/db', () => ({
  schema: { sharedAuthorityOperations: { intent_id: 'intent_id' } },
  getDb: () => ({ db: {
    select: () => ({ from: () => ({ where: () => ({ get: () => mocks.operation }) }) }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: () => ({ run: () => Object.assign(mocks.operation, patch) }) }) }),
  } }),
}));
vi.mock('@/infrastructure/shared-authority/drunix-gateway', () => ({
  DrunixOperationError: class extends Error {},
  DrunixGatewayClient: class { queryReservation = mocks.query; close = mocks.close; },
}));
vi.mock('@/infrastructure/shared-authority/config', () => ({ getSharedAuthorityMode: () => 'DRUNIX', getDrunixSettings: () => ({ commitTimeoutMs: 60000 }) }));
vi.mock('../../src/infrastructure/http/local-service', async (original) => ({ ...await original<typeof import('../../src/infrastructure/http/local-service')>(), callService: mocks.call }));
import { recordSharedPaymentOutcome } from '@/services/shared-authority.service';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));
  vi.stubEnv('SHARED_AUTHORITY_VERIFIER_URL', 'http://127.0.0.1:3221');
  vi.stubEnv('SHARED_AUTHORITY_VERIFIER_TOKEN', 'test-verifier-token'.padEnd(64, 'x'));
  mocks.operation = { intent_id: 'intent', mandate_id: 'mandate', reservation_id: 'reservation', payment_attempt_id: 'attempt', payment_dispatch_state: 'MAY_HAVE_SENT' };
  mocks.call.mockResolvedValue({ confirmed: true, transactionId: 'untrusted-http-tx' });
  mocks.query.mockImplementation(async () => ({ mandateId: 'mandate', reservationId: 'reservation', paymentAttemptId: 'attempt', status: 'SETTLED', outcome: 'SUCCESS', evidenceCommitment: mocks.operation.outcome_commitment, outcomeTransactionId: 'original-ledger-tx' }));
});
afterEach(() => vi.unstubAllEnvs());
const input = { intentId: 'intent', providerMode: 'MOCK' as const, outcome: 'SUCCESS' as const, orderId: 'order', paymentId: 'payment' };

describe('purchasing service independently reads verifier outcomes', () => {
  it('accepts a matching terminal ledger readback and preserves its original transition ID', async () => {
    expect(await recordSharedPaymentOutcome(input)).toEqual({ confirmed: true, transactionId: 'original-ledger-tx' });
    expect(mocks.operation).toMatchObject({ ledger_state: 'SETTLED', outcome_transaction_id: 'original-ledger-tx', validation_code: 'VALID' });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  for (const mismatch of [{ status: 'UNKNOWN' }, { mandateId: 'other' }, { paymentAttemptId: 'other' }, { evidenceCommitment: 'forged' }, { outcomeTransactionId: '' }]) {
    it(`retains the hold when HTTP claims success but ledger differs: ${JSON.stringify(mismatch)}`, async () => {
      mocks.query.mockImplementation(async () => ({ mandateId: 'mandate', reservationId: 'reservation', paymentAttemptId: 'attempt', status: 'SETTLED', outcome: 'SUCCESS', evidenceCommitment: mocks.operation.outcome_commitment, outcomeTransactionId: 'tx', ...mismatch }));
      expect(await recordSharedPaymentOutcome(input)).toMatchObject({ confirmed: false });
      expect(mocks.operation.ledger_state).toBe('OUTCOME_UNKNOWN');
    });
  }
  it('retains pending state when verifier cannot independently confirm the outcome', async () => {
    mocks.call.mockResolvedValue({ confirmed: false });
    expect(await recordSharedPaymentOutcome(input)).toMatchObject({ confirmed: false });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.operation.ledger_state).toBe('OUTCOME_UNKNOWN');
  });
  it('fails closed when verifier credentials are missing', async () => {
    vi.stubEnv('SHARED_AUTHORITY_VERIFIER_TOKEN', '');
    expect(await recordSharedPaymentOutcome(input)).toMatchObject({ confirmed: false });
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
