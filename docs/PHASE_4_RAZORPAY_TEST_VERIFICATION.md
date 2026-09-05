# Phase 4 Razorpay TEST verification

Status: **COMPLETED — RAZORPAY TEST VERIFICATION**, 2026-09-05T05:55Z.

## Current attempt

The repository's `pnpm run authority:keys` generated a fresh random Ed25519 pair locally using Node crypto. Private format is PKCS#8 PEM; public format is SPKI PEM. Only five missing Authority settings were added to `.env.local`; existing values were preserved. Private/public PEM files and `.env.local` have mode 0600, and `.authority` has mode 0700. Neither key was committed or displayed.

Configured identifiers: issuer `urn:boundpay:local-authority`, audience `urn:boundpay:razorpay-test`, kid `boundpay-local-2026-09-05`. Configuration uses `AUTHORITY_SIGNING_PRIVATE_KEY_FILE`, `AUTHORITY_SIGNING_PUBLIC_KEY_FILE`, `AUTHORITY_SIGNING_KEY_ID`, `AUTHORITY_ISSUER`, and `AUTHORITY_AUDIENCE`.

The repository Authority validation command passed with private signing configuration required. A random-message sign/verify check confirmed the Ed25519 pair. Git ignore checks passed; the generated private key was not found in tracked files, staged/working diffs, or existing public bundles. No public Authority environment variable was found. These are scoped scans, not proof against every possible encoding or historical disclosure. Runtime probes rejected LIVE key and LIVE payment-mode configuration without making network calls. Razorpay TEST credential-prefix and mode checks passed.

Five targeted test files passed, 37 tests total, covering Authority signatures, passports, receipts, offline verification and mode binding. Initial typecheck passed. A subsequent typecheck of the newly added preparation runner failed with TS2775 (assertion helper declaration), causing dependent narrowing errors. The helper was corrected to a function declaration; final typecheck passed.

## Current attempt — 2026-09-05T02:22:30Z onward

The corrected preparation runner was executed once. Read-only Razorpay TEST preflight made one request and created no order. One live Sarvam request then failed with a non-retriable outcome; the bounded retry was not used. One ACTIVE passport was issued and verified before that call. No intent, ledger reservation, passport usage, or order was created.

During sanitized post-failure inspection, a diagnostic query accidentally printed the stored compact signed passport token. No private key, credential, cookie, or provider payment signature was printed, but this violated the strict prohibition on exposing signatures. Work stopped immediately. No further network call, order creation, approval, Checkout, replay, or Dashboard interaction occurred. Treat the token as exposed evidence and rotate the local Authority key before any future attempt; this run will not resume.

Sanitized state: provider orders 0; intents 0; ledger rows 0; passport-usage rows 0; passport status ACTIVE; database integrity `ok`. External calls: Sarvam 1; Razorpay read-only preflight 1; order creation 0; payment/status lookup 0; Checkout 0; other provider calls 0. Historical hashes remain unchanged.

## Remediation and controlled replacement attempt — 2026-09-05T02:30Z onward

The exposed passport was revoked immediately. An `EXPOSED_TOKEN_REVOKED` audit event records its ID, payload digest, incident classification and revocation evidence. A probe using that passport produced a durable `BLOCKED` intent with no ledger, usage or provider rows; it did not authorize execution. The token is not authentication: owner/session checks remain required. The private key was not printed or logged, is absent from Git changes and generated/public artifacts, and there is no evidence of environment or signing-process compromise. Only one signed passport token was exposed. Key rotation was not required and was not performed.

Diagnosis found the prior runner copied the mutable historical database catalog, where `prod_keyboard` was 429900 paise/version 2. The successful live evaluation and trusted source catalog define 279900 paise. With the stale quote, Sarvam could honestly decline the 400000-paise request; the runner then rejected that valid refusal at `LIVE_SARVAM`. The runner now sources the isolated catalog from `SEED_CATALOG_ITEMS`. A stubbed regression test reproduces the stale-quote refusal and confirms no coercion or fabrication. Sarvam boundary, purchase/passport, receipt, Razorpay signature tests, lint and typecheck pass.

After the fix, one replacement ACTIVE passport was issued under the same signing key and verified. One new live Sarvam request succeeded: HTTP 200, JSON response, request ID recorded, response body present, 3273 request bytes, 4287 response bytes, 6410 ms latency, no retry. The model selected `prod_keyboard`, quantity 1. Trusted catalog resolution is 279900 paise, INR, `demo_store`, `electronics`.

Exact intent awaiting approval:

