import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = Number(process.env.DRUNIX_DEMO_RUNS || 10);
if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('DRUNIX_DEMO_RUNS must be 1..100');
const output = path.join(root, '.boundpay-runs', `repeat-${Date.now()}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), requestedRuns: count, passedRuns: 0, status: 'RUNNING', runs: [], latencyMs: {} };
function save() { fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 }); }
async function run(index) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, ['scripts/drunix-boundpay-services-demo.mjs'], { cwd: root,
      env: { ...process.env, DRUNIX_DEMO_REVIEW_SECONDS: '0', DRUNIX_DEMO_AMBIGUOUS_FAULT: index % 2 ? 'SIMULATE_RESPONSE_LOSS' : 'SIMULATE_TIMEOUT' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`Run ${index + 1} exited ${code}`));
      try {
        const result = JSON.parse(stdout);
        if (!Object.values(result.checks).every((value) => value === true)) throw new Error('A demo assertion failed');
        resolve({ index: index + 1, elapsedMs: Math.round(performance.now() - start), ...result });
      } catch (error) { reject(error); }
    });
  });
}
save();
try {
  for (let index = 0; index < count; index++) {
    console.error(`Running ledger verification ${index + 1}/${count}`);
    report.runs.push(await run(index)); report.passedRuns++; save();
  }
  const groups = new Map();
  for (const run of report.runs) for (const measurement of run.measurements) {
    const key = `${measurement.method} ${measurement.route}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(measurement.latencyMs);
  }
  for (const [key, values] of groups) {
    values.sort((a, b) => a - b);
    report.latencyMs[key] = { samples: values.length, p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
  }
  report.status = 'PASSED';
} catch (error) { report.status = 'FAILED'; report.error = error.message; process.exitCode = 1; }
report.completedAt = new Date().toISOString(); save();
console.log(`Retained repeatability evidence: ${output}`);
