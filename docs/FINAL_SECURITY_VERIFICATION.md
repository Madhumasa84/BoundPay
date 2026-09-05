# Final Security Verification — Phase 4 Authority Passports

Date: 2026-09-05 (Asia/Kolkata)  
Reference tested: `main` / `0e8110ab303e7be54ad0e45a3b5012fcc8e36e52` plus the uncommitted Phase 4 worktree  
Verdict: **SUBMISSION-SAFE WITH DOCUMENTED LIMITATIONS**

## Scope and method

This was an adversarial verification and targeted-remediation pass, not acceptance of the Phase 4 report. It inspected configuration, schema/migration code, authentication, APIs, signing, policy composition, approval binding, execution, reconciliation, proof bundles, UI, tests, documentation, lockfile, build artifacts, tracked/staged/worktree content, and reachable Git history. It exercised malformed and altered JWS values, IDOR attempts, cross-mode use, SQLite races, child-process contention, migration rollback, controlled persistence faults, randomized test ordering, mobile/keyboard browser behavior, and provider-boundary mocks.

No Sarvam or Razorpay HTTP request was made. No Razorpay order was created. Browser runs were pinned to `AGENT_MODE=fixture` and `PAYMENT_ADAPTER_MODE=MOCK`, with all provider credentials and authority private-key inputs explicitly cleared from both reset and web-server process trees. Integration cases that name `RAZORPAY_TEST` use injected in-process adapters/custom fetches only to exercise namespace and callback logic.

## Actual authorization path

| Stage | Trust/data/state boundary | Race/failure behavior |
|---|---|---|
| Authentication | HttpOnly session cookie → hashed session lookup; owner ID comes from the session, never request JSON | Unauthenticated/expired/cross-origin requests fail before mutation; private responses are `no-store` |
| Passport selection | Client supplies only a passport ID and agent ID; server loads the immutable owned record | Missing/non-owned/mismatched identity fails closed |
| Signature verification | Protected `alg`, `typ`, `kid`; trusted configured key registry; issuer/audience/schema/timestamps | Unknown/retired key, malformed/oversized token, altered header/payload/signature, role confusion, future/expired authority fail closed |
| Catalog resolution | Product ID is untrusted; merchant/category/price/currency/subscription/version come from current catalog | Missing/inactive/changed product blocks or expires the intent |
| Effective policy | Current server policy intersects signed passport and catalog values | Either layer may restrict; neither may expand the other; approval is required if either layer requires it |
| Decision + receipt | Canonical trusted request hash, passport ID/digest, agent, policy/product versions and payment mode are signed | Intent, audit event and decision receipt now commit atomically |
| Approval | Approval stores the exact canonical hash | Any approval-bound field change invalidates approval |
| Claim/reservation | One `BEGIN IMMEDIATE` transaction revalidates passport/policy/catalog/approval and writes intent claim, spend ledger, passport usage and audit | This is the execution/revocation linearization point; unique constraints and write serialization prevent duplicate reservations |
| Provider dispatch | Adapter call happens only after committed reservation and outside SQLite | Definite rejection releases; lost/ambiguous response becomes durable `UNKNOWN` and retains both reservations |
| Confirmation | Callback, status refresh, webhook and mock capture validate provider result, then use one atomic finalizer | Callback/refresh/webhook races serialize; only one confirmation audit transition is created |
| Receipt/proof | Authorization receipt is not read as an execution capability; execution revalidates authoritative state | Offline JOSE verification works with only the compact JWS and public key; it does not prove settlement/database completeness |

Repository search found one order-creation call site: `ExecutionService.executeIntent` after `claimAndReserveAtomic`. Other adapter calls confirm or inspect an existing provider order; they do not create one. No legacy order-creation route bypass was found.

## Findings and remediation

### HIGH — fixed

1. Signed passports lacked an environment/payment-mode claim. Added versioned `paymentAdapterMode`, signed it, bound it into the canonical approval digest, selected defaults by explicit mode, and rejected cross-mode use.
2. `executeIntent` returned completed/order-created results before checking ownership. Ownership now precedes every idempotent early return; regression IDOR tests deny the other operator.
3. UI hydration could overwrite an explicitly selected passport. User selection is now sticky, and proposal controls remain disabled until an active passport is selected.
4. Intent idempotency equivalence ignored passport/digest/agent. Conflicting replacement now returns a conflict rather than reusing old authority.
5. Post-provider intent/ledger/passport/audit writes could partially commit. Authorization creation and lifecycle transitions now use atomic SQLite transactions; injected receipt/audit failures prove rollback or durable `UNKNOWN` recovery.
6. The callback/status-refresh/webhook confirmation paths had distinct non-atomic finalizers. They now share a transaction-level linearization point; a race produces one ledger, usage and confirmation audit.
7. Browser tests could inherit `.env.local` authority/provider inputs, while reset and server could use different keys. The E2E command now pins fixture/mock and clears every relevant secret variable for the whole process tree.

### MEDIUM — fixed

1. Database lifecycle/status/nonnegative invariants were only service-level. Migration triggers now enforce valid passport lifecycle, usage/ledger status, payment namespace and nonnegative amount on insert/update.
2. Migration DDL was not one explicit atomic unit. Migration, compatibility columns/indexes and invalid-row preflight now run in one immediate transaction; an injected invalid row proves DDL rollback.
3. Audit payloads included complete adapter raw responses. Authority execution audits now record bounded provider status/IDs rather than complete provider response objects.
4. Intent JSON parsing lacked the passport endpoints' content-type/body-size guard, and generic 500 responses could echo internal exception text. Shared bounded JSON parsing and sanitized server errors are now used.

