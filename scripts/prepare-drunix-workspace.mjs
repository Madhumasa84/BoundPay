import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, '.drunix/source');
const revision = '3fb2b135a5b2adf7e1071d9b1624052a1bbb1772';
const goImage = 'golang:1.26.1@sha256:cd78d88e00afadbedd272f977d375a6247455f3a4b1178f8ae8bbcb201743a8a';
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}
fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
if (!fs.existsSync(source)) run('git', ['clone', '--depth', '1', '--branch', 'v1.0.0', 'https://github.com/npci/drunix.git', source]);
if (run('git', ['rev-parse', 'HEAD'], source, true) !== revision) throw new Error('Existing Drunix checkout does not match the pinned revision');
run('sh', ['scripts/prepare-drunix-local-network.sh', source]);
const bin = path.join(source, 'build/bin');
fs.mkdirSync(bin, { recursive: true });
const cache = path.join(root, '.drunix/go-build-cache');
fs.mkdirSync(cache, { recursive: true });
const tools = ['peer', 'cryptogen', 'configtxgen', 'configtxlator', 'osnadmin'];
// Compile matching official tools from vendored pinned source, without module downloads.
run('docker', ['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`,
  '-v', `${source}:/source`, '-v', `${cache}:/go-cache`, '-w', '/source',
  '-e', 'GOCACHE=/go-cache', '-e', 'GOPROXY=off', '-e', 'GOSUMDB=off', '-e', 'GOBIN=/source/build/bin',
  goImage, 'go', 'install', '-mod=vendor', '-buildvcs=false',
  '-ldflags', '-X github.com/npci/drunix/common/metadata.Version=1.0.0',
  ...tools.map((tool) => `./cmd/${tool}`)]);
// The official sample accidentally classifies its own 1.0.0 version as unsupported.
const networkScript = path.join(source, 'drunix-network/test-network/network.sh');
const contents = fs.readFileSync(networkScript, 'utf8');
const original = 'NONWORKING_VERSIONS="^1\\.0\\. ^1\\.1\\. ^1\\.2\\. ^1\\.3\\. ^1\\.4\\."';
const replacement = 'NONWORKING_VERSIONS="^1\\.1\\. ^1\\.2\\. ^1\\.3\\. ^1\\.4\\."';
if (!contents.includes(original) && !contents.includes(replacement)) throw new Error('Unexpected sample CLI version check; refusing to patch');
fs.writeFileSync(networkScript, contents.replace(original, replacement));
console.log(`Prepared persistent pinned Drunix source and matching tools at ${source}. Network startup and deployment remain explicit; see docs/ENGINEERING_UPGRADE.md.`);
