import * as grpc from '@grpc/grpc-js';
import { connect, EndorseError, hash, signers, type Contract } from '@hyperledger/fabric-gateway';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { getDrunixSettings } from './config';

const decoder = new TextDecoder();

export class DrunixOperationError extends Error {
  readonly transactionId?: string;
  readonly validationCode?: string;
  readonly uncertain: boolean;

  constructor(message: string, options: { transactionId?: string; validationCode?: string; uncertain: boolean }) {
    super(message);
    this.name = 'DrunixOperationError';
    this.transactionId = options.transactionId;
    this.validationCode = options.validationCode;
    this.uncertain = options.uncertain;
  }
}

export interface LedgerCommit<T> {
  transactionId: string;
  validationCode: string;
  value: T;
}

export interface DrunixIdentity {
  mspId: string;
  clientId: string;
}

export interface DrunixMandate {
  mandateId: string;
  passportId: string;
  passportDigest: string;
  ownerMsp: string;
  ownerIdentity: string;
  participantMsps: string[];
  verifierIdentities: Array<{ mspId: string; clientId: string }>;
  currency: string;
  paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST';
  aggregateCapPaise: number;
  perTransactionCapPaise: number;
  maximumUsageCount: number;
  policyVersion: number;
  activeUsageCount: number;
  reservedPaise: number;
  settledPaise: number;
  scopeCommitment: string;
  participantIdentities: Array<{ mspId: string; clientId: string }>;
  status: 'ACTIVE' | 'REVOKED';
  issuedByTransactionId: string;
  revokedByTransactionId?: string;
}

export interface DrunixReservation {
  reservationId: string;
  mandateId: string;
  requestId: string;
  paymentAttemptId: string;
  passportId: string;
  passportDigest: string;
  participantMsp: string;
  executorIdentity: string;
  amountPaise: number;
  currency: string;
  paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST';
  scopeCommitment: string;
  requestCommitment: string;
  status: 'RESERVED' | 'DISPATCHING' | 'UNKNOWN' | 'SETTLED' | 'RELEASED';
  reserveTransactionId: string;
  dispatchTransactionId?: string;
  unknownTransactionId?: string;
  outcome?: 'SUCCESS' | 'DEFINITIVE_FAILURE';
  evidenceCommitment?: string;
  outcomeTransactionId?: string;
}

export class DrunixGatewayClient {
  private readonly settings = getDrunixSettings();
  private readonly grpcClient: grpc.Client;
  private readonly gateway: ReturnType<typeof connect>;
  private readonly contract: Contract;

  constructor(role: 'participant' | 'verifier' = 'participant') {
    const credentials = grpc.credentials.createSsl(this.settings.tlsRootCert);
    this.grpcClient = new grpc.Client(this.settings.endpoint, credentials, {
      'grpc.ssl_target_name_override': this.settings.hostAlias,
    });
    this.gateway = connect({
      client: this.grpcClient,
      identity: {
        mspId: role === 'participant' ? this.settings.mspId : this.settings.verifierMspId,
        credentials: role === 'participant' ? this.settings.clientCert : this.settings.verifierClientCert,
      },
      signer: signers.newPrivateKeySigner(crypto.createPrivateKey(role === 'participant' ? this.settings.clientPrivateKey : this.settings.verifierClientPrivateKey)),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 15000 }),
      endorseOptions: () => ({ deadline: Date.now() + 30000 }),
      submitOptions: () => ({ deadline: Date.now() + 15000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + this.settings.commitTimeoutMs }),
    });
    this.contract = this.gateway.getNetwork(this.settings.channel).getContract(this.settings.chaincode);
  }

  close(): void {
    this.gateway.close();
    this.grpcClient.close();
  }

  async evaluate<T>(transactionName: string, args: string[] = []): Promise<T> {
    try {
      const bytes = await this.contract.evaluate(transactionName, { arguments: args });
      return parseLedgerJson<T>(bytes, transactionName);
    } catch (error) {
      throw new DrunixOperationError(`Drunix query ${transactionName} failed: ${safeMessage(error)}`, { uncertain: true });
    }
  }

  async submit<T>(transactionName: string, args: string[] = [], transientData?: Record<string, string | Uint8Array>): Promise<LedgerCommit<T>> {
    let submitted;
    try {
      submitted = await this.contract.submitAsync(transactionName, {
        arguments: args,
        ...(transientData ? { transientData } : {}),
      });
    } catch (error) {
      if (error instanceof EndorseError) {
        throw new DrunixOperationError(`Drunix transaction ${transactionName} was rejected during endorsement: ${safeMessage(error)}`, { uncertain: false });
      }
      // A gateway transport failure does not prove that Submit was not accepted.
      throw new DrunixOperationError(`Drunix transaction ${transactionName} submission status is uncertain: ${safeMessage(error)}`, { uncertain: true });
    }

    const transactionId = submitted.getTransactionId();
    let value: T;
    try {
      const resultBytes = submitted.getResult();
      value = resultBytes.length === 0 ? null as T : parseLedgerJson<T>(resultBytes, transactionName);
    } catch (error) {
      throw new DrunixOperationError(`Drunix transaction ${transactionName} returned an unreadable proposal result`, { transactionId, uncertain: true });
    }
    try {
      const status = await submitted.getStatus({ deadline: Date.now() + this.settings.commitTimeoutMs });
      // Fabric Gateway exposes VALID as numeric enum value 0. Persist and show
      // the symbolic value so operators can distinguish it from raw failures.
      const validationCode = status.successful ? 'VALID' : String(status.code);
      if (!status.successful) {
        throw new DrunixOperationError(`Drunix transaction ${transactionName} committed invalid with validation code ${validationCode}`, {
          transactionId: status.transactionId || transactionId,
          validationCode,
          uncertain: false,
        });
      }
      return { transactionId: status.transactionId || transactionId, validationCode, value };
    } catch (error) {
      if (error instanceof DrunixOperationError) throw error;
      throw new DrunixOperationError(`Drunix transaction ${transactionName} commit status is unknown: ${safeMessage(error)}`, {
        transactionId,
        uncertain: true,
      });
    }
  }

  async identify(): Promise<DrunixIdentity> {
    return this.evaluate<DrunixIdentity>('GetCallerIdentity');
  }

  async queryMandate(mandateId = this.settings.mandateId): Promise<DrunixMandate> {
    return this.evaluate<DrunixMandate>('QueryMandate', [mandateId]);
  }

  async queryReservation(reservationId: string, mandateId = this.settings.mandateId): Promise<DrunixReservation> {
    return this.evaluate<DrunixReservation>('QueryReservation', [mandateId, reservationId]);
  }

  async queryReservations(mandateId = this.settings.mandateId): Promise<DrunixReservation[]> {
    return this.evaluate<DrunixReservation[]>('QueryReservations', [mandateId]);
  }
}

function parseLedgerJson<T>(bytes: Uint8Array, operation: string): T {
  if (bytes.length === 0) throw new Error(`Empty result from ${operation}`);
  try { return JSON.parse(decoder.decode(bytes)) as T; }
  catch { throw new Error(`Invalid JSON result from ${operation}`); }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown gateway error';
}
