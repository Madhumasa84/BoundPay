import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'PLAYWRIGHT_TEST=true AGENT_MODE=fixture PAYMENT_ADAPTER_MODE=MOCK PAYMENT_MODE=mock pnpm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      AGENT_MODE: 'fixture',
      PAYMENT_ADAPTER_MODE: 'MOCK',
      PAYMENT_MODE: 'mock',
      AUTHORITY_TEST_MODE: 'true',
      AUTHORITY_ISSUER: 'boundpay-test-authority',
      AUTHORITY_AUDIENCE: 'boundpay-agent',
      AUTHORITY_SIGNING_KEY_ID: 'test-only-key-v1',
      AUTHORITY_SIGNING_PRIVATE_KEY: '',
      AUTHORITY_SIGNING_PUBLIC_KEY: '',
      AUTHORITY_SIGNING_PRIVATE_KEY_FILE: '',
      AUTHORITY_SIGNING_PUBLIC_KEY_FILE: '',
      AUTHORITY_VERIFICATION_KEYS_JSON: '',
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
      SARVAM_API_KEY: '',
      PLAYWRIGHT_TEST: 'true',
    },
  },
});
