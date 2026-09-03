# BoundPay Phase 3 Report

**Date:** 2026-09-03  
**Assessment:** Deterministic/local build, Sarvam-105b live-model evaluation, and actual Razorpay TEST transaction are **VERIFIED**; actual provider webhook delivery and deployed HTTPS hosting remain pending an authorized public environment.

## Final implementation status

Phase 3 preserves product scope and adds evidence and reliability around the existing Shop, Policy, Activity, proposal, authorization, ledger, and payment flows. Runtime modes are server-reported, mock/fixture behavior is explicit, exact approvals are inspectable, invalidation is durable, uncertain provider outcomes retain reservation, audit JSON persists, mobile controls are usable, and the authenticated demo runner changes only ordinary inputs/catalog or payment-adapter faults.

Financial fixes include durable `UNKNOWN` on adapter throw, shared-policy reduction protection for both adapter namespaces, committed `EXPIRED` state before returning revalidation errors, one-ledger-row database uniqueness, and amount/currency/order validation for early unmatched webhook reconciliation.

## Commands executed and actual results

| Command | Result |
|---|---|
| `pnpm run typecheck` | passed, 0 errors |
| `pnpm run lint` | passed, 0 warnings; deprecation notice for `next lint` |
| `pnpm test` | 268/268 passed in 17 files, 0 skipped |
| `pnpm run test:e2e` | 15/15 passed, Chromium, one worker, final pre-handoff run 12.9 s |
| `pnpm run build` | passed on Next.js 15.5.21 after route-handler compatibility update |
| clean `db:migrate`, `db:seed`, `db:migrate` | passed on a new temporary SQLite file |
| `pnpm run eval:latency` | 1,000 samples after 100 warm-ups; p50 0.003912 ms, p95 0.006722 ms, p99 0.023627 ms |
| `pnpm run eval:live` | 20/20 cases executed with Sarvam AI (sarvam-105b); 0 parse/schema errors, median latency 6929 ms |
| `pnpm audit --prod` | initial: 32 advisories; after remediation: no known vulnerabilities |

Machine-readable deterministic result: 100 cases, 182 requests, 100 passed, 0 failed/skipped, 0 unexpected provider calls, 0 duplicate provider orders, 0 ledger mismatches, 0 unresolved cases within the manifest. This suite uses production services and SQLite with a mock only at the payment-provider boundary.

## Concurrency gap — gap closure performed 2026-09-03

The existing `db-concurrency.test.ts` uses `Promise.all` around service calls within the same Node.js event loop. Because `better-sqlite3` is synchronous, no actual write-lock contention ever occurs between those "concurrent" calls — they always serialize on the single thread.

**Fix:** Added `test/integration/db-concurrency-multiprocess.test.ts` (5 tests) with a separate worker script `test/integration/concurrency-worker.ts`. Each worker opens an independent `better-sqlite3` connection and waits on a `SharedArrayBuffer` barrier so all workers release their `BEGIN IMMEDIATE` transactions within the same event-loop tick. 5 rounds × 2–5 workers are exercised per scenario.

| Scenario | Rounds × Workers | Result |
|---|---|---|
| A: Two 279,900-paise purchases vs 500,000-paise budget | 5 × 2 | At most one reservation; budget ≤ 500,000 paise; zero RAZORPAY_TEST rows from MOCK run |
| B: 5 simultaneous executions of same intent | 5 × 5 | Exactly one ledger row (unique-index); ≥1 success; all errors are controlled STATE_CONFLICT |
| C: Policy reduction racing reservation | 5 × 1+main | No partial ledger status; active spend ≤ original 500,000-paise budget |
| D: Price change racing reservation | 5 × 1+main | Committed amount = original 279,900 paise; no new-price reservation from old approval |
| E: MOCK namespace isolation | 1 | Zero RAZORPAY_TEST ledger rows from MOCK execution |

Method: `SharedArrayBuffer` `Atomics.store/wait/notify` barrier; `busy_timeout = 10,000 ms`; repeat to exercise timing variance. Limitations explicitly documented: power-loss, corruption, and multi-OS-process coordination are not tested.

## UNKNOWN outcome classification

| Outcome | Classification | Location |
|---|---|---|
| `UNKNOWN` after adapter throw | **Expected correct behavior** — reservation retained, intent persisted | `phase3-financial-regressions.test.ts`, `razorpay-checkout.test.ts` |
| `UNKNOWN` after timeout / response loss | **Expected correct behavior** — reconciliation path | `razorpay-checkout.test.ts` |
| Manifest `unresolved_outcomes: 0` | **Correct** — no manifest case produced an ambiguous/wrong outcome | `deterministic-results.json` |

No case is labeled "0 unresolved" to hide an actual uncertainty. The three tested UNKNOWN outcomes are intentional fault-injection cases where retaining the reservation IS the correct behavior.

## Configuration audit (2026-09-03)

