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
    command: 'AGENT_MODE=fixture PAYMENT_ADAPTER_MODE=MOCK PAYMENT_MODE=mock pnpm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      AGENT_MODE: 'fixture',
      PAYMENT_ADAPTER_MODE: 'MOCK',
      PAYMENT_MODE: 'mock',
    },
  },
});