| Field | Value |
| --- | --- |
| Agent | OfficeBot |
| Product / quantity | Mechanical Keyboard (`prod_keyboard`) / 1 |
| Trusted total | 279900 paise (₹2,799.00) |
| Merchant / category | `demo_store` / `electronics` |
| Replacement passport | `pass_4a8348f9-7c3f-4f78-bc79-3dc436df248d` |
| Passport digest | `fcc790e6647fe760899236fd4e4f10d53940419e27eb232aa8185f36ab51ecb2` |
| Key ID / issuer / audience | `boundpay-local-2026-09-05` / `urn:boundpay:local-authority` / `urn:boundpay:razorpay-test` |
| Signed payment mode | `RAZORPAY_TEST` |
| Policy version | 2 |
| Server approval threshold | 250000 paise (₹2,500) |
| Passport approval threshold | 300000 paise (₹3,000) |
| Passport expiry | 2026-09-05T03:33:36.664Z |
| Quote expiry | 2026-09-05T03:13:43.146Z |
| Approval digest | `4226e2ebe69cb7a9038ed238dbdaf883bf9307aefd7d73c1d2753268df3420aa` |
| Effective decision | `NEEDS_APPROVAL`; server threshold is stricter |

All decision checks passed except the deliberate `REQUIRES_ACTION`/`FAIL` approval checks: `SERVER_APPROVAL_REQUIRED`, `SERVER_APPROVAL_THRESHOLD_FAIL`, and `EXECUTION_REQUIRES_APPROVAL`. Passport signature, status, owner, agent, payment mode, merchant, category, limits, budgets, usage, currency, policy and quote checks passed. The signed decision receipt verifies offline. No order or reservation exists yet.

The first approved intent expired at its quote boundary before dispatch and was durably marked `EXPIRED`; no provider call was made. A local refresh reused the unchanged successful Sarvam result without another Sarvam request. Because the replacement passport had also expired while waiting, a second fresh ACTIVE replacement passport and exact intent were issued. Current approval gate:

- Passport: `pass_9b9bfceb-43f7-4528-95de-5f692f8d4566`, digest `b9b65c7c6175f21045f6f07d93c751fd2271b4ab0130cfc13c63a663be6083b3`, expiry `2026-09-05T06:11:26.523Z`.
- Intent: `bf5eba88-4efa-43e8-aa8b-c16b379e5853`, approval digest `627345e7e0de8437c99089588dd924cf324bb3e4f4e3c677adae8fcfadf264b2`, quote expiry `2026-09-05T05:51:26.551Z`.
- Exact fields remain OfficeBot, Mechanical Keyboard ×1, 279900 paise INR, `demo_store`/`electronics`, policy v2, signed mode `RAZORPAY_TEST`; effective decision remains `NEEDS_APPROVAL` because the server threshold is 250000 paise.

Aggregate external calls so far: Sarvam 2 (one failed stale-catalog attempt, one successful corrected attempt); Razorpay read-only preflight 1; Razorpay order creation 0; payment/status lookup 0; Checkout 0; other provider calls 0. No provider order, ledger reservation or passport usage exists.

## Approved execution checkpoint — 2026-09-05T05:43Z

The refreshed exact approval was accepted. Atomic claim and reservation completed with one execution claim, one `RESERVED` spend-ledger row and one `COMMITTED` passport-usage row. The normal Razorpay TEST adapter created exactly one order and persisted it safely:

- Provider order: `order_TYFC3NA5M8g7qI`
- Public checkout key ID: `rzp_test_TXcBZz6uF29B8d`
- Amount/currency: 279900 paise / INR
- Intent: `ORDER_CREATED`; ledger: one `RESERVED`; passport usage: one `COMMITTED`
- Provider order count: 1; provider payment ID: not yet present

Manual action required: open the local BoundPay Shop/Checkout page (`http://localhost:3000/shop` when the app is running), confirm the displayed order and complete Razorpay Standard Checkout using only Razorpay's simulated TEST payment option. Do not use real cards, bank accounts, UPI PINs or real money. I will perform no callback, payment lookup, replay or Dashboard verification until that manual Checkout step is complete.

## Payment confirmation and replay checkpoint — 2026-09-05T05:50Z

Manual simulated TEST Checkout completed. Authenticated Razorpay lookup returned `CAPTURED`; callback signature and order/payment binding were accepted by the application. Provider order `order_TYFC3NA5M8g7qI` has payment `pay_TYFqxNNBrbJRas`, amount 279900 paise and currency INR. Intent is `PAYMENT_CONFIRMED`; exactly one confirmed spend-ledger row and one confirmed passport-usage row exist for this transaction. Passport remaining budget is 220100 paise with one usage remaining; server remaining budget is 720100 paise. Offline decision-receipt verification, sanitized-proof check, audit secret/raw-response check and reload persistence all pass.

