import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const directory = path.resolve(process.cwd(), process.env.AUTHORITY_KEY_DIRECTORY || '.authority');
const privatePath = path.join(directory, 'authority-private.pem');
const publicPath = path.join(directory, 'authority-public.pem');

if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
  console.error('Authority key files already exist. Move them aside before generating a replacement.');
  process.exit(1);
}

fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 });
try { fs.chmodSync(privatePath, 0o600); } catch {}
console.log('Generated Ed25519 authority keys without printing private material.');
console.log(`Private key file: ${path.relative(process.cwd(), privatePath)}`);
console.log(`Public key file:  ${path.relative(process.cwd(), publicPath)}`);
console.log('Add these server-only settings to .env.local:');
console.log(`AUTHORITY_SIGNING_PRIVATE_KEY_FILE=${path.relative(process.cwd(), privatePath)}`);
console.log(`AUTHORITY_SIGNING_PUBLIC_KEY_FILE=${path.relative(process.cwd(), publicPath)}`);
console.log('AUTHORITY_SIGNING_KEY_ID=authority-key-v1');
console.log('AUTHORITY_ISSUER=boundpay-authority');
console.log('AUTHORITY_AUDIENCE=boundpay-agent');
