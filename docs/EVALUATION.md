# Evaluation

## Evidence separation

| Evidence class | Actual status | Artifact |
|---|---:|---|
| Deterministic authorization and SQLite payment state | 100/100 manifest cases passed; 182 requests | `evaluation/deterministic-cases.json`, `evaluation/deterministic-results.json` |
| Property/state invariants | fixed seeds; at least 200 runs per Phase 3 property per seed | `evaluation/property-seeds.json` |
| Live-model behavior | 0 run, 20 skipped: no API credential | `evaluation/live-model-cases.json`, `evaluation/live-model-results.json` |
| Real Razorpay TEST integration | 0 real transactions: credentials/manual Checkout unavailable | `evaluation/razorpay-test-results.json` |
| Browser/deployment behavior | 15/15 local Chromium scenarios; no hosted deployment test | Playwright output and `test/e2e/boundpay.spec.ts` |

These classes are not combined into a success percentage.

## Deterministic method

The checked-in 100-case manifest covers 30 autonomous valid purchases, 10 approval purchases, 15 budget violations, 10 category/subscription cases, 5 unapproved merchants, 5 expired policy/quote cases, 10 changed catalog/policy cases, 10 idempotency cases, and 5 forced-compromise subscription proposals. Every case creates an isolated migrated/seeded SQLite WAL database and calls production proposal, approval, catalog/policy, execution, audit, and ledger services. Only the external payment boundary is a counting capture fixture.

Actual result: 100 passed, 0 failed, 0 skipped; 182 declared application requests; 0 unexpected provider order calls, 0 duplicate provider order creations, 0 ledger mismatches, and 0 unresolved outcomes within this manifest. This is evidence about these cases and the explicit threat model, not “fraud precision/recall” or a general security guarantee.

The first run failed 12 cases: two expired quotes and ten catalog/policy invalidations remained `READY`/`APPROVED`. The provider call count was still zero. Root cause and fix are recorded in the build log; the retained cases now pass.

## Properties, concurrency, faults, and recovery

Phase 3 adds fixed seeds `424242` and `20260903` with 200 generated sequences/inputs per seed for terminal-state non-regression, approval mutation binding, and independent integer budget admission. Existing seed `42` covers invalid money, monotonicity, and total arithmetic with 500–1000 runs. No minimized counterexample remains after fixes.

Integration tests cover the two-keyboard budget race, repeated execution claims, approval/denial race, version edits racing execution, close/reopen persistence, adapter isolation, callback/webhook replay, early webhooks, wrong-amount early-webhook reconciliation, status refresh, and stale-execution recovery. Faults cover rejection, timeout, response loss, pending capture, duplicate capture, and thrown adapter exceptions. Tests use SQLite transaction locking and promise/worker scheduling; the suite does not claim power-loss or corrupt-storage durability. Some existing concurrency tests use multiple SQLite handles for inspection while application services share the process default connection, so cross-process contention remains a documented coverage gap.

## Latency

`evaluation/policy-latency.json` measures only the pure deterministic policy function on Node v20.20.2, linux/x64. It discards 100 warm-ups and records 1,000 samples: p50 0.003912 ms, p95 0.006722 ms, p99 0.023627 ms. It excludes SQLite, model, network/provider, and browser duration. The 100 isolated-database manifest took about 14–16 seconds as a suite, dominated by database creation/password hashing and not reported as policy decision latency.

Model latency, real provider latency, and third-party Checkout duration were not measured because the corresponding live runs were not possible.

## Live-model plan and limitation

The 20 cases were defined before Phase 3 prompt changes (none were made): 12 normal and 8 adversarial catalog variants, with development/final splits. Each future result must record case, provider/model, parameters, date, prompt/catalog version, actual product/quantity, request satisfaction, proposed violation, gate result, provider call count, refusal, timeout, and parse errors.

Forced-compromise results in the deterministic suite are synthetic gate tests, not observed model compromises. A small sample cannot establish prompt-injection immunity. The gate enforces explicit policy, but an agent may still make an undesirable choice that technically satisfies it.

## Razorpay TEST evidence plan

Contract tests stub Razorpay HTTP and verify request/response shape, signature checks, captured status, matching order/amount/currency, webhook replay, and refresh behavior. They are not real Razorpay TEST transactions. Before submission, complete one actual Standard Checkout and retain sanitized evidence of server-created order ID, Checkout order ID, captured payment ID/status, amount/currency, application ledger/audit, test dashboard record, and reload/status refresh. Never include credentials.

## Reproduction

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run db:seed
pnpm test
pnpm run test:e2e
pnpm run build
pnpm run eval:latency
pnpm audit --prod
```

Tests were run locally against Node 20.20.2 on linux/x64. Browser evidence used headless Chromium, one worker, and observable-state waits rather than fixed sleeps.