| Variable | Status |
|---|---|
| `SESSION_SECRET` | Weak — development keyword in value; must replace for any shared environment |
| `OPERATOR_INITIAL_PASSWORD` | Default seed value — must replace for any shared environment |
| `OPERATOR_USERNAME` | Set |
| `DATABASE_PATH` | Set: `./data/boundpay.sqlite` |
| `PAYMENT_ADAPTER_MODE` | Set: `MOCK` |
| `AGENT_MODE` | Set: `live` in `.env.local` |
| `AI_PROVIDER` | Set: `sarvam` |
| `SARVAM_API_KEY` | Set in `.env.local` (active for live model eval) |
| `SARVAM_MODEL` | Set: `sarvam-105b` |
| `RAZORPAY_KEY_ID` | Set in `.env.local` (`rzp_test_...B8d`) |
| `RAZORPAY_KEY_SECRET` | Set in `.env.local` (authenticated against Razorpay API) |
| `RAZORPAY_WEBHOOK_SECRET` | Optional / Pending public HTTPS deployment |
| `APP_ORIGIN` | Set: `http://localhost:3000` |
| `QUOTE_VALIDITY_SECONDS` | Set: 600 s |

No live key (`rzp_live_`) was detected. The application hard-rejects live keys; this was verified by code inspection (`execution.service.ts` adapter selection, env read).

## Evidence by class

- **A — deterministic correctness:** verified locally by manifest, unit/integration, property, concurrency, fault, auth, signature, and recovery tests. Test count: 268/268 (17 files including the 5 cross-process tests and 25 Sarvam boundary tests).
- **B — live-model behavior:** 20/20 run with Sarvam AI (`sarvam-105b`), 0 skipped. Strict JSON Schema output verified with Zod. 19/20 requests satisfied; 2 proposed policy violations (subscriptions) were both strictly blocked by the deterministic policy gate. 0 unexpected payment provider calls.
- **C — Razorpay TEST:** 1 real transaction completed and verified with live test credentials (`order_TXcjbyB4QUPgxL`, `pay_TXcmIeKNdSAV4M`, ₹2,799 captured, exactly 1 confirmed ledger row, timing-safe HMAC signature verified, authoritative provider lookup confirmed). Idempotent replay and reload verified. See `docs/RAZORPAY_TEST_VERIFICATION.md`.
- **D — browser/deployment:** 15 local Chromium scenarios passed, including authentication redirect/logout, purchase/approval/block, duplicate behavior, model fixture failure, price invalidation, unknown/reconcile, reload, audit, and 390×844 mobile controls. No public HTTPS deployment or third-party Checkout browser automation was performed.

## Outstanding issues

- Operator confirmation of the matching record on the Razorpay Test Dashboard (`dashboard.razorpay.com`) for `order_TXcjbyB4QUPgxL` and `pay_TXcmIeKNdSAV4M`.
- Actual provider webhook delivery remains PENDING because localhost is not publicly routable over HTTPS without an authorized tunnel or public deployment.
- Public HTTPS deployment, persistent-volume verification, webhook reachability/signature smoke, and deployed browser checks are pending explicit deployment instruction.
- Cross-process SQLite races are now verified with worker_threads; power-loss durability, storage corruption, and multi-instance operation remain out of scope by design.
- Default development credentials must be replaced for any shared environment.
- The existing `next lint` script is deprecated in Next 15 and should move to ESLint CLI after the submission-critical verification window.

## Exact remaining human actions

1. Review repository diff and claim wording; commit only intended source/docs/evaluation artifacts, never `.env`, `.env.local`, databases, logs, or screenshots containing personal data.
2. Confirm matching Payment ID `pay_TXcmIeKNdSAV4M` and Order ID `order_TXcjbyB4QUPgxL` on your [Razorpay Test Dashboard](https://dashboard.razorpay.com/).
3. Create strong `SESSION_SECRET` and operator password in any shared deployment environment.
4. With explicit authorization to deploy, use one instance plus persistent storage, register the public HTTPS webhook URL with a dedicated webhook secret, then re-run auth, payment, webhook, reload, export, and mobile smoke tests.
5. Record the demo using `docs/DEMO_SCRIPT.md`; state any pending public webhook evidence plainly.

## Panel rehearsal questions

- Why is the authorization deterministic?
- What exactly does the human approve?
- Why is order creation different from payment confirmation?
- How do concurrent purchases share one budget safely?
- What happens if the provider succeeds but its response is lost?
- Why does retrying not create another order?
- What does the injection demonstration prove?
- What risks remain even when the policy passes?

Suggested answers: server-owned attributes and integer predicates decide authority; approval binds the full canonical purchase digest; provider order acceptance is not captured-payment proof; a serialized SQLite reservation shares the budget; uncertainty retains reservation and reconciles by known order/receipt; the state claim/idempotency prevents another dispatch; injection demonstrates policy enforcement only, not universal model immunity; subjective bad choices, compromised infrastructure/provider, stolen sessions/secrets, and single-instance operational risks remain.

## Readiness assessment

The repository is verified for local deterministic review, live Sarvam-105b structured model evaluation, and an actual completed Razorpay TEST transaction. Actual provider webhook delivery and deployed HTTPS hosting remain pending an authorized public environment.


