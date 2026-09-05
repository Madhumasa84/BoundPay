# Architecture

```text
untrusted browser / catalog text / model
             │ proposal only
             ▼
 server catalog resolution → deterministic policy gate → exact human approval
             │                         │
             │                     blocked: no provider call
             ▼
 passport signature + effective-policy intersection
             │ signed decision receipt (proof, not capability)
             ▼
 SQLite BEGIN IMMEDIATE: revalidate versions + reserve daily budget + passport usage
             │ committed reservation
             ▼
 payment adapter boundary ── MOCK or Razorpay TEST order
             │
             ▼
 signed callback / signed webhook / provider status verification
             │ captured, matching amount/currency/order
             ▼
 confirmed ledger + persistent application audit
```

## Trust boundaries

The model, catalog descriptions, browser payloads, Checkout callback fields, and unsigned network input are untrusted. The server-side catalog, current policy, canonical intent digest, session lookup, SQLite transactions, signature checks, and authoritative provider lookup are trusted application components. Razorpay is trusted only after cryptographic and API verification; the mock adapter is test infrastructure and is visibly labeled.

## Proposal is not authorization

The proposal contains a catalog product ID, quantity, and rationale. The server replaces all financial attributes with catalog truth, computes integer-paise total, and evaluates every policy rule. A proposal cannot carry a price or approval flag into authority.

## Authority Passport boundary

An Authority Passport is an immutable version-1 payload signed as an EdDSA compact JWS. It is bound to the authenticated operator (`ownerId`/`operatorId`) and an explicit agent ID, and carries non-empty allowlists, integer-paise limits, cumulative budget, usage count, validity window, issuance policy version, revocation nonce, issuer, audience, and `kid`. The server stores the exact payload, SHA-256 payload digest, and compact JWS. Only status (`ACTIVE`, `REVOKED`, or derived/persisted `EXPIRED`) and revocation metadata change; revoked rows remain for auditability.

At proposal time and again inside the `BEGIN IMMEDIATE` execution claim, the effective authorization is the intersection of current server policy, signed passport, trusted catalog, existing commitments, and approval state. A stricter current policy always wins. A passport never creates an order or confirms a payment. The execution service revalidates the stored intent, digest, passport signature/binding, quote, product/policy versions, approval, and budgets before dispatching a provider request.

The passport usage table has one unique `(passport_id, intent_id)` row. `RESERVED`, `COMMITTED`, `CONFIRMED`, and `UNKNOWN` consume cumulative budget and usage allowance; only a definite provider rejection becomes `RELEASED`. Adapter namespaces remain isolated (`MOCK` versus `RAZORPAY_TEST`) while preserving one usage row per namespace-bound intent.

Every deterministic authorization result (`ALLOWED`, `NEEDS_APPROVAL`, `BLOCKED`, `EXPIRED`, `REVOKED`) receives an immutable signed decision receipt. The receipt records trusted product/merchant/category/price, request and passport digests, policy version, stable reason codes, observed and explicitly projected passport budget, and approval requirement. A receipt is evidence of an authority statement, never an execution credential or a Razorpay payment receipt.

## Exact approval binding

Approval stores the SHA-256 digest of canonical owner, idempotency key, product, quantity, trusted unit/total price, category, merchant, subscription flag, policy/product versions, purchase budget, and quote expiry. Execution checks the approval digest and current versions. Price or policy edits durably transition an unexecuted authorization to `EXPIRED` and require a new proposal and approval.

## Atomic reservation and daily accounting

Execution uses `BEGIN IMMEDIATE` to re-read state, quote, catalog, policy, approval, confirmed spend, and active reservations, then inserts one reservation and claims the intent. The database has a unique ledger-per-intent index. Daily confirmed spend uses the Asia/Kolkata calendar day of confirmation; active reservations count regardless of reservation day. MOCK and Razorpay-test accounting are isolated namespaces. A policy reduction must be safe for the larger commitment in either namespace.

## Order creation versus confirmation

An order records provider acceptance of checkout parameters; it is not proof of paid funds. Razorpay confirmation requires a valid callback/webhook signature and a captured provider payment matching order, amount, and currency. Mock capture is synthetic and separately labeled.

## Retry and reconciliation

The first execution claim owns the only reservation. A repeated request returns the existing intent/order. Definite provider rejection releases the reservation. Timeouts, thrown adapter exceptions, response loss, and stale `EXECUTING` recovery become `UNKNOWN` while retaining the reservation. Operators reconcile by persisted order ID/status or stable receipt; the application does not blindly create another order.

SQLite deployment assumes a single Node.js application instance and persistent storage. Worker-thread contention using independent SQLite connections (via `worker_threads` sharing one SQLite file) is tested with SharedArrayBuffer barriers. This design does not claim multi-OS-process coordination, power-loss testing, or corruption recovery.
