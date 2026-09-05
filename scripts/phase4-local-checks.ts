import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import { execFileSync, spawnSync } from 'child_process';
import { getAuthorityConfig } from '../src/infrastructure/authority/signing';
import { resolvePaymentAdapterMode } from '../src/domain/intent';
import { RazorpayTestAdapter } from '../src/infrastructure/payment/razorpay-test-adapter';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
function check(name: string, ok: boolean) {
  console.log(`${name}: ${ok ? 'VALID' : 'FAILED'}`);
  if (!ok) throw new Error(name);
}
try {
  const c = getAuthorityConfig({ requirePrivate: true });
  check('AUTHORITY_IDENTIFIERS', c.keyId === 'boundpay-local-2026-09-05' && c.issuer === 'urn:boundpay:local-authority' && c.audience === 'urn:boundpay:razorpay-test' && !c.testOnly);
  const message = crypto.randomBytes(32);
  check('ED25519_PAIR', crypto.verify(null, message, c.publicKeyPem, crypto.sign(null, message, c.privateKeyPem)));
  check('PAYMENT_MODE', resolvePaymentAdapterMode() === 'RAZORPAY_TEST');
  check('TEST_CREDENTIALS', !!process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && !!process.env.RAZORPAY_KEY_SECRET && !process.env.RAZORPAY_KEY_SECRET.startsWith('rzp_live_') && !process.env.RAZORPAY_KEY_SECRET.startsWith('live_'));
  new RazorpayTestAdapter({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! });
  let rejected = false;
  try { new RazorpayTestAdapter({ keyId: 'rzp_live_rejection_probe', keySecret: 'noncredential' }); } catch { rejected = true; }
  check('LIVE_KEY_REJECTION', rejected);
  const previous = process.env.PAYMENT_ADAPTER_MODE;
  process.env.PAYMENT_ADAPTER_MODE = 'LIVE';
  rejected = false;
  try { resolvePaymentAdapterMode(); } catch { rejected = true; }
  process.env.PAYMENT_ADAPTER_MODE = previous;
  check('LIVE_MODE_REJECTION', rejected);
  for (const p of ['.env.local', '.authority/authority-private.pem', '.authority/authority-public.pem']) {
    check('GIT_IGNORED', spawnSync('git', ['check-ignore', '-q', p]).status === 0);
    check('RESTRICTIVE_FILE_PERMISSION', (fs.statSync(p).mode & 0o077) === 0);
  }
  check('NO_PUBLIC_AUTHORITY_ENV', !Object.keys(process.env).some(k => k.startsWith('NEXT_PUBLIC_') && (k.includes('AUTHORITY') || process.env[k]?.includes(c.privateKeyPem.trim()))));
  const needles = [c.privateKeyPem.trim(), c.privateKeyPem.trim().split('\n').slice(1, -1).join('')];
  const contains = (b: Buffer) => needles.some(n => b.includes(n));
  const tracked = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
  check('PRIVATE_KEY_TRACKED_NOT_FOUND', !tracked.some(p => fs.existsSync(p) && fs.statSync(p).isFile() && contains(fs.readFileSync(p))));
  check('KEY_FILES_UNTRACKED', !tracked.some(p => p.startsWith('.authority/') || p.endsWith('.pem')));
  check('PRIVATE_KEY_DIFF_NOT_FOUND', !contains(execFileSync('git', ['diff', '--no-ext-diff'], { maxBuffer: 32 * 1024 * 1024 })) && !contains(execFileSync('git', ['diff', '--cached', '--no-ext-diff'], { maxBuffer: 32 * 1024 * 1024 })));
  process.env.AUTHORITY_REQUIRE_CONFIG = 'true';
  const validate = spawnSync('pnpm', ['run', 'authority:validate'], { encoding: 'utf8', env: process.env });
  check('REPOSITORY_AUTHORITY_VALIDATION', validate.status === 0);
  const exposure = spawnSync('pnpm', ['run', 'security:public-artifacts'], { encoding: 'utf8', env: process.env });
  check('PUBLIC_BUNDLE_PRIVATE_KEY_NOT_FOUND', exposure.status === 0 && !exposure.stdout.includes('SCANNED_PUBLIC_ARTIFACT_FILES: 0'));
} catch {
  console.log('LOCAL_SECURITY_CHECKS: FAILED');
  process.exitCode = 1;
}
