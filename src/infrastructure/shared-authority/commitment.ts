import crypto from 'node:crypto';

export type CommitmentKind = 'passport-scope' | 'purchase-scope' | 'payment-outcome';

export interface SaltedCommitment {
  digest: string;
  salt: Buffer;
  saltBase64Url: string;
}

/** RFC 8785 canonical JSON for the schema values used here: ASCII object keys, safe integers, strings, booleans, arrays and objects. */
export function canonicalJcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Commitment payload numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJcs(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJcs(record[key])}`).join(',')}}`;
  }
  throw new Error('Commitment payload contains an unsupported value');
}

export function createCommitment(kind: CommitmentKind, payload: unknown, suppliedSalt?: Uint8Array): SaltedCommitment {
  const salt = suppliedSalt ? Buffer.from(suppliedSalt) : crypto.randomBytes(32);
  if (salt.length !== 32) throw new Error('Commitment salt must contain exactly 32 random bytes');
  const preimage = Buffer.concat([
    Buffer.from(`boundpay:commit:v1:${kind}`, 'utf8'),
    Buffer.from([0]),
    salt,
    Buffer.from(canonicalJcs(payload), 'utf8'),
  ]);
  return { digest: crypto.createHash('sha256').update(preimage).digest('hex'), salt, saltBase64Url: salt.toString('base64url') };
}

/** AES-256-GCM protects the off-chain salt needed to open a commitment. */
export function encryptCommitmentSalt(salt: Uint8Array, encodedKey = process.env.SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY): string {
  if (!encodedKey) throw new Error('SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY is required to protect commitment salts');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(salt), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCommitmentSalt(value: string, encodedKey = process.env.SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY): Buffer {
  if (!encodedKey) throw new Error('SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY is required to open commitment salts');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY must decode to 32 bytes');
  const [version, ivText, tagText, encryptedText, extra] = value.split('.');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra) throw new Error('Malformed encrypted commitment salt');
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const encrypted = Buffer.from(encryptedText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed encrypted commitment salt');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const salt = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (salt.length !== 32) throw new Error('Invalid commitment salt length');
  return salt;
}
