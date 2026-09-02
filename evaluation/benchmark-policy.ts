import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { evaluateSpendingPolicy, SpendingPolicy } from '../src/domain/policy';
import { Product } from '../src/domain/catalog';

const policy: SpendingPolicy = {
  id: 'benchmark', version: 1, currency: 'INR', max_transaction_amount_paise: 400000,
  daily_budget_paise: 500000, approval_threshold_paise: 250000,
  allowed_categories: ['electronics', 'books'], approved_merchant_id: 'demo_store',
  allow_subscriptions: false, expires_at: '2027-01-01T00:00:00.000Z', created_at: '2026-09-03T00:00:00.000Z',
};
const product: Product = {
  id: 'prod_keyboard', name: 'Mechanical Keyboard', description: '', unit_price_paise: 279900,
  currency: 'INR', category: 'electronics', is_subscription: false, merchant_id: 'demo_store',
  version: 1, is_active: true, updated_at: '2026-09-03T00:00:00.000Z',
};
const run = () => evaluateSpendingPolicy({ policy, product, quantity: 1, purchaseBudgetPaise: 300000, currentDayConfirmedPaise: 0, currentActiveReservationsPaise: 0, nowIso: '2026-09-03T12:00:00.000Z' });
for (let i = 0; i < 100; i++) run();
const samples: number[] = [];
for (let i = 0; i < 1000; i++) {
  const start = performance.now();
  run();
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const percentile = (p: number) => samples[Math.ceil((p / 100) * samples.length) - 1];
const result = {
  schema_version: 1,
  measurement: 'deterministic in-process policy evaluation only',
  excludes: ['SQLite', 'model latency', 'provider latency', 'browser checkout duration'],
  environment: { runtime: process.version, platform: `${process.platform}/${process.arch}` },
  warmup_samples_discarded: 100,
  sample_count: samples.length,
  milliseconds: {
    min: Number(samples[0].toFixed(6)),
    median_p50: Number(percentile(50).toFixed(6)),
    p95: Number(percentile(95).toFixed(6)),
    p99: Number(percentile(99).toFixed(6)),
    max: Number(samples.at(-1)!.toFixed(6)),
  },
};
fs.writeFileSync(path.resolve(process.cwd(), 'evaluation/policy-latency.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