One idempotent replay returned the same confirmed order/payment result and created zero additional provider orders, ledger rows or passport usages. Aggregate external calls: Sarvam 2; Razorpay read-only preflight 1; Razorpay order creation 1; authenticated payment/status lookup 1; Checkout 1; other provider calls 0. Provider order count is exactly 1. The historical database hash remains `86cd1457db7b9eb6a48c9c90b2ce75c6ac2c7d209af86b63e84e289b7b987874`.

The remaining action is visual confirmation in the Razorpay TEST Dashboard that the matching order and captured payment are present. This evidence does not claim real-money readiness, webhook delivery, globally exactly-once external execution, or production readiness.

Dashboard visual confirmation received: the user confirmed that Razorpay TEST Dashboard shows the matching order `order_TYFC3NA5M8g7qI` and captured payment `pay_TYFqxNNBrbJRas` for 279900 paise INR. Phase 4's single authorized TEST transaction is complete. Final external-call counts are Sarvam 2, Razorpay read-only preflight 1, Razorpay order creation 1, authenticated payment/status lookup 1, manual Checkout 1, and other provider calls 0. Exactly one provider order, one confirmed ledger row and one confirmed passport-usage row exist. Replay added zero orders, ledger rows or usages. This does not claim real-money readiness, webhook delivery, globally exactly-once external execution or production readiness.

## Attempt history — 2026-09-05T02:03:01Z

Original outcome: **NEEDS FIXES — stopped at configuration validation**. The following records that initial attempt; its missing-configuration statements have been superseded by the current attempt above.

Git reference: `0e8110ab303e7be54ad0e45a3b5012fcc8e36e52`, with the existing uncommitted Phase 4 worktree preserved. No application code or historical evidence was changed by this run.

Created and migrated a fresh, unseeded dedicated database: `data/phase-4-razorpay-test-20260905T020301Z.sqlite`. The historical database was not opened by application services.

Configuration presence checks examined the process environment and local environment files without printing values. Sarvam API key is present, but authenticated model operation is unverified. Razorpay key has the TEST prefix, secret is present, and `PAYMENT_ADAPTER_MODE=RAZORPAY_TEST`. No live-prefixed Razorpay credential was detected. Source inspection confirms the adapter retains live-key rejection; no runtime rejection test was run.

Authority private/public key configuration, signing kid, issuer and audience are absent. Deterministic authority fallback is not enabled and was not used. Therefore no passport was issued and no cryptographic verification or exact-intent preparation was attempted. Configure dedicated Ed25519 authority signing material and explicit issuer/audience/kid locally before resuming; do not paste secrets into chat.

External-call counts for this run: Sarvam 0; Razorpay credential preflight 0; order creation 0; payment/status lookup 0; Checkout 0; other provider calls 0. No retries occurred. Provider orders created: 0. No intent, spend reservation, or passport usage was created. No ambiguous provider outcome exists.

LIVE_MODEL proposal, effective-policy evaluation, approval binding, passport/public verification information, provider order/payment identifiers, capture verification, offline receipt verification, reload/replay and Dashboard confirmation are all **NOT PERFORMED**. No approval or Checkout interaction is requested yet because there is no signed exact intent to approve.

Historical SHA-256 baseline:

| File | SHA-256 |
| --- | --- |
| data/boundpay.sqlite | 86cd1457db7b9eb6a48c9c90b2ce75c6ac2c7d209af86b63e84e289b7b987874 |
| evaluation/live-model-results.json | ae11f080ea19feaac0b6049b82f88f5b9f5b0d5b06cd64f024896712a480e1e6 |
| evaluation/razorpay-test-results.json | 0b46764b33048b93f62a4fb5a39dcc0e1d946f5b474045e5d47691e60bff6cf2 |
| evaluation/authority-passport-results.json | 12d6f653618990737895b693f667d7d6d1961323c09032e7e8f106965608629f |
| evaluation/final-security-results.json | ed93e78e1e009692ba555e00dd25e231067bb5b81f2bd1683bad2ef06161ee1f |
| docs/RAZORPAY_TEST_VERIFICATION.md | a9814b1002ae789b5795c925dc6dd5136de8e6ac06aefef4de86459857f76959 |

This incomplete run makes no claim of real-money readiness, webhook delivery, exactly-once external execution, or production readiness.