### Documented limitations

- Compact JWS signing and the synchronous enforcement verifier use Node's maintained Ed25519 implementation with strict JOSE serialization checks; the maintained `jose` package performs the independent async/server and offline verification paths. This preserves the synchronous service architecture but is not a fully `jose`-implemented signing path.
- SQLite and in-process orchestration are appropriate for this submission, not distributed production. External payment execution is not exactly-once; ambiguous provider boundaries intentionally become durable `UNKNOWN` and require reconciliation.
- Revocation wins if committed before claim/reservation or observed before dispatch. It cannot cancel an already-validly dispatched provider order.
- Missing `Origin` and `Referer` are accepted for non-browser clients unless `Sec-Fetch-Site` is cross-site. Browser CSRF protection additionally relies on `SameSite=Lax`; a token-based CSRF scheme is not implemented.
- Production Playwright is intentionally one browser worker because scenarios share a reset demo database and mutate policy/catalog state. Vitest file serialization was removed; all unit/integration files pass under supported default parallel scheduling and randomized order.
- Audit records are persistent but not hash-chained. Multi-tenant organizations, durable workers, refunds, disputes and live payments remain out of scope.
- No Phase 4 Razorpay TEST transaction was performed. Phase 4 provider-boundary behavior is verified with mocks; the previous Phase 3 Razorpay TEST transaction remains separately verified.

## Test evidence

- Baseline before remediation: typecheck and lint passed; Vitest passed 24 files/310 tests; the first E2E baseline failed 1 of 18 and exposed the selected-passport race. The pre-remediation production build/audit were not separately captured and are not claimed as baseline evidence.
- Final default Vitest: 27 files/335 tests passed. Five complete successful runs were recorded: two normal-order runs and randomized seeds `735001`, `735002`, `735003` (the earlier normal run contained 333 tests; the final contained 335 after two additional regressions).
- Critical Phase 4 properties use seeds `4101`, `4102`, `1278130507`, 500 runs per property per seed (eight properties; 12,000 generated cases).
- Worker-thread contention using independent SQLite connections: 25 rounds of two-purchase final-budget contention, five same-intent executions, revocation, policy and catalog races, plus namespace isolation.
- Actual OS-process contention: two child processes competing for the final passport use/budget and five child-process replays of one intent; both passed.
- Controlled faults: receipt persistence rollback; confirmation-audit failure → durable `UNKNOWN`; provider exception/response loss; restart recovery; callback/status race.
- Migration: clean → migrate → seed → rerun, copied historical database migration, invalid-row refusal/DDL rollback, foreign-key check and `PRAGMA integrity_check` passed.
- Playwright: two consecutive final runs, 18/18 each, including passport creation/selection/revocation/expiry, debugger checks, receipt verification/tamper, reload, mobile, keyboard, logout and ownership.
- Deterministic manifest: 100/100 passed without regenerating or overwriting paid/historical evidence.
- `pnpm audit --prod`: no known vulnerabilities reported. `jose` 6.2.11 is MIT licensed. Frozen offline install confirmed lockfile consistency.

## Secret and evidence review

`gitleaks` and `trufflehog` were unavailable. Git-native scans covered tracked paths/content, staged diff (empty), worktree names/diff, and all reachable commits for live-key/private-key/token-shaped patterns. Matches were limited to documented placeholders, defensive regexes and test adapter fixtures; no tracked PEM/JWK/database/screenshot was found. `.env.local` is ignored. The production public-artifact checker compared configured secret values against 94 generated `.next/static` and public HTML/RSC/text/JSON/map artifacts and reported `NOT_FOUND` for authority private key, Razorpay secret/webhook secret, Sarvam key and session secret. This is scoped evidence, not a claim that arbitrary future data is secret-free.

Historical evidence and the original database were hashed before and after and remained byte-identical:

- `evaluation/deterministic-results.json`: `54cf454490d50c2eb1b9db292df8d6fbe029d61f6f45ec44975781ad7ef6276b`
- `evaluation/live-model-results.json`: `ae11f080ea19feaac0b6049b82f88f5b9f5b0d5b06cd64f024896712a480e1e6`
- `evaluation/razorpay-test-results.json`: `0b46764b33048b93f62a4fb5a39dcc0e1d946f5b474045e5d47691e60bff6cf2`
- `docs/RAZORPAY_TEST_VERIFICATION.md`: `a9814b1002ae789b5795c925dc6dd5136de8e6ac06aefef4de86459857f76959`
- `data/boundpay.sqlite`: `86cd1457db7b9eb6a48c9c90b2ce75c6ac2c7d209af86b63e84e289b7b987874`

## Five-minute evidence demo

1. Start in fixture/mock mode, sign in, open Passports and create the documented OfficeBot-style passport.
2. Select it in Shop, submit the low-value mouse, expand all 14 debugger checks, verify/download the signed authorization receipt, then execute the mock purchase.
3. Submit the keyboard, show `NEEDS_APPROVAL`, approve the exact digest, and show stale approval after the controlled price-change fixture.
4. Create a narrow books passport, demonstrate disallowed electronics, then revoke before execution and show durable denial. Repeat with an expiry-bound passport.
5. Reload to prove persistence; verify an intact receipt and a tampered receipt; show consumption/remaining allowance and the Activity audit. State explicitly that this is mock provider-boundary evidence, not a Razorpay payment receipt or bank-settlement proof.

## Verdict

**SUBMISSION-SAFE WITH DOCUMENTED LIMITATIONS**
