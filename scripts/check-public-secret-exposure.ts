import fs from 'fs';
import path from 'path';

const SECRET_NAMES = [
  'AUTHORITY_SIGNING_PRIVATE_KEY', 'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET', 'SARVAM_API_KEY', 'SESSION_SECRET',
] as const;

function localEnvValues(): Record<string, string> {
  const values: Record<string, string> = {};
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value.replace(/\\n/g, '\n');
  }
  return values;
}

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

const dotenv = localEnvValues();
const publicFiles = [
  ...collectFiles(path.resolve(process.cwd(), '.next/static')),
  ...collectFiles(path.resolve(process.cwd(), '.next/server/app'))
    .filter((file) => !file.endsWith('.js') && !file.endsWith('.map')),
];
let foundAny = false;
for (const name of SECRET_NAMES) {
  let value = process.env[name] || dotenv[name] || '';
  if (name === 'AUTHORITY_SIGNING_PRIVATE_KEY' && !value) {
    const fileName = process.env.AUTHORITY_SIGNING_PRIVATE_KEY_FILE || dotenv.AUTHORITY_SIGNING_PRIVATE_KEY_FILE;
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
