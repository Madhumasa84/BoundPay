import fs from 'node:fs';
import path from 'node:path';

export type SharedAuthorityMode = 'DISABLED' | 'SIMULATED' | 'DRUNIX';

export class SharedAuthorityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedAuthorityConfigurationError';
  }
}

export interface DrunixSettings {
  mandateId: string;
  channel: string;
  chaincode: string;
  mspId: string;
  verifierMspId: string;
  endpoint: string;
  hostAlias: string;
  tlsRootCert: Buffer;
  clientCert: Buffer;
  clientPrivateKey: Buffer;
  verifierClientCert: Buffer;
  verifierClientPrivateKey: Buffer;
  participantMsps: string[];
  participantIdentities: Array<{ mspId: string; clientId: string }>;
  verifierIdentities: Array<{ mspId: string; clientId: string }>;
  commitTimeoutMs: number;
}

export function getSharedAuthorityMode(): SharedAuthorityMode {
  const mode = (process.env.SHARED_AUTHORITY_MODE || 'DISABLED').trim().toUpperCase();
  if (mode === 'DISABLED' || mode === 'SIMULATED' || mode === 'DRUNIX') return mode;
  throw new SharedAuthorityConfigurationError('SHARED_AUTHORITY_MODE must be DISABLED, SIMULATED, or DRUNIX');
}

export function getDrunixSettings(): DrunixSettings {
  const mandateId = requiredEnv('DRUNIX_MANDATE_ID');
  const channel = requiredEnv('DRUNIX_CHANNEL');
  const chaincode = requiredEnv('DRUNIX_CHAINCODE');
  const mspId = requiredEnv('DRUNIX_MSP_ID');
  const verifierMspId = requiredEnv('DRUNIX_VERIFIER_MSP_ID');
  const endpoint = requiredEnv('DRUNIX_GATEWAY_ENDPOINT');
  const hostAlias = requiredEnv('DRUNIX_PEER_HOST_ALIAS');
  for (const [field, value] of Object.entries({ mandateId, channel, chaincode, mspId, verifierMspId })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new SharedAuthorityConfigurationError(`${field} must be a safe identifier`);
  }
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(endpoint)) throw new SharedAuthorityConfigurationError('DRUNIX_GATEWAY_ENDPOINT must be host:port');
  const participantIdentities = identityList('DRUNIX_PARTICIPANT_IDENTITIES_JSON');
  const verifierIdentities = identityList('DRUNIX_VERIFIER_IDENTITIES_JSON');
  if (participantIdentities.length === 0 || verifierIdentities.length === 0) throw new SharedAuthorityConfigurationError('At least one exact participant identity and verifier identity are required');
  const participantMsps = [...new Set(participantIdentities.map((identity) => identity.mspId))].sort();
  const commitTimeoutMs = Number(process.env.DRUNIX_COMMIT_TIMEOUT_MS || 60000);
  if (!Number.isSafeInteger(commitTimeoutMs) || commitTimeoutMs < 1000 || commitTimeoutMs > 300000) {
    throw new SharedAuthorityConfigurationError('DRUNIX_COMMIT_TIMEOUT_MS must be an integer between 1000 and 300000');
  }
  return {
    mandateId,
    channel,
    chaincode,
    mspId,
    verifierMspId,
    endpoint,
    hostAlias,
    tlsRootCert: readPem('DRUNIX_TLS_ROOT_CERT_FILE'),
    clientCert: readPem('DRUNIX_CLIENT_CERT_FILE'),
    clientPrivateKey: readPem('DRUNIX_CLIENT_PRIVATE_KEY_FILE'),
    verifierClientCert: readPem('DRUNIX_VERIFIER_CLIENT_CERT_FILE'),
    verifierClientPrivateKey: readPem('DRUNIX_VERIFIER_CLIENT_PRIVATE_KEY_FILE'),
    participantMsps,
    participantIdentities,
    verifierIdentities,
    commitTimeoutMs,
  };
}

export function getSharedAuthorityLabel(): string {
  switch (getSharedAuthorityMode()) {
    case 'DRUNIX': return 'DRUNIX NETWORK';
    case 'SIMULATED': return 'SIMULATED — NO LEDGER';
    default: return 'SHARED AUTHORITY DISABLED';
  }
}

export function isSharedAuthorityEncryptionConfigured(): boolean {
  return Boolean(process.env.SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY);
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new SharedAuthorityConfigurationError(`${name} is required for the configured shared authority mode`);
  return value;
}

function readPem(name: string): Buffer {
  const fileName = requiredEnv(name);
  const resolved = path.isAbsolute(fileName) ? fileName : path.resolve(process.cwd(), fileName);
  try {
    const contents = fs.readFileSync(resolved);
    if (contents.length === 0 || !contents.toString('utf8').includes('-----BEGIN ')) throw new Error('not PEM');
    return contents;
  } catch {
    throw new SharedAuthorityConfigurationError(`${name} must point to a readable PEM file`);
  }
}

function identityList(name: string): Array<{ mspId: string; clientId: string }> {
  const raw = requiredEnv(name);
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new SharedAuthorityConfigurationError(`${name} must be a JSON array of identity objects`); }
  if (!Array.isArray(values) || values.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const identity = value as Record<string, unknown>;
    return typeof identity.mspId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.mspId)
      || typeof identity.clientId !== 'string' || identity.clientId.trim().length === 0 || identity.clientId.length > 2048 || /[\r\n\u0000]/.test(identity.clientId);
  })) throw new SharedAuthorityConfigurationError(`${name} must contain exact MSP and certificate-derived client identities`);
  const identities = (values as Array<{ mspId: string; clientId: string }>).map((identity) => ({ mspId: identity.mspId, clientId: identity.clientId })).sort((a, b) => `${a.mspId}\u0000${a.clientId}`.localeCompare(`${b.mspId}\u0000${b.clientId}`));
  if (new Set(identities.map((identity) => `${identity.mspId}\u0000${identity.clientId}`)).size !== identities.length) throw new SharedAuthorityConfigurationError(`${name} must not contain duplicate identities`);
  return identities;
}
