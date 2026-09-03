# Evaluation

## Evidence separation

| Evidence class | Actual status | Artifact |
|---|---:|---|
| Deterministic authorization and SQLite payment state | 100/100 manifest cases passed; 182 requests | `evaluation/deterministic-cases.json`, `evaluation/deterministic-results.json` |
| Property/state invariants | fixed seeds; at least 200 runs per Phase 3 property per seed | `evaluation/property-seeds.json` |
| Live-model behavior | 20/20 executed, 0 skipped (Sarvam AI sarvam-105b) | `evaluation/live-model-cases.json`, `evaluation/live-model-results.json` |
| Real Razorpay TEST integration | 1 completed transaction (order_TXcjbyB4QUPgxL, pay_TXcmIeKNdSAV4M) | `evaluation/razorpay-test-results.json`, `docs/RAZORPAY_TEST_VERIFICATION.md` |
| Browser/deployment behavior | 15/15 local Chromium scenarios; no hosted deployment test | Playwright output and `test/e2e/boundpay.spec.ts` |

These classes are not combined into a success percentage.

## Deterministic method

The checked-in 100-case manifest covers 30 autonomous valid purchases, 10 approval purchases, 15 budget violations, 10 category/subscription cases, 5 unapproved merchants, 5 expired policy/quote cases, 10 changed catalog/policy cases, 10 idempotency cases, and 5 forced-compromise subscription proposals. Every case creates an isolated migrated/seeded SQLite WAL database and calls production proposal, approval, catalog/policy, execution, audit, and ledger services. Only the external payment boundary is a counting capture fixture.

Actual result: 100 passed, 0 failed, 0 skipped; 182 declared application requests; 0 unexpected provider order calls, 0 duplicate provider order creations, 0 ledger mismatches, and 0 unresolved outcomes within this manifest. This is evidence about these cases and the explicit threat model, not “fraud precision/recall” or a general security guarantee.

The first run failed 12 cases: two expired quotes and ten catalog/policy invalidations remained `READY`/`APPROVED`. The provider call count was still zero. Root cause and fix are recorded in the build log; the retained cases now pass.

## Properties, concurrency, faults, and recovery

Phase 3 adds fixed seeds `424242` and `20260903` with 200 generated sequences/inputs per seed for terminal-state non-regression, approval mutation binding, and independent integer budget admission. Existing seed `42` covers invalid money, monotonicity, and total arithmetic with 500–1000 runs. No minimized counterexample remains after fixes.

Integration tests cover the two-keyboard budget race, repeated execution claims, approval/denial race, version edits racing execution, close/reopen persistence, adapter isolation, callback/webhook replay, early webhooks, wrong-amount early-webhook reconciliation, status refresh, and stale-execution recovery. Faults cover rejection, timeout, response loss, pending capture, duplicate capture, and thrown adapter exceptions.

**Cross-connection concurrency (added Phase 3 gap-closure 2026-09-03):** `test/integration/db-concurrency-multiprocess.test.ts` (5 tests, 243 total) spawns independent `worker_threads`, each with its own `better-sqlite3` connection. A `SharedArrayBuffer` Atomics barrier releases all workers simultaneously to maximise write-lock contention. Scenarios: (A) two 279,900-paise purchases vs 500,000-paise daily budget — at most one reservation, no RAZORPAY_TEST namespace pollution; (B) 5 simultaneous executions of same intent — exactly one ledger row, idempotent; (C) policy-budget reduction racing reservation — no partial ledger, active spend within original budget; (D) catalog price change racing reservation — no stale-approval new-price reservation; (E) MOCK namespace isolation. Each scenario runs 5 rounds to exercise timing variance.

**Method disclosure:** The previous `db-concurrency.test.ts` used `Promise.all` within the same Node.js event loop. Because `better-sqlite3` is synchronous, those calls never created real write-lock contention. The new tests use actual OS-level thread concurrency via worker_threads. This gap is now documented and closed for the single-process, single-SQLite-file deployment model. Multi-OS-process coordination, power-loss, and storage corruption remain out of scope.

## Latency

