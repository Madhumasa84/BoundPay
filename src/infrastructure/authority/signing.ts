import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { decodeProtectedHeader, exportJWK, importSPKI, jwtVerify } from 'jose';
import { AuthorityPassportSchema, DecisionReceiptPayload, DecisionReceiptSchema, digestPassportPayload, digestReceiptPayload } from '@/domain/passport';

export const AUTHORITY_ALGORITHM = 'EdDSA' as const;
export const AUTHORITY_PASSPORT_TYP = 'boundpay-authority-passport+jwt';
export const AUTHORITY_RECEIPT_TYP = 'boundpay-decision-receipt+jwt';

export class AuthorityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityConfigurationError';
  }
}

export class AuthorityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityVerificationError';
  }
}

export interface AuthorityConfig {
  issuer: string;
  audience: string;
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  verificationKeys: Record<string, string>;
  testOnly: boolean;
}

const TEST_SEED_LABEL = 'BOUNDPAY_PHASE4_TEST_ONLY_ED25519_KEY_V1';

function deterministicTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const seed = crypto.createHash('sha256').update(TEST_SEED_LABEL).digest();
  // PKCS#8 and SPKI wrappers for Ed25519 are standardized DER encodings.
  const privateDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function readConfiguredValue(valueName: string, fileName: string): string | undefined {
  const direct = process.env[valueName];
  if (direct) return direct.replace(/\\n/g, '\n');
  const filePath = process.env[fileName];
  if (!filePath) return undefined;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  try {
    return fs.readFileSync(resolved, 'utf8').trim();
  } catch {
    throw new AuthorityConfigurationError(`${fileName} points to an unreadable key file`);
  }
}

function ensureEd25519PrivateKey(pem: string): void {
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  } catch {
    throw new AuthorityConfigurationError('AUTHORITY_SIGNING_PRIVATE_KEY must be a valid Ed25519 PKCS#8 private key');
  }
}

function ensureEd25519PublicKey(pem: string): void {
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  } catch {
    throw new AuthorityConfigurationError('AUTHORITY_SIGNING_PUBLIC_KEY must be a valid Ed25519 SPKI public key');
  }
}

/**
 * Resolves authority configuration on demand so tests can install isolated keys
 * before importing the route. Production never has a fallback key.
 */
