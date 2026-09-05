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
- Versioned Authority Passports: immutable EdDSA-signed, owner/agent-bound mandates with durable revocation, explicit merchant/category/amount/budget/usage constraints, and an atomic passport-usage ledger.
- Signed authorization decision receipts for every deterministic outcome, offline verification/proof bundles, and a keyboard-operable visual authorization debugger.

See [Architecture](docs/ARCHITECTURE.md), [Authority Passports](docs/AUTHORITY_PASSPORTS.md), [Threat model](docs/THREAT_MODEL.md), [Evaluation](docs/EVALUATION.md), and [Phase 4 report](docs/PHASE_4_REPORT.md).

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
- `AUTHORITY_SIGNING_PRIVATE_KEY` / `_FILE`: server-only Ed25519 PKCS#8 signing key. `AUTHORITY_SIGNING_PUBLIC_KEY` / `_FILE`, `AUTHORITY_SIGNING_KEY_ID`, `AUTHORITY_ISSUER`, and `AUTHORITY_AUDIENCE` are required for a configured non-test authority. Use `pnpm run authority:keys` for local files under ignored `.authority/`; never commit or log them.
- `AUTHORITY_VERIFICATION_KEYS_JSON`: optional `kid` → public-key map for verification-key rotation. Unknown key IDs and unsupported algorithms fail closed. `AUTHORITY_TEST_MODE=true` is deterministic and test-only.

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
pnpm run authority:validate
```

Phase 3 recorded 268/268 Vitest tests across 17 files and 15/15 Chromium Playwright tests. Phase 4 adds Authority Passport domain/crypto/security/property/migration tests and worker-thread contention using independent SQLite connections. All Phase 4 browser/integration automation runs with `AGENT_MODE=fixture` and `PAYMENT_ADAPTER_MODE=MOCK`; no Sarvam or Razorpay HTTP call is allowed. The 100-case deterministic manifest remains a separate historical artifact and is not overwritten.

Live model evaluation (Sarvam AI sarvam-105b): 20/20 executed, 0 skipped. Strict JSON Schema output verified with Zod business validation. 19/20 requests satisfied, 2 proposed policy violations (subscriptions) both strictly blocked by the deterministic policy gate, 0 unexpected payment provider order calls, median latency 6929 ms. Real Razorpay TEST transactions: 1 completed and verified with test credentials (order_TXcjbyB4QUPgxL, payment pay_TXcmIeKNdSAV4M, ₹2,799 captured, 1 confirmed ledger row, timing-safe HMAC signature verified, authoritative provider lookup confirmed). See [docs/RAZORPAY_TEST_VERIFICATION.md](docs/RAZORPAY_TEST_VERIFICATION.md). Razorpay Test Dashboard record is available for operator confirmation; actual provider webhook delivery remains pending an authorized public HTTPS domain.

## Deployment preparation

Build with `pnpm run build` and run with `pnpm start`. Deploy exactly one application instance with a persistent volume mounted at `DATABASE_PATH`; SQLite file locks and the in-process mock adapter are not a multi-instance design. Use HTTPS, strong environment-only secrets, `Secure` cookies (`NODE_ENV=production`), and a public HTTPS Razorpay webhook URL. Run migrations before start and back up the persistent volume. Re-run auth, webhook, payment, and browser smoke tests in the deployed environment.

No deployment or publication is performed by repository scripts.

## Authority Passport quick start

The `/passports` view issues and revokes owner-bound passports. Each new intent selects exactly one ACTIVE passport; omitted passport IDs in legacy Phase 3 service calls resolve to the seeded OfficeBot demo passport for compatibility. Passport constraints only intersect with (and can never widen) the current server policy. `UNKNOWN`, `COMMITTED`, and `CONFIRMED` usage rows continue consuming the passport budget and usage allowance; only a definite provider rejection releases a reservation.

Decision receipts are signed EdDSA compact JWS statements, not payment receipts and not execution capabilities. `/api/intents/:id/proof` downloads a sanitized receipt/passport/JWK/fingerprint bundle. Offline verification proves that the configured BoundPay authority signed unchanged contents; it does not prove database completeness, host integrity, or bank settlement. See [docs/AUTHORITY_PASSPORTS.md](docs/AUTHORITY_PASSPORTS.md) and [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Limitations

- One operator, one approved merchant, one currency, and one application instance.
- No claim of power-loss or storage-corruption durability.
- The audit is append-only through the application, not tamper-proof against a database administrator.
- The policy gate constrains explicit attributes; a model can still make an undesirable choice that technically satisfies policy.
- The live-model set is small and currently unexecuted; it cannot establish general prompt-injection immunity.
- Browser automation does not complete third-party Razorpay Checkout.
- Authority signing is intentionally single-authority and single-operator in this phase; key rotation is verification-key (`kid`) support, not a multi-organization trust system.

## AI coding-tool disclosure

Codex was used to inspect, implement, test, and draft Phase 3 artifacts. Human review is still required for credentials, actual provider/dashboard evidence, live-model result interpretation, deployment configuration, and final claim wording. Generated claims were checked against command output and machine-readable artifacts rather than treated as evidence by themselves.
