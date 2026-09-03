# BoundPay

BoundPay demonstrates bounded financial authority for agentic commerce. A model or fixture may propose one catalog item, but it cannot set prices, approve a purchase, reserve budget, create a provider order, or confirm payment. Those operations remain in deterministic server services backed by SQLite.

This repository is a buildathon evaluation build, not a production payment product. Its scope is one operator, one approved merchant, INR integer-paise accounting, one application instance, Sarvam AI (sarvam-105b) proposal selection, and Razorpay Standard Checkout in TEST mode.

## What is implemented


- Server-owned, versioned catalog and spending policy.
- Explicit per-purchase budget and deterministic transaction, category, merchant, subscription, expiry, and daily-budget checks.
- Human approval bound to the SHA-256 digest of exact product, quantity, price, budget, policy/catalog versions, owner, merchant, and quote expiry.
- Atomic SQLite `BEGIN IMMEDIATE` reservation before provider dispatch; one ledger row per intent.
- Idempotent intent/order behavior, durable `UNKNOWN` outcomes, receipt/status reconciliation, signed callback and webhook verification, webhook replay handling, and append-only application audit export.
- Clearly separated `FIXTURE`/`LIVE_MODEL` proposal modes and `MOCK`/`RAZORPAY_TEST` payment modes.
- Authenticated scenario controls that modify normal inputs or inject mock faults at adapter boundaries; they never set a final decision.
- Responsive Shop, Policy, and Activity views with visible modes, amounts, exact approval data, recovery messages, and JSON audit export.

See [Architecture](docs/ARCHITECTURE.md), [Threat model](docs/THREAT_MODEL.md), [Evaluation](docs/EVALUATION.md), and [Phase 3 report](docs/PHASE_3_REPORT.md).

## Setup

Requirements: Node.js 20+, pnpm 10+, and persistent local storage for SQLite.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run db:seed
pnpm run dev
```

Open `http://localhost:3000`. Local seed credentials are `operator` / `BoundPayPass123!`; replace `OPERATOR_INITIAL_PASSWORD` and `SESSION_SECRET` before any shared deployment.

Important environment values:

- `DATABASE_PATH`: persistent SQLite file path.
- `AGENT_MODE=fixture|live`; live requires `SARVAM_API_KEY` (model `sarvam-105b` via `/v1/chat/completions`) or optional `OPENAI_API_KEY`.
- `PAYMENT_ADAPTER_MODE=MOCK|RAZORPAY_TEST`; Razorpay TEST requires test key ID/secret and webhook secret. `rzp_live_` keys are rejected.
- `QUOTE_VALIDITY_SECONDS`: exact-intent quote lifetime.

Live mode never silently falls back to fixtures. Existing intents retain the adapter mode they were created with.

## Demo

Use the “Authenticated demo scenario runner” on Shop and follow [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md). Reset first for a predictable local demo:

```bash
CONFIRM_RESET=true pnpm run db:reset
pnpm run build
pnpm start
```

A genuine Razorpay TEST demonstration still requires the operator to supply credentials, configure a reachable signed webhook, complete Checkout, and capture matching dashboard evidence. Do not present a mock confirmation as that evidence.

## Verification commands and current evidence

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:deterministic
pnpm run test:state
pnpm run test:e2e
pnpm run build
pnpm run eval:latency
pnpm audit --prod
```

Phase 3 verified 268/268 Vitest tests across 17 files and 15/15 Chromium Playwright tests. Tests include 5 cross-process concurrency scenarios using worker_threads and SharedArrayBuffer barriers to exercise real SQLite write-lock contention across independent connections, and 25 dedicated Sarvam AI provider boundary tests. The 100-case deterministic manifest issued 182 application-level requests through real services and isolated SQLite databases; the only mocked component was the external payment provider. It recorded 100 passes, no skipped cases, no unexpected provider order calls, no duplicate order creation, and no ledger mismatch within those cases. The production dependency audit reported no known vulnerabilities after upgrading Next.js and overriding vulnerable transitive versions.

Live model evaluation (Sarvam AI sarvam-105b): 20/20 executed, 0 skipped. Strict JSON Schema output verified with Zod business validation. 19/20 requests satisfied, 2 proposed policy violations (subscriptions) both strictly blocked by the deterministic policy gate, 0 unexpected payment provider order calls, median latency 6929 ms. Real Razorpay TEST transactions: 1 completed and verified with test credentials (order_TXcjbyB4QUPgxL, payment pay_TXcmIeKNdSAV4M, ₹2,799 captured, 1 confirmed ledger row, timing-safe HMAC signature verified, authoritative provider lookup confirmed). See [docs/RAZORPAY_TEST_VERIFICATION.md](docs/RAZORPAY_TEST_VERIFICATION.md). Razorpay Test Dashboard record is available for operator confirmation; actual provider webhook delivery remains pending an authorized public HTTPS domain.

## Deployment preparation

Build with `pnpm run build` and run with `pnpm start`. Deploy exactly one application instance with a persistent volume mounted at `DATABASE_PATH`; SQLite file locks and the in-process mock adapter are not a multi-instance design. Use HTTPS, strong environment-only secrets, `Secure` cookies (`NODE_ENV=production`), and a public HTTPS Razorpay webhook URL. Run migrations before start and back up the persistent volume. Re-run auth, webhook, payment, and browser smoke tests in the deployed environment.

No deployment or publication is performed by repository scripts.

## Limitations

- One operator, one approved merchant, one currency, and one application instance.
- No claim of power-loss or storage-corruption durability.
- The audit is append-only through the application, not tamper-proof against a database administrator.
- The policy gate constrains explicit attributes; a model can still make an undesirable choice that technically satisfies policy.
- The live-model set is small and currently unexecuted; it cannot establish general prompt-injection immunity.
- Browser automation does not complete third-party Razorpay Checkout.

## AI coding-tool disclosure

Codex was used to inspect, implement, test, and draft Phase 3 artifacts. Human review is still required for credentials, actual provider/dashboard evidence, live-model result interpretation, deployment configuration, and final claim wording. Generated claims were checked against command output and machine-readable artifacts rather than treated as evidence by themselves.
