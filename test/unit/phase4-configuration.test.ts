import { afterEach, describe, expect, it } from 'vitest';
import { PaymentModeConfigurationError, resolvePaymentAdapterMode } from '@/domain/intent';
import { AuthorityConfigurationError, getAuthorityConfig } from '@/infrastructure/authority/signing';

describe('Phase 4 fail-closed payment mode configuration', () => {
  const previous = {
    adapter: process.env.PAYMENT_ADAPTER_MODE,
    legacy: process.env.PAYMENT_MODE,
  };

  afterEach(() => {
    if (previous.adapter === undefined) delete process.env.PAYMENT_ADAPTER_MODE;
    else process.env.PAYMENT_ADAPTER_MODE = previous.adapter;
    if (previous.legacy === undefined) delete process.env.PAYMENT_MODE;
    else process.env.PAYMENT_MODE = previous.legacy;
  });

  it('defaults only when neither variable is configured', () => {
    delete process.env.PAYMENT_ADAPTER_MODE;
    delete process.env.PAYMENT_MODE;
    expect(resolvePaymentAdapterMode()).toBe('MOCK');
  });

  it('accepts a matching legacy alias without silently changing the mode', () => {
    process.env.PAYMENT_ADAPTER_MODE = 'RAZORPAY_TEST';
    process.env.PAYMENT_MODE = 'razorpay_test';
    expect(resolvePaymentAdapterMode()).toBe('RAZORPAY_TEST');
  });

  it('rejects unsupported and conflicting values fail closed', () => {
    process.env.PAYMENT_ADAPTER_MODE = 'LIVE';
    delete process.env.PAYMENT_MODE;
    expect(() => resolvePaymentAdapterMode()).toThrow(PaymentModeConfigurationError);
    process.env.PAYMENT_ADAPTER_MODE = 'MOCK';
    process.env.PAYMENT_MODE = 'RAZORPAY_TEST';
    expect(() => resolvePaymentAdapterMode()).toThrow(/conflicting/i);
  });

  it('never enables the deterministic authority fallback in production', () => {
    // Node's type declarations expose NODE_ENV as readonly; the test still
    // needs to exercise the production guard in an isolated environment.
    const env = process.env as Record<string, string | undefined>;
    const oldNodeEnv = env.NODE_ENV;
    const oldTestMode = process.env.AUTHORITY_TEST_MODE;
    const oldPlaywright = process.env.PLAYWRIGHT_TEST;
    env.NODE_ENV = 'production';
    process.env.AUTHORITY_TEST_MODE = 'true';
    delete process.env.PLAYWRIGHT_TEST;
    expect(() => getAuthorityConfig()).toThrow(AuthorityConfigurationError);
    if (oldNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = oldNodeEnv;
    if (oldTestMode === undefined) delete process.env.AUTHORITY_TEST_MODE; else process.env.AUTHORITY_TEST_MODE = oldTestMode;
    if (oldPlaywright === undefined) delete process.env.PLAYWRIGHT_TEST; else process.env.PLAYWRIGHT_TEST = oldPlaywright;
  });
});
