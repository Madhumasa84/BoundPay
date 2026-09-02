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
