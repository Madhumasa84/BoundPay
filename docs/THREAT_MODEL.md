# Threat Model

## Trusted and untrusted components

Trusted: application server code, server catalog attributes, current policy rows, session database, SQLite transaction/constraints, configured clock, signature secrets, and provider responses after verification.

Untrusted: the shopping model, browser, request JSON, catalog descriptions, displayed rationale, callback fields before verification, unsigned webhooks, idempotency keys, and all fixture/fault controls. Operators and infrastructure administrators are privileged.

## Covered attacks and failures

- Client/model price, merchant, currency, approval, and policy forgery is excluded from accepted proposal fields and replaced with server truth.
- Budget, category, merchant, subscription, expiry, and approval-threshold violations are deterministically blocked.
- Approval reuse after price, product, policy, quantity, budget, or quote change fails exact binding/version checks.
- Serialized reservation prevents concurrent commitments exceeding a mode-specific daily budget, tested both within a single Node.js process (Promise.all races) and across independent worker_threads with SharedArrayBuffer barriers (cross-connection contention against the same SQLite file).
- Intent idempotency, state claims, and the unique ledger constraint prevent tested duplicate reservation/order paths.
- Callback and webhook signatures use HMAC verification; captured payment is checked against order, amount, and INR currency.
- Replayed webhook event IDs are deduplicated and early unmatched events are retained.
- Ambiguous provider outcomes retain authority and require reconciliation, avoiding blind order retry.
- Catalog prompt injection has no direct financial authority. A forced subscription proposal is blocked by the normal gate.
- Authentication, ownership, session expiry, logout, and same-origin browser writes are tested.

## Residual risks and assumptions

- The explicit policy cannot judge subjective purchase quality. A model may choose an undesirable allowed product.
- Twenty live-model cases are prepared but unexecuted; no broad prompt-injection-immunity claim is made.
- One operator and one approved merchant are assumed. Role separation, account recovery, MFA, and merchant onboarding are out of scope.
- One application instance and one persistent SQLite volume are assumed. In-memory mock-provider state is process-local. Cross-connection concurrency within a single Node.js process (worker_threads sharing one SQLite file) is now tested. Multi-OS-process coordination (multiple Node instances sharing one file), power-loss, and corruption recovery are not tested and are not supported.
- CSRF uses SameSite cookies and origin/referer checks. Non-browser clients without those headers are permitted when holding the session cookie; stolen session cookies remain dangerous.
- The seeded default password is public development data and must be replaced for shared environments.
- Application audit rows are append-only by code convention, not cryptographically chained or immutable to a database administrator.
- No durability claim is made for sudden power loss, disk corruption, compromised host, dependency supply chain, provider compromise, or stolen environment secrets.
- Denial-of-service, distributed rate limiting, and multi-process scheduling are not comprehensively tested.
