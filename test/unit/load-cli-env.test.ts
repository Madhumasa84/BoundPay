import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCliEnv } from '@/infrastructure/config/load-cli-env';

describe('standalone CLI environment loading', () => {
  it('preserves explicit empty values and gives .env.local priority over .env', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-cli-env-'));
    const names = ['BOUNDPAY_CLI_EXPLICIT', 'BOUNDPAY_CLI_LOCAL', 'BOUNDPAY_CLI_BASE'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      fs.writeFileSync(path.join(directory, '.env.local'), 'BOUNDPAY_CLI_EXPLICIT=wrong\nBOUNDPAY_CLI_LOCAL=local\n');
      fs.writeFileSync(path.join(directory, '.env'), 'BOUNDPAY_CLI_LOCAL=base\nBOUNDPAY_CLI_BASE=base\n');
      process.env.BOUNDPAY_CLI_EXPLICIT = '';
      delete process.env.BOUNDPAY_CLI_LOCAL;
      delete process.env.BOUNDPAY_CLI_BASE;

      loadCliEnv(directory);

      expect(process.env.BOUNDPAY_CLI_EXPLICIT).toBe('');
      expect(process.env.BOUNDPAY_CLI_LOCAL).toBe('local');
      expect(process.env.BOUNDPAY_CLI_BASE).toBe('base');
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
