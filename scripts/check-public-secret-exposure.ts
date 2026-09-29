import fs from 'fs';
import path from 'path';
import { loadCliEnv } from '../src/infrastructure/config/load-cli-env';

const SECRET_NAMES = [
  'AUTHORITY_SIGNING_PRIVATE_KEY', 'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET', 'SARVAM_API_KEY', 'SESSION_SECRET',
] as const;

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target));
    else if (/\.(?:js|css|html|map|rsc|txt|json)$/.test(entry.name)) files.push(target);
  }
  return files;
}

loadCliEnv();
const publicFiles = [
  ...collectFiles(path.resolve(process.cwd(), '.next/static')),
  ...collectFiles(path.resolve(process.cwd(), '.next/server/app'))
    .filter((file) => !file.endsWith('.js') && !file.endsWith('.map')),
];
if (publicFiles.length === 0) {
  console.error('No public build artifacts found. Run pnpm run build before scanning.');
  process.exit(1);
}
let foundAny = false;
for (const name of SECRET_NAMES) {
  let value = process.env[name] || '';
  if (name === 'AUTHORITY_SIGNING_PRIVATE_KEY' && !value) {
    const fileName = process.env.AUTHORITY_SIGNING_PRIVATE_KEY_FILE;
    if (fileName) {
      try { value = fs.readFileSync(path.resolve(process.cwd(), fileName), 'utf8').trim(); } catch {}
    }
  }
  const found = value.length >= 8 && publicFiles.some((file) => fs.readFileSync(file).includes(value));
  foundAny ||= found;
  console.log(`${name}: ${found ? 'FOUND' : 'NOT_FOUND'}`);
}
console.log(`SCANNED_PUBLIC_ARTIFACT_FILES: ${publicFiles.length}`);
process.exitCode = foundAny ? 1 : 0;
