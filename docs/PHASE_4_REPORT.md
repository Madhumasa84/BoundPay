# BoundPay Phase 4 Report — Authority Passports

**Scope:** Authority Passports, signed authorization decision receipts, the visual authorization debugger, and rigorous local security/concurrency/migration/browser coverage. Phase 1–3 architecture and verified provider evidence remain separate; Phase 4 adds no provider transaction and does not rerun the paid Sarvam evaluation.

## 1. Files and architecture changed

- `src/domain/passport.ts`: version-1 passport/receipt schemas, canonical digests, lifecycle and debugger types.
- `src/infrastructure/authority/signing.ts`: Ed25519/EdDSA compact-JWS signing, configured `kid` verification registry, strict claim/schema checks, JWK/fingerprint export, key validation, and explicit offline verifier.
- `src/services/passport.service.ts`: issuance, immutable storage, owner checks, revocation, consumption accounting, effective-policy composition, and signed receipts.
- `src/services/purchase.service.ts` and `src/services/execution.service.ts`: one passport per new intent, passport ID/digest in approval hash, proposal and atomic pre-dispatch revalidation, durable lifecycle receipts, and usage status transitions.
- `src/infrastructure/db/schema.ts` / `migrate.ts`: `authority_passports`, `passport_usages`, and `decision_receipts`, plus nullable legacy intent bindings. Existing Phase 3 columns/rows are preserved; no backfill rewrites old evidence.
- API routes under `src/app/api/passports`, `src/app/api/intents/[id]/{receipt,proof}`, and `src/app/api/receipts/verify`; all use existing session, same-origin, and owner conventions.
- `src/app/passports/page.tsx`, Shop debugger, Navbar/layout: focused Authority UI, passport selection, exact constraints/signature status/consumption/revocation, receipt proof, mode labels, keyboard/mobile support.
- `scripts/generate-authority-keys.ts`, `scripts/validate-authority-config.ts`, `.env.example`, `.gitignore`, and package scripts provide safe key/configuration handling.

## 2. Passport schema, signing, and key management

The immutable payload contains `schemaVersion`, IDs/issuer/audience/owner/operator/agent, INR currency, explicit non-empty merchant/category allowlists, integer-paise per-transaction and cumulative limits, approval threshold, canonical UTC `validFrom`/`expiresAt`, maximum usage count, issuance policy version, revocation nonce, `issuedAt`, and `keyId`. The compact JWS protected header is `{alg: "EdDSA", kid, typ}`. A standard Ed25519 signature is emitted with Node's maintained crypto implementation to preserve the synchronous Phase 3 proposal service; the maintained `jose` package verifies JWS asynchronously and supports offline proof verification.

Non-test startup/configuration requires `AUTHORITY_SIGNING_PRIVATE_KEY` (or `_FILE`), `AUTHORITY_SIGNING_PUBLIC_KEY` (or `_FILE`), `AUTHORITY_SIGNING_KEY_ID`, `AUTHORITY_ISSUER`, and `AUTHORITY_AUDIENCE`. Optional `AUTHORITY_VERIFICATION_KEYS_JSON` supports public-key rotation by `kid`. Unknown keys, unsupported algorithms, `alg=none`, malformed/oversized JWS, issuer/audience mismatch, invalid schema/timestamps, future issuance, and altered payload/signature fail closed. The private key is never returned/logged/bundled/committed or included in proof bundles. `AUTHORITY_TEST_MODE=true`/`NODE_ENV=test` is the only deterministic fallback and uses an unmistakably test-only key. `pnpm run authority:keys` writes ignored 0600/0644 local key files without printing the private key; `pnpm run authority:validate` is the explicit strict validation path.

## 3. Effective policy, revocation, and accounting

At authorization and inside the same SQLite `BEGIN IMMEDIATE` transaction that claims the intent, BoundPay intersects current server policy, signed passport constraints, trusted catalog values, existing commitments, and exact approval. The strictest amount and approval limits win; merchant/category must pass both; subscriptions cannot be enabled by a passport when server policy blocks them. Current policy/catalog/quote changes, stale approval, passport expiry, or revocation block execution before a provider call. The receipt is never the sole execution authorization.

`passport_usages` has a unique `(passport_id, intent_id)` row binding amount, adapter namespace, status, and timestamps. `RESERVED`, `COMMITTED`, `CONFIRMED`, and `UNKNOWN` continue consuming cumulative budget and usage allowance. Only a definite provider rejection becomes `RELEASED`; browser closure, lost responses, restart, date rollover, or ambiguous provider outcomes do not release it. MOCK and RAZORPAY_TEST are isolated namespaces, while each intent still has one spend-ledger row and one passport usage row per selected namespace.

Revocation is an owner-checked durable status update; revoked rows remain for audit. It is checked at proposal, approval, atomic reservation, and the handoff immediately before provider dispatch. Expiry is UTC-derived and persisted when observed. A revoked/expired authority after approval creates a durable blocked/expired intent and signed lifecycle receipt.

## 4. Decision receipts and proof

Every deterministic result (`ALLOWED`, `NEEDS_APPROVAL`, `BLOCKED`, `EXPIRED`, `REVOKED`) produces an immutable signed receipt. It includes schema/receipt ID, intent/request/passport IDs and digests, owner-bound agent, trusted product/merchant/category/quantity/unit price/total/currency, policy version, decision, stable reason codes, human explanation, observed passport budget, a clearly labeled projected post-execution budget, approval requirement, timestamp, issuer, audience, and `kid`. It is explicitly not a Razorpay payment receipt or execution capability.