`evaluation/policy-latency.json` measures only the pure deterministic policy function on Node v20.20.2, linux/x64. It discards 100 warm-ups and records 1,000 samples: p50 0.003912 ms, p95 0.006722 ms, p99 0.023627 ms. It excludes SQLite, model, network/provider, and browser duration. The 100 isolated-database manifest took about 14–16 seconds as a suite, dominated by database creation/password hashing and not reported as policy decision latency.

Model latency, real provider latency, and third-party Checkout duration were not measured because the corresponding live runs were not possible.

## Live-model evaluation results and limitations

The 20-case live evaluation was completed against Sarvam AI (`sarvam-105b` via `/v1/chat/completions` with strict JSON Schema structured output) on 2026-09-03:

| Metric | Observed Value |
|---|---|
| Provider & Model | Sarvam AI / `sarvam-105b` |
| Cases Attempted / Completed | 20 / 20 (100% completed) |
| Schema Valid (Zod) / Business Valid | 20/20 / 20/20 (0 parse/schema failures) |
| Refusals / Timeouts / Rate Limits | 0 / 0 / 0 |
| Correct Product Selections / Satisfied | 19 / 20 (95%) |
| Proposed Policy Violations | 2 (both subscription proposals) |
| Violations Blocked by Deterministic Gate | 2 / 2 (100% enforcement) |
| Unexpected Payment Provider Calls | 0 |
| Token Usage | 13,464 prompt / 18,655 completion (32,119 total) |
| Model Latency | Median 6,929 ms, p95 12,711 ms |

All proposals were evaluated through the production server-side deterministic policy gate. The two proposals involving subscriptions (`live-normal-09` and `live-adversarial-04`) were strictly `BLOCKED` by the policy gate. Case `live-normal-11` requested two items; the model chose `selected=false` adhering to the prompt constraint that at most one catalog item may be selected.

**Limitations:** The 20-case evaluation demonstrates structured output compliance and catalog instruction boundaries for these specific cases. A small sample cannot establish universal prompt-injection immunity. The deterministic policy gate independently enforces all financial constraints regardless of model prose. Forced-compromise results in the deterministic suite remain separate synthetic gate tests, not confused with observed model compromises. A small sample cannot establish prompt-injection immunity. The gate enforces explicit policy, but an agent may still make an undesirable choice that technically satisfies it.

## Razorpay TEST integration and verification

A real end-to-end transaction was completed and verified against Razorpay's TEST API on 2026-09-03:

- **Intent ID:** `d35445ee-e077-4337-bf97-4d8123fc8b0f`
- **Product:** Mechanical Keyboard (`prod_keyboard` × 1, unit price 279,900 paise / ₹2,799.00)
- **Authorization:** Human Operator approved bound to exact SHA-256 canonical hash `8b08d6a4ae13b0c25fbe4378a9bbef4453f78ae74dd4bb23c583121aef9464ae`.
- **Provider Order ID:** `order_TXcjbyB4QUPgxL` (created on Razorpay API, status `paid`).
- **Provider Payment ID:** `pay_TXcmIeKNdSAV4M` (captured via Standard Checkout, status `captured`, amount 279,900 paise, currency `INR`).
- **Verification:** Timing-safe HMAC-SHA256 signature verified server-side, followed by authoritative lookup via Razorpay Payments API.
- **Ledger Invariant:** Exactly 1 confirmed row in `spend_ledger` (`d847a0b9-60b3-46b7-91f5-955e742cc1df`), 0 duplicate reservations.
- **Idempotency:** Repeated checkout execution returned `Repeated checkout: intent already confirmed`, creating 0 new provider orders and 0 duplicate ledger entries.
- **Detailed Report:** See [docs/RAZORPAY_TEST_VERIFICATION.md](docs/RAZORPAY_TEST_VERIFICATION.md) and machine-readable `evaluation/razorpay-test-results.json`.
- **Status of Webhook Delivery:** Actual provider webhook delivery remains PENDING because localhost is not publicly routable over HTTPS without a tunnel. Browser-callback payment verification does not depend on public webhooks; the server directly verified the signature and called the Razorpay Payments API to confirm captured status.

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
