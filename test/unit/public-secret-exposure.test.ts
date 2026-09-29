import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scanner = path.resolve('scripts/check-public-secret-exposure.ts');
const loader = require.resolve('tsx');
let directory: string;

function scan() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AUTHORITY_|RAZORPAY_|SARVAM_|SESSION_SECRET)/.test(name)) delete env[name];
  }
  return spawnSync(process.execPath, ['--import', loader, scanner], {
    cwd: directory, env, encoding: 'utf8', timeout: 15000,
  });
}

function artifact(content: string) {
  const target = path.join(directory, '.next/static');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'client.js'), content);
}

describe('public artifact secret exposure CLI', () => {
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-secret-scan-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('detects a secret from .env without printing its value', () => {
    const secret = 'test-only-session-secret-in-public-bundle';
    fs.writeFileSync(path.join(directory, '.env'), `SESSION_SECRET=${secret}\n`);
    artifact(`const leaked = '${secret}';`);
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('SESSION_SECRET: FOUND');
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('loads file-backed signing keys from .env.local ahead of .env', () => {
    const secret = 'test-only-private-key-content';
    fs.writeFileSync(path.join(directory, 'private.pem'), secret);
    fs.writeFileSync(path.join(directory, '.env'), 'AUTHORITY_SIGNING_PRIVATE_KEY_FILE=missing.pem\n');
    fs.writeFileSync(path.join(directory, '.env.local'), 'AUTHORITY_SIGNING_PRIVATE_KEY_FILE=private.pem\n');
    artifact(secret);
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('AUTHORITY_SIGNING_PRIVATE_KEY: FOUND');
  });

  it('passes for clean public artifacts', () => {
    fs.writeFileSync(path.join(directory, '.env'), 'SESSION_SECRET=test-only-private-session-secret\n');
    artifact('console.log("public content");');
    const result = scan();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SCANNED_PUBLIC_ARTIFACT_FILES: 1');
  });

  it('fails when no build artifacts exist', () => {
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run pnpm run build');
  });
});