`/api/intents/:id/receipt` returns the owned receipt; `/api/intents/:id/proof` returns a sanitized receipt/passport/JWK/fingerprint/instructions bundle; `/api/receipts/verify` verifies the compact JWS. Offline verification proves that the configured BoundPay authority signed unchanged contents. It does not independently prove issuer-database completeness, signing-host integrity, or a bank/provider transfer.

## 5. UI and accessibility

The Authority page issues, lists, inspects, copies/exports, consumes, and revokes passports, including ACTIVE/REVOKED/EXPIRED status and signature `kid`. Shop selects an ACTIVE passport and displays a debugger for signature, lifecycle, owner/agent, trusted catalog, merchant/category, subscription, transaction, passport budget/usage, server budget, approval, quote/policy versions, and execution permission. Every check shows PASS/FAIL/REQUIRES_ACTION, stable reason code, explanation, and value source. The UI labels server/model/signed fields, distinguishes LIVE_MODEL/FIXTURE and RAZORPAY_TEST/MOCK, labels projected balances, warns when policy is stricter or approval stale, supports receipt verification/proof download, keyboard-only operation, and 390×844 layouts.

## 6. Verification commands and results

Run these against fresh temporary databases; browser tests default to `/tmp/boundpay-e2e.sqlite` and use `AGENT_MODE=fixture`/`PAYMENT_ADAPTER_MODE=MOCK`:

```text
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:e2e
pnpm run build
pnpm run authority:validate
```

Additional suites cover fixed-seed property runs (seeds 4101 and 4102, 200 runs per property/seed), EdDSA/JWS and IDOR security, worker-thread contention using independent SQLite connections plus SharedArrayBuffer/Atomics, clean migration, and a copied Phase 3 database.

Final local verification on 2026-09-05:

- `pnpm run typecheck`: pass.
- `pnpm run lint`: pass (no warnings/errors; Next.js printed its separate deprecation notice for `next lint`).
- `pnpm test`: 24 files, 310 tests passed. The test configuration serializes test *files* because their intentional `DATABASE_PATH` changes and shared singleton connection are process-global; it does not weaken the independent-connection worker-thread contention cases.
- `pnpm run test:e2e`: 18/18 passed with `AGENT_MODE=fixture` and `PAYMENT_ADAPTER_MODE=MOCK`.
- `pnpm run build`: pass.
- `pnpm exec vitest run test/integration/phase4-migration.test.ts`: 2/2 passed (clean migration→seed→migration and migration of a copied Phase 3 database).
- `pnpm run authority:validate`: correctly failed closed in the unconfigured local shell; the explicit test-only configuration validated successfully. No secret value was printed.

The baseline full Vitest run initially exposed one SQLite `disk I/O error` in the deterministic manifest: concurrently executing files were changing `DATABASE_PATH` and closing the process-global default connection. Serializing files made that isolation explicit; the rerun passed all 310 tests. Routine deterministic test runs no longer overwrite `evaluation/deterministic-results.json`; regeneration requires `WRITE_EVALUATION_EVIDENCE=true`, preserving historical evidence after a partial failure.

## 7. Evidence and limitations

- **VERIFIED IN AUTOMATED TEST:** passport domain/crypto/policy/security/property/concurrency/migration/browser behavior, with no real provider requests.
- **VERIFIED IN RAZORPAY TEST MODE:** the existing Phase 3 test transaction/evidence; Phase 4 creates no additional Razorpay order.
- **VERIFIED IN LIVE SARVAM EVALUATION / REPORTED / NOT RERUN:** the existing Phase 3 20-case artifact; Phase 4 does not rerun paid cases.
- **PENDING / OUT OF SCOPE:** public deployment, HTTPS webhook reachability, real-money mode, production key rotation exercise, power-loss/corruption recovery, and third-party settlement proof.

This phase does not claim globally unique invention, patentability, production security, exactly-once external payment execution, immutable audit logs, real-money readiness, complete prompt-injection prevention, or an independent third-party verification of the issuer/database.

Secret/bundle inspection: `.env.local` is not tracked and `.env.local`, `*.pem`, and `.authority/` are ignored. `gitleaks` and `trufflehog` were not installed, so no claim of a complete history scan is made. A filename-only fallback scanned tracked content, staged changes, and Phase 4 working-tree files for private-key and common cloud/Razorpay/API-key signatures; the only match was the expected fake Razorpay test fixture in `test/unit/razorpay-adapter.test.ts`. The recent Phase 1–3 commit history was inspected by commit metadata. `.next/static` was scanned for authority-private-key, Sarvam, Razorpay-secret, and `NEXT_PUBLIC_` configuration identifiers; none were present. These checks do not prove that all secrets can never exist elsewhere.

## 8. Five-minute demo

1. Use a disposable `DATABASE_PATH=/tmp/boundpay-e2e.sqlite`, fixture agent mode, and MOCK payment mode.
2. Log in and open Passports; show OfficeBot's exact INR/merchant/category/amount/budget/approval/usage/expiry constraints and EdDSA `kid`.
3. Issue/select another ACTIVE passport, submit a low-value book/mouse, and walk every debugger stage/source.
4. Verify/download the signed decision receipt; reload and show persistence.
5. Approve a keyboard above threshold; separately revoke or expire a passport before execution and show durable denial/new-decision requirement.
6. State clearly that fixture/mock are synthetic, receipts are not payment receipts, and remaining production limitations are pending/out of scope.

## 9. Final verdict

**SUBMISSION-SAFE.** The complete automated suite and production build pass, the clean/copy migration checks preserve Phase 3 evidence, browser coverage is fixture+MOCK only, and the final static secret/bundle checks found no exposed signing material. The limitations above remain production follow-ups, not claims of production readiness.
