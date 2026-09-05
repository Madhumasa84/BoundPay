# Phase 3 Build Log

## Verified starting point

- Fresh Phase 2 baseline: 129/129 Vitest tests passed; typecheck and lint passed.
- No real OpenAI or Razorpay credentials were present. The prior Razorpay suites were adapter/HTTP fixtures, not real test payments.
- Runtime databases existed locally but are ignored by Git; they are not submission evidence.

## Defects reproduced and fixed

1. **Adapter exceptions were not durable.** A throw after reservation returned an in-memory `UNKNOWN` result while SQLite remained `EXECUTING`. Added a regression with a throwing adapter; the service now persists `UNKNOWN`, failure reason, audit event, and retained reservation.
2. **Policy reduction checked only MOCK commitments.** A Razorpay-test reservation could exceed a newly reduced shared policy. Reduction now checks both isolated modes and refuses a value below the larger commitment. Regression added.
3. **Expiry/invalidation rolled back.** The first 100-case manifest run failed 12 cases. Revalidation updated `EXPIRED` and threw inside one transaction, rolling back state/audit. It now commits the durable state and throws afterward. All 12 retained cases pass.
4. **Early webhook mismatch bypass.** A signed payment event retained before order persistence was reconciled later without amount/currency checks. Reconciliation now binds order ID, amount, and currency before ledger/state change; wrong data is ignored and audited.
5. **Misleading UI mode labels.** Navbar and Shop hard-coded mock/OpenAI badges. They now read authenticated server runtime mode and explicitly distinguish fixture, mock, live model, and Razorpay TEST.
6. **Dependency advisories.** `pnpm audit --prod` found 32 advisories (1 critical, 12 high, 16 moderate, 3 low), mostly against Next 14.2.24. Next was upgraded to 15.5.21 and patched transitive PostCSS/Sharp overrides were locked. The repeat audit reports no known vulnerabilities.

## Product/evidence changes

- Added immediate amount/budget controls, keyboard-operable product selection, exact approval digest/version/expiry display, dynamic provider labels, durable expired/unknown recovery text, narrow-mobile coverage, and an authenticated scenario panel using legitimate boundaries.
- Added a machine-readable 100-case manifest/results, fixed property seeds, 20-case live-model plan/results placeholder, Razorpay evidence status, and isolated policy latency result.
- Added browser cases for unauthenticated redirect, price invalidation, response loss/reconciliation, mobile controls, and logout.

## Checks rerun

- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed; Next 15 reports that `next lint` is deprecated, but it remains functional.
- `pnpm test`: final post-change run passed, 238/238 tests in 15 files.
- `pnpm run test:e2e`: 15/15 passed in Chromium after a clean reset.
- `pnpm run build`: final Next 15.5.21 production build passed after updating dynamic route handlers to the async-params contract.
- Clean migration → seed → migration on `/tmp/boundpay-phase3-clean-20260903.sqlite`: passed.
- `pnpm audit --prod`: initially failed with 32 findings; after remediation, passed with no known vulnerabilities.

## Human review still required

Review final copy, run live-model cases, complete and verify a real Razorpay TEST transaction/dashboard record, inspect the deployed HTTPS/webhook behavior, replace development credentials, and rehearse the evidence distinctions. No deployment, publication, message, or submission was performed.

## Phase 4 Authority Passport implementation

Phase 4 adds immutable, versioned Authority Passports and signed authorization decision receipts without replacing the Phase 3 proposal, policy, approval, reservation, adapter, audit, or Razorpay TEST architecture. A passport is an EdDSA compact JWS verified against a server-controlled `kid` registry. The private key is read only from server configuration/key files; `pnpm run authority:keys` generates ignored local files without printing private material. `passport_usages` is durable and unique per `(passport_id, intent_id)`; its consuming statuses include RESERVED, COMMITTED, CONFIRMED, and UNKNOWN. Revocation is an owner-checked durable status update and is rechecked under the same SQLite `BEGIN IMMEDIATE` claim and again before provider dispatch.

The effective decision is the intersection of current policy, signed passport, trusted catalog, existing commitments, and exact approval. Decision receipts cover ALLOWED, NEEDS_APPROVAL, BLOCKED, EXPIRED, and REVOKED outcomes and are proof statements, not execution capabilities or payment receipts. The `/passports` interface and Shop debugger expose sources, stable reason codes, budget projections, policy/passport differences, stale-approval warnings, and receipt verification without exposing signing secrets.

Phase 4 automated coverage includes domain/schema boundaries, EdDSA/JWS tampering and claim checks, owner/agent/IDOR security, fixed-seed fast-check properties (200 runs per seed), worker-thread contention with independent SQLite connections and SharedArrayBuffer barriers, clean and copied-database migrations, and Chromium UI/keyboard/mobile/proof flows. All browser/integration automation uses `AGENT_MODE=fixture` and `PAYMENT_ADAPTER_MODE=MOCK`; no Sarvam or Razorpay HTTP request is made. The existing Razorpay TEST evidence artifact is not rerun or replaced.

Use `DATABASE_PATH=/tmp/boundpay-e2e.sqlite pnpm run test:e2e` (the script now defaults to this isolated path) so browser resets cannot touch a persistent project database. Never run a reset command against a database containing verified provider evidence.
