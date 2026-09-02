# Architecture

```text
untrusted browser / catalog text / model
             │ proposal only
             ▼
 server catalog resolution → deterministic policy gate → exact human approval
             │                         │
             │                     blocked: no provider call
             ▼
 SQLite BEGIN IMMEDIATE: revalidate versions + reserve daily budget
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

## Exact approval binding

Approval stores the SHA-256 digest of canonical owner, idempotency key, product, quantity, trusted unit/total price, category, merchant, subscription flag, policy/product versions, purchase budget, and quote expiry. Execution checks the approval digest and current versions. Price or policy edits durably transition an unexecuted authorization to `EXPIRED` and require a new proposal and approval.

## Atomic reservation and daily accounting

Execution uses `BEGIN IMMEDIATE` to re-read state, quote, catalog, policy, approval, confirmed spend, and active reservations, then inserts one reservation and claims the intent. The database has a unique ledger-per-intent index. Daily confirmed spend uses the Asia/Kolkata calendar day of confirmation; active reservations count regardless of reservation day. MOCK and Razorpay-test accounting are isolated namespaces. A policy reduction must be safe for the larger commitment in either namespace.

## Order creation versus confirmation

An order records provider acceptance of checkout parameters; it is not proof of paid funds. Razorpay confirmation requires a valid callback/webhook signature and a captured provider payment matching order, amount, and currency. Mock capture is synthetic and separately labeled.

## Retry and reconciliation

The first execution claim owns the only reservation. A repeated request returns the existing intent/order. Definite provider rejection releases the reservation. Timeouts, thrown adapter exceptions, response loss, and stale `EXECUTING` recovery become `UNKNOWN` while retaining the reservation. Operators reconcile by persisted order ID/status or stable receipt; the application does not blindly create another order.

SQLite deployment assumes a single Node.js application instance and persistent storage. This design does not claim multi-instance coordination, power-loss testing, or corruption recovery.
