import { describe, expect, it } from 'vitest';
import { canonicalJcs, createCommitment, decryptCommitmentSalt, encryptCommitmentSalt } from '@/infrastructure/shared-authority/commitment';

describe('shared-authority commitments', () => {
  it('matches the chaincode RFC 8785 scope commitment vector', () => {
    const payload = {
      schemaVersion: 1,
      policyVersion: 7,
      allowedMerchantIds: ['demo_store'],
      allowedCategories: ['books'],
    };
    const salt = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

    expect(canonicalJcs({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(createCommitment('passport-scope', payload, salt).digest).toBe('69c751b8168ab999c26bc025ca3432ed419d62742a7bcc5b9f2f9e799c862f57');
  });

  it('does not normalize committed strings and rejects non-safe numbers', () => {
    expect(canonicalJcs({ value: 'é' })).not.toBe(canonicalJcs({ value: 'e\u0301' }));
    expect(() => canonicalJcs({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
    expect(() => canonicalJcs({ missing: undefined })).toThrow(/unsupported value/);
  });

  it('uses a fresh 32-byte salt and authenticates its encrypted local copy', () => {
    const first = createCommitment('purchase-scope', { amountPaise: 1200 });
    const second = createCommitment('purchase-scope', { amountPaise: 1200 });
    expect(first.salt).toHaveLength(32);
    expect(second.salt).toHaveLength(32);
    expect(first.digest).not.toBe(second.digest);

    const key = Buffer.alloc(32, 0x5a).toString('base64');
    const encrypted = encryptCommitmentSalt(first.salt, key);
    expect(decryptCommitmentSalt(encrypted, key)).toEqual(first.salt);
    expect(() => decryptCommitmentSalt(encrypted, Buffer.alloc(32, 0x6b).toString('base64'))).toThrow();
  });
});
