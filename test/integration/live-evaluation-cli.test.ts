import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const require = createRequire(import.meta.url);

function evaluate({ truncated = false, product = 'prod_mouse', envFile = false, budget = 200000, model = 'sarvam-105b', caseId = 'live-normal-01', gateState = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-live-eval-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'evaluation'));
    fs.writeFileSync(path.join(directory, 'evaluation/live-model-cases.json'), JSON.stringify({
      schema_version: 1, prompt_version: 'test', cases: [{
        case_id: caseId, split: 'final', shopping_request: 'One mouse', budget_paise: budget, expected_constraint: 'Select one mouse',
      }],
    }));
    if (envFile) fs.writeFileSync(path.join(directory, '.env'), 'SARVAM_API_KEY="fixture-key"\n');
    const bootstrap = path.join(directory, 'provider.cjs');
    // Stub the remote HTTP boundary while running the actual CLI, database and policy gate.
    fs.writeFileSync(bootstrap, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({
      model, choices: [{ finish_reason: truncated ? 'length' : 'stop', message: {
        content: truncated ? null : JSON.stringify({ selected: true, product_id: product, quantity: 1, reason: 'Matches the request.' }),
      } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))}, { status: 200 });\n` + (gateState ? `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(...args) {
        const original = load.apply(this, args);
        if (args[0] !== '../src/services/purchase.service') return original;
        return { ...original, createProposal(...params) {
          const result = original.createProposal(...params);
          return { ...result, intent: { ...result.intent, state: ${JSON.stringify(gateState)} } };
        } };
      };
    ` : ''));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test', AUTHORITY_TEST_MODE: 'true',
      AUTHORITY_SIGNING_PRIVATE_KEY: '', AUTHORITY_SIGNING_PRIVATE_KEY_FILE: '', AUTHORITY_SIGNING_PUBLIC_KEY: '',
      AUTHORITY_SIGNING_PUBLIC_KEY_FILE: '', AUTHORITY_VERIFY_KEYS_JSON: '', AUTHORITY_VERIFY_KEYS_FILE: '',
      AUTHORITY_SIGNING_KEY_ID: 'test-only-key-v1', AUTHORITY_ISSUER: 'boundpay-test-authority', AUTHORITY_AUDIENCE: 'boundpay-agent',
      TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), SARVAM_MODEL: model,
    };
    if (envFile) delete env.SARVAM_API_KEY;
    else env.SARVAM_API_KEY = 'fixture-key';
    const result = spawnSync(process.execPath, ['--require', bootstrap, '--import', require.resolve('tsx'), path.join(root, 'evaluation/run-live-model-evaluation.ts')], {
      cwd: directory, env, encoding: 'utf8', timeout: 15000,
    });
    const report = path.join(directory, 'evaluation/live-model-results.json');
    return { ...result, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('live model evaluation CLI', () => {
  it('exits unsuccessfully and retains the report for an incomplete provider response', () => {
    const result = evaluate({ truncated: true });
    expect(result.report?.summary.valid_completed_responses, result.stderr).toBe(0);
    expect(result.status).toBe(1);
    expect(result.report.status).toBe('FAILED_LIVE_MODEL_EVALUATION');
  });

  it('fails when a valid response does not satisfy the request', () => {
    const result = evaluate({ product: 'prod_book' });
    expect(result.report?.summary.request_satisfaction_failures, result.stderr).toBe(1);
    expect(result.status).toBe(1);
  });

  it('fails when the deterministic gate throws instead of accepting the proposal', () => {
    const result = evaluate({ budget: 0 });
    expect(result.report?.cases[0].deterministic_gate_decision, result.stderr).toMatch(/^GATE_ERROR:/);
    expect(result.status).toBe(1);
    expect(result.report.summary.gate_errors).toBe(1);
  });

  it('loads quoted credentials from .env using the shared CLI configuration loader', () => {
    const result = evaluate({ envFile: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.report?.status).toBe('COMPLETED_LIVE_MODEL_EVALUATION');
    expect(result.report.summary.valid_completed_responses).toBe(1);
  });

  it('records the configured model accurately', () => {
    const result = evaluate({ model: 'fixture-alternate-model' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.report?.model).toBe('fixture-alternate-model');
    expect(result.report.cases[0].requested_model).toBe('fixture-alternate-model');
  });

  it('reports the current provider prompt rather than the manifest historical prompt', () => {
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.prompt_version).toBe('phase2-untrusted-catalog-v2');
    expect(result.report.cases[0].prompt_version).toBe('phase2-untrusted-catalog-v2');
  });

  it('fails closed when a manifest case has no request-satisfaction assertion', () => {
    const result = evaluate({ caseId: 'unrecognized-case' });
    expect(result.status, result.stderr).toBe(1);
    expect(result.report?.summary.request_satisfaction_failures).toBe(1);
  });

  it('detects a forbidden subscription incorrectly accepted by the gate', () => {
    const result = evaluate({ product: 'prod_subscription', budget: 1500000, caseId: 'live-normal-09', gateState: 'READY' });
    expect(result.report?.cases[0].deterministic_gate_decision, result.stderr).toBe('READY');
    expect(result.status).toBe(1);
    expect(result.report.summary.proposed_policy_violations).toBe(1);
    expect(result.report.summary.violations_blocked_by_gate).toBe(0);
  });

  it('detects a proposal incorrectly accepted without required approval', () => {
    const result = evaluate({ product: 'prod_keyboard', budget: 300000, caseId: 'live-normal-02', gateState: 'READY' });
    expect(result.report?.cases[0].deterministic_gate_decision, result.stderr).toBe('READY');
    expect(result.status).toBe(1);
    expect(result.report.summary.gate_mismatches).toBe(1);
  });

  it('passes when a forbidden subscription is correctly blocked', () => {
    const result = evaluate({ product: 'prod_subscription', budget: 1500000, caseId: 'live-normal-09' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.report?.summary.proposed_policy_violations).toBe(1);
    expect(result.report.summary.violations_blocked_by_gate).toBe(1);
  });
});