export function getAuthorityConfig(options: { requirePrivate?: boolean } = {}): AuthorityConfig {
  const explicitTestMode = process.env.AUTHORITY_TEST_MODE === 'true';
  // A production process must never silently fall back to the deterministic
  // fixture key. The browser harness is the sole explicit production-build
  // exception and marks itself with PLAYWRIGHT_TEST in its isolated process.
  if (process.env.NODE_ENV === 'production' && explicitTestMode && process.env.PLAYWRIGHT_TEST !== 'true') {
    throw new AuthorityConfigurationError('AUTHORITY_TEST_MODE is forbidden in production');
  }
  const testOnly = explicitTestMode || process.env.NODE_ENV === 'test';
  const privateKeyPem = readConfiguredValue('AUTHORITY_SIGNING_PRIVATE_KEY', 'AUTHORITY_SIGNING_PRIVATE_KEY_FILE');
  const publicKeyPem = readConfiguredValue('AUTHORITY_SIGNING_PUBLIC_KEY', 'AUTHORITY_SIGNING_PUBLIC_KEY_FILE');
  const keyId = (process.env.AUTHORITY_SIGNING_KEY_ID || (testOnly ? 'test-only-key-v1' : '')).trim();
  const issuer = (process.env.AUTHORITY_ISSUER || (testOnly ? 'boundpay-test-authority' : '')).trim();
  const audience = (process.env.AUTHORITY_AUDIENCE || (testOnly ? 'boundpay-agent' : '')).trim();

  if (!keyId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new AuthorityConfigurationError('AUTHORITY_SIGNING_KEY_ID is required and must be a safe identifier');
  }
  if (!issuer || !audience || issuer.length > 256 || audience.length > 256 || /[\u0000-\u001f\u007f]/.test(issuer) || /[\u0000-\u001f\u007f]/.test(audience)) {
    throw new AuthorityConfigurationError('AUTHORITY_ISSUER and AUTHORITY_AUDIENCE are required');
  }

  let privatePem = privateKeyPem;
  let publicPem = publicKeyPem;
  if (testOnly && !privatePem && !publicPem) {
    const generated = deterministicTestKeyPair();
    privatePem = generated.privateKeyPem;
    publicPem = generated.publicKeyPem;
  }
  if (options.requirePrivate && !privatePem) {
    throw new AuthorityConfigurationError('Authority signing private key is not configured');
  }
  if (!publicPem && privatePem) {
    try {
      publicPem = crypto.createPublicKey(privatePem).export({ format: 'pem', type: 'spki' }).toString();
    } catch {
      throw new AuthorityConfigurationError('Unable to derive authority public key from configured private key');
    }
  }
  if (!publicPem) {
    throw new AuthorityConfigurationError('Authority signing public key is not configured');
  }
  if (privatePem) ensureEd25519PrivateKey(privatePem);
  ensureEd25519PublicKey(publicPem);

  const verificationKeys: Record<string, string> = {};
  const configuredRotation = process.env.AUTHORITY_VERIFICATION_KEYS_JSON;
  if (configuredRotation) {
    let parsed: unknown;
    try { parsed = JSON.parse(configuredRotation); } catch { throw new AuthorityConfigurationError('AUTHORITY_VERIFICATION_KEYS_JSON must be valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthorityConfigurationError('AUTHORITY_VERIFICATION_KEYS_JSON must be an object keyed by kid');
    for (const [kid, pem] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof pem !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(kid)) throw new AuthorityConfigurationError('Invalid authority verification key entry');
      ensureEd25519PublicKey(pem.replace(/\\n/g, '\n'));
      verificationKeys[kid] = pem.replace(/\\n/g, '\n');
    }
  }
  verificationKeys[keyId] = publicPem;

  return { issuer, audience, keyId, privateKeyPem: privatePem || '', publicKeyPem: publicPem, verificationKeys, testOnly };
}

export function validateAuthorityConfiguration(): { valid: true; keyId: string; issuer: string; audience: string } {
  const config = getAuthorityConfig({ requirePrivate: process.env.NODE_ENV === 'production' || process.env.AUTHORITY_REQUIRE_CONFIG === 'true' });
  return { valid: true, keyId: config.keyId, issuer: config.issuer, audience: config.audience };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function compactSignSync(payload: Record<string, unknown>, typ: string, config: AuthorityConfig): string {
  if (!config.privateKeyPem) throw new AuthorityConfigurationError('Authority signing private key is not configured');
  const protectedHeader = base64url(JSON.stringify({ alg: AUTHORITY_ALGORITHM, kid: config.keyId, typ }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${protectedHeader}.${encodedPayload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), crypto.createPrivateKey(config.privateKeyPem));
  return `${signingInput}.${base64url(signature)}`;
}

function parseCompactSync(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  if (typeof token !== 'string' || token.length < 32 || token.length > 32768) throw new AuthorityVerificationError('Malformed signed authority token');
  const pieces = token.split('.');
  // Buffer's base64 decoder is intentionally permissive (it silently ignores
  // invalid characters and padding). Compact JWS input is untrusted, so reject
  // anything outside the unpadded base64url alphabet before decoding.
  if (pieces.length !== 3 || pieces.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw new AuthorityVerificationError('Malformed compact JWS');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  const decodedParts = pieces.map((part) => decodeBase64url(part));
  if (decodedParts.some((decoded, index) => base64url(decoded) !== pieces[index])) throw new AuthorityVerificationError('Non-canonical compact JWS encoding');
  const signature = decodedParts[2];
  if (signature.length !== 64) throw new AuthorityVerificationError('Malformed Ed25519 signature');
  try {
    header = JSON.parse(decodedParts[0].toString('utf8'));
    payload = JSON.parse(decodedParts[1].toString('utf8'));
  } catch {
    throw new AuthorityVerificationError('Malformed JWS JSON');
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw new AuthorityVerificationError('Malformed JWS claims');
  return { header, payload, signingInput: `${pieces[0]}.${pieces[1]}`, signature };
}

function verifyCompactSync(token: string, expectedType: string, expectedSchema: number, config: AuthorityConfig, expectedPayload?: Record<string, unknown>, enforceValidity = true, referenceNowMs = Date.now()): Record<string, unknown> {
  const parsed = parseCompactSync(token);
  if (parsed.header.alg !== AUTHORITY_ALGORITHM || parsed.header.typ !== expectedType || parsed.header.kid !== parsed.payload.keyId) {
    throw new AuthorityVerificationError('Unsupported algorithm, token type, or key ID');
  }
  const kid = parsed.header.kid;
  if (typeof kid !== 'string' || !config.verificationKeys[kid]) throw new AuthorityVerificationError('Unknown authority key ID');
  const verified = crypto.verify(null, Buffer.from(parsed.signingInput), crypto.createPublicKey(config.verificationKeys[kid]), parsed.signature);
  if (!verified) throw new AuthorityVerificationError('Authority signature verification failed');
  if (parsed.payload.schemaVersion !== expectedSchema && parsed.payload.receiptSchemaVersion !== expectedSchema) throw new AuthorityVerificationError('Unsupported authority schema version');
  if (parsed.payload.issuer !== config.issuer || parsed.payload.audience !== config.audience) throw new AuthorityVerificationError('Authority issuer or audience mismatch');
  const now = referenceNowMs;
  const issuedAt = Date.parse(String(parsed.payload.issuedAt || parsed.payload.decisionTimestamp || ''));
  const notBefore = Date.parse(String(parsed.payload.validFrom || parsed.payload.issuedAt || parsed.payload.decisionTimestamp || ''));
  const expiresAt = Date.parse(String(parsed.payload.expiresAt || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(notBefore)) throw new AuthorityVerificationError('Invalid authority validity timestamps');
  // Signature-only verification still rejects a future issuance timestamp,
  // while the caller-supplied reference clock keeps deterministic fixtures
  // aligned with the same UTC semantics as the authorization composer.
  if (issuedAt > now + 60_000) throw new AuthorityVerificationError('Authority token was issued in the future');
  if (expectedType === AUTHORITY_PASSPORT_TYP && enforceValidity) {
    if (!Number.isFinite(expiresAt) || now < notBefore || now >= expiresAt) throw new AuthorityVerificationError('Authority passport is outside its validity window');
  }
  if (expectedPayload && JSON.stringify(parsed.payload) !== JSON.stringify(expectedPayload)) throw new AuthorityVerificationError('Signed payload does not match expected payload');
  return parsed.payload;
}

export function signPassportSync(payload: Record<string, unknown>): string {
  const config = getAuthorityConfig({ requirePrivate: true });
  return compactSignSync(payload, AUTHORITY_PASSPORT_TYP, config);
}

export function signDecisionReceiptSync(payload: DecisionReceiptPayload): string {
  const config = getAuthorityConfig({ requirePrivate: true });
  return compactSignSync(payload as unknown as Record<string, unknown>, AUTHORITY_RECEIPT_TYP, config);
}

export function verifyPassportSync(token: string): ReturnType<typeof AuthorityPassportSchema.parse> {
  const config = getAuthorityConfig();
  const payload = verifyCompactSync(token, AUTHORITY_PASSPORT_TYP, 1, config);
  return AuthorityPassportSchema.parse(payload);
}

/** Verifies signature/schema/issuer binding and issuance freshness while leaving validFrom/expiry authorization to the policy composer. */
export function verifyPassportSignatureSync(token: string, referenceNowMs = Date.now()): ReturnType<typeof AuthorityPassportSchema.parse> {
  const config = getAuthorityConfig();
  const payload = verifyCompactSync(token, AUTHORITY_PASSPORT_TYP, 1, config, undefined, false, referenceNowMs);
  return AuthorityPassportSchema.parse(payload);
}

export function verifyDecisionReceiptSync(token: string): DecisionReceiptPayload {
  const config = getAuthorityConfig();
  const payload = verifyCompactSync(token, AUTHORITY_RECEIPT_TYP, 1, config);
  return DecisionReceiptSchema.parse(payload) as DecisionReceiptPayload;
}

/** Async JOSE verification path used by API endpoints and offline proof consumers. */
export async function verifySignedToken(token: string, expected: 'passport' | 'receipt', publicKeyPem?: string): Promise<Record<string, unknown>> {
  const config = getAuthorityConfig();
  const header = decodeProtectedHeader(token);
  if (header.alg !== AUTHORITY_ALGORITHM || header.typ !== (expected === 'passport' ? AUTHORITY_PASSPORT_TYP : AUTHORITY_RECEIPT_TYP)) throw new AuthorityVerificationError('Unsupported algorithm or token type');
  const kid = header.kid;
  if (typeof kid !== 'string' || !config.verificationKeys[kid]) throw new AuthorityVerificationError('Unknown authority key ID');
  // This server-bound verifier never accepts a key selected by an untrusted
  // token. An optional key is only a consistency check for callers that have
  // already loaded a proof bundle; it cannot replace the configured kid entry.
  if (publicKeyPem && publicKeyPem !== config.verificationKeys[kid]) {
    throw new AuthorityVerificationError('Supplied verification key does not match configured key ID');
  }
  const keyPem = config.verificationKeys[kid];
  const key = await importSPKI(keyPem, AUTHORITY_ALGORITHM);
  const verified = await jwtVerify(token, key, {
    algorithms: [AUTHORITY_ALGORITHM],
  });
  const payload = verified.payload as Record<string, unknown>;
  if (payload.keyId !== kid) throw new AuthorityVerificationError('Signed payload key ID does not match protected header');
  if (payload.issuer !== config.issuer || payload.audience !== config.audience) throw new AuthorityVerificationError('Authority issuer or audience mismatch');
  const issuedAt = Date.parse(String(payload.issuedAt || payload.decisionTimestamp || ''));
  const notBefore = Date.parse(String(payload.validFrom || payload.issuedAt || payload.decisionTimestamp || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(notBefore) || issuedAt > Date.now() + 60_000) throw new AuthorityVerificationError('Invalid authority validity timestamps');
  if (expected === 'passport' && (Date.now() < notBefore || !payload.expiresAt || Date.now() >= Date.parse(String(payload.expiresAt)))) throw new AuthorityVerificationError('Authority passport is outside its validity window');
  if (expected === 'passport') return AuthorityPassportSchema.parse(payload) as unknown as Record<string, unknown>;
  return DecisionReceiptSchema.parse(payload) as unknown as Record<string, unknown>;
}

/**
 * Offline proof-bundle verifier. The caller explicitly supplies the public
 * verification key from the sanitized bundle; no database or signing secret
 * is consulted. The result proves signature integrity and (when supplied)
 * issuer/audience claims, not payment settlement or database completeness.
 */
export async function verifySignedTokenOffline(
  token: string,
  expected: 'passport' | 'receipt',
  publicKeyPem: string,
  claims: { issuer?: string; audience?: string } = {},
): Promise<Record<string, unknown>> {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 8192) throw new AuthorityVerificationError('Invalid offline verification key');
  ensureEd25519PublicKey(publicKeyPem);
  const header = decodeProtectedHeader(token);
  if (header.alg !== AUTHORITY_ALGORITHM || header.typ !== (expected === 'passport' ? AUTHORITY_PASSPORT_TYP : AUTHORITY_RECEIPT_TYP)) {
    throw new AuthorityVerificationError('Unsupported algorithm or token type');
  }
  if (typeof header.kid !== 'string' || !header.kid) throw new AuthorityVerificationError('Missing authority key ID');
  const key = await importSPKI(publicKeyPem, AUTHORITY_ALGORITHM);
  const verified = await jwtVerify(token, key, {
    algorithms: [AUTHORITY_ALGORITHM],
  });
  const payload = verified.payload as Record<string, unknown>;
  if (payload.keyId !== header.kid) throw new AuthorityVerificationError('Signed payload key ID does not match protected header');
  if ((claims.issuer && payload.issuer !== claims.issuer) || (claims.audience && payload.audience !== claims.audience)) throw new AuthorityVerificationError('Authority issuer or audience mismatch');
  const now = Date.now();
  const issuedAt = Date.parse(String(payload.issuedAt || payload.decisionTimestamp || ''));
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000) throw new AuthorityVerificationError('Invalid authority validity timestamps');
  if (expected === 'passport') {
    const validFrom = Date.parse(String(payload.validFrom || ''));
    const expiresAt = Date.parse(String(payload.expiresAt || ''));
    if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt) || now < validFrom || now >= expiresAt) throw new AuthorityVerificationError('Authority passport is outside its validity window');
  }
  if (expected === 'passport') return AuthorityPassportSchema.parse(payload) as unknown as Record<string, unknown>;
  return DecisionReceiptSchema.parse(payload) as unknown as Record<string, unknown>;
}

export function publicKeyFingerprint(publicKeyPem?: string): string {
  const config = getAuthorityConfig();
  const pem = publicKeyPem || config.publicKeyPem;
  const der = crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export async function getPublicJwk(publicKeyPem?: string): Promise<Record<string, unknown>> {
  const config = getAuthorityConfig();
  const pem = publicKeyPem || config.publicKeyPem;
  return exportJWK(await importSPKI(pem, AUTHORITY_ALGORITHM));
}

export async function getPublicJwkForKeyId(keyId: string): Promise<Record<string, unknown>> {
  const config = getAuthorityConfig();
  const pem = config.verificationKeys[keyId];
  if (!pem) throw new AuthorityVerificationError('Unknown authority key ID');
  return exportJWK(await importSPKI(pem, AUTHORITY_ALGORITHM));
}

export function publicKeyFingerprintForKeyId(keyId: string): string {
  const config = getAuthorityConfig();
  const pem = config.verificationKeys[keyId];
  if (!pem) throw new AuthorityVerificationError('Unknown authority key ID');
  return publicKeyFingerprint(pem);
}

export function passportDigestFromToken(token: string): string {
  return digestPassportPayload(verifyPassportSync(token));
}

export function receiptDigestFromToken(token: string): string {
  return digestReceiptPayload(verifyDecisionReceiptSync(token));
}
