# BoundPay Phase 1 Verification & Implementation Report
**Track**: Razorpay AI Growth & Agentic Commerce Buildathon  
**Phase**: Phase 1 (Deterministic Financial Authority Core, Persistent Persistence, Mock Adapter, Operator UI)  
**Date**: September 2026  
**Status**: Completed and Verified

---

## 1. Implemented Behavior & Architecture

BoundPay Phase 1 establishes the core authorization, state management, persistence, and operator interfaces for agentic commerce. The architecture cleanly separates untrusted proposal intelligence from deterministic financial execution authority:

```
[Untrusted Client / LLM Proposal]
   │ (product_id, quantity, reason, purchase_budget)
   ▼
[Server-Controlled Catalog Resolution] ──► Ground truth unit price, category, merchant, version
   │
   ▼
[Deterministic Policy Evaluation] ─────► Currency, limits, categories, subscriptions, daily budget
   │
   ▼
[Exact-Intent Approval Authority] ─────► SHA-256 canonical digest binding
   │
   ▼
[Atomic Budget Reservation] ───────────► SQLite serialized transaction (BEGIN IMMEDIATE)
   │
   ▼
[Mock Payment Adapter Dispatch] ───────► Controlled test faults & mock order/payment confirmation
   │
   ▼
[Append-Only Audit Trail] ─────────────► Chronological event stream and JSON export
```

### Core Implemented Capabilities
1. **Integer Paise Financial Computation**: All monetary values are strictly validated and stored as 64-bit safe integer paise (1 INR = 100 paise; e.g. ₹2,799 = 279900 paise). Floating-point rupee arithmetic is prohibited across all domain models, schemas, and queries.
2. **Deterministic Spending Policy Engine**:
   - Monotonically versioned spending policies.
   - Dual-constraint transaction bounding: $\text{effective\_limit} = \min(\text{policy.max\_transaction\_amount\_paise}, \text{purchase\_budget\_paise})$.
   - Category filtering, subscription prohibition, merchant whitelisting, and strict expiry checking.
   - Reduction protection: operators cannot decrease daily budget below current committed spend ($\text{confirmed} + \text{active reservations}$).
3. **Exact-Intent Cryptographic Approvals**: Human operator approvals bind directly to the canonical SHA-256 digest of all authorization-relevant fields (`owner_id`, `product_id`, `unit_price`, `quantity`, `category`, `merchant_id`, `policy_version`, `product_version`, `budget`, `quote_expiry`). If any attribute changes between proposal and execution, prior approvals are invalidated.
4. **Transaction-Safe Budget Accounting**:
   - `Asia/Kolkata` daily budget window (00:00:00 to 23:59:59.999 IST).
   - Invariant: $\text{DailyConfirmedSpend} + \sum \text{ActiveReservations} + \text{ProposedReservation} \le \text{DailyBudget}$.
   - Durable reservations: never released on HTTP disconnects, timeouts, day rollovers, or unknown provider outcomes.
   - Real SQLite serialized write transactions (`BEGIN IMMEDIATE`) ensure race conditions between concurrent requests cannot exceed the budget.
5. **Scoped Idempotency**: Database-enforced uniqueness on `(owner_id, idempotency_key, payment_adapter_mode)`. Matching requests return existing intents; conflicting payloads with the same key return HTTP 409 Conflict; repeated checkout attempts safely reuse existing claims.
6. **Authentication & Session Security**: Single operator account with `bcryptjs` password hashing, HttpOnly session cookies, SameSite enforcement, login rate-limiting, and CSRF origin verification on authenticated writes.
7. **Mock Payment Adapter**: Interface supporting `createOrder`, `confirmCapture`, and `getOrderStatus` with simulated faults (`SIMULATE_REJECTION`, `SIMULATE_TIMEOUT`, `SIMULATE_RESPONSE_LOSS`, `SIMULATE_PENDING`, `SIMULATE_DUPLICATE`) visibly labeled in UI and logs.
8. **Three Main Operator Views**:
   - **Shop**: Catalog listing, manual/fixture proposals, deterministic check breakdown, approve/decline controls, checkout dispatch, and status badges.
   - **Policy**: Editable validated rules, live budget cards, and reduction guard notices.
   - **Activity**: Append-only chronological audit trail and JSON export.

---

## 2. State-Transition Table

The BoundPay state machine enforces non-regressive transitions. In particular, once payment is confirmed, an intent can never regress to an earlier state.

| Source State | Target State | Trigger / Guard Condition | Outcome / Persistence Action |
|---|---|---|---|
| `PROPOSED` | `BLOCKED` | Fails deterministic policy (prohibited subscription, forbidden category, unapproved merchant, exceeds limit). | Terminal. Failure reason recorded in intent and audit. |
| `PROPOSED` | `NEEDS_APPROVAL` | Passes hard rules, but `total_amount_paise > policy.approval_threshold_paise`. | Awaiting operator review. No payment adapter call allowed. |
| `PROPOSED` | `READY` | Passes all rules and `total_amount_paise <= policy.approval_threshold_paise`. | Auto-allowed. Ready for atomic reservation claim. |
| `NEEDS_APPROVAL` | `APPROVED` | Authenticated operator submits approval matching exact canonical hash. | Approval record inserted in `intent_approvals`. Ready for execution. |
| `NEEDS_APPROVAL` | `DECLINED` | Authenticated operator declines proposal. | Terminal. Marked `DECLINED` in intent and approvals. |
| `READY` / `APPROVED` | `EXECUTING` | Atomic budget reservation succeeds within SQLite transaction. | `spend_ledger` row created (`RESERVED`). Lock acquired for payment dispatch. |
| `EXECUTING` | `ORDER_CREATED` | Payment adapter `createOrder` succeeds. | Provider order ID saved in ledger and intent. |
| `ORDER_CREATED` | `PAYMENT_CONFIRMED` | Payment adapter `confirmCapture` succeeds. | **Terminal**. Ledger updated to `CONFIRMED` with timestamp. Spend finalized. |
| `EXECUTING` | `BLOCKED` | Payment adapter returns definite non-retryable provider rejection. | Ledger reservation marked `RELEASED`. Intent marked `BLOCKED`. |
| `EXECUTING` / `ORDER_CREATED` | `UNKNOWN` | Payment adapter times out, returns 5xx, or network response lost. | **Non-regressive**. Ledger reservation held indefinitely until manual audit. |
| `PROPOSED`, `NEEDS_APPROVAL`, `READY`, `APPROVED` | `EXPIRED` | Quote expiry timestamp exceeded or policy version revoked before execution. | Terminal. Intent marked `EXPIRED`. |

---

## 3. Financial Invariants

1. **Integer Representation Invariant**: Every monetary amount in storage, domain calculations, and API contracts is an integer representing paise. Fractional paise, negative values, and numbers exceeding `Number.MAX_SAFE_INTEGER` are rejected at boundary schemas.
2. **Total Calculation Invariant**:
   $$\text{total\_amount\_paise} = \text{server\_catalog\_unit\_price\_paise} \times \text{quantity} \quad (1 \le \text{quantity} \le 10)$$
3. **Dual Spending Boundary Invariant**:
   $$\text{total\_amount\_paise} \le \min(\text{policy.max\_transaction\_amount\_paise}, \text{purchase\_budget\_paise})$$
4. **Daily Budget Authorization Invariant**:
   $$\text{DailyConfirmedSpend}_{\text{today (IST)}} + \sum_{\text{all days}} \text{ActiveReservations} + \text{ProposedReservation} \le \text{policy.daily\_budget\_paise}$$
5. **Committed Spend Durability Invariant**: Budget reservations are **never** released due to client disconnects, timeouts, day rollovers, worker restarts, or unknown provider responses.
6. **Policy Budget Reduction Invariant**:
   $$\text{NewDailyBudget} \ge \text{DailyConfirmedSpend}_{\text{today (IST)}} + \sum_{\text{all days}} \text{ActiveReservations}$$
7. **Single Capture Conversion Invariant**: An active reservation in `spend_ledger` is converted to status `CONFIRMED` exactly once upon verified payment capture.

---

## 4. Exact Verification Commands & Actual Results

### 4.1 TypeScript Strict Checking
**Command**:
```bash
pnpm run typecheck
```
**Actual Result**:
```
> boundpay@0.1.0 typecheck /home/masa84/razorpay
> tsc --noEmit

[Exit code: 0 - Clean compilation, 0 errors]
```

### 4.2 Linter Verification
**Command**:
```bash
pnpm run lint
```
**Actual Result**:
```
> boundpay@0.1.0 lint /home/masa84/razorpay
> next lint

✔ No ESLint warnings or errors
[Exit code: 0]
```

### 4.3 Vitest Unit, Property, and Concurrency Integration Tests
**Command**:
```bash
pnpm test
```
**Actual Result**:
```
> boundpay@0.1.0 test /home/masa84/razorpay
> vitest run

 RUN  v4.1.11 /home/masa84/razorpay

 Test Files  7 passed (7)
      Tests  77 passed (77)
   Start at  01:52:28
   Duration  2.86s
[Exit code: 0]
```
**Breakdown of the 77 passing tests**:
- `test/unit/money.test.ts`: 15 tests (exact zero, positive safe integers, negative amounts, fractions, non-finite, unsafe overflows, quantity boundaries 0, 1, 10, 11, rupee-paise formatting).
- `test/unit/policy.test.ts`: 17 tests (limits exactly at threshold, 1 paise below, 1 paise above; transaction limit boundaries; purchase budget constraints; daily budget boundaries; currency, merchant, category, and subscription trust boundaries; expiry boundaries at $t - 1$, $t$, and $t + 1$; policy update schema rules).
- `test/unit/state-machine.test.ts`: 12 tests (all allowed transitions, strict terminal guarantees, forbidden backward regressions, no skipping approval).
- `test/unit/intent-canonical.test.ts`: 6 tests (canonical JSON determinism, sensitivity to price/quantity/budget/version changes, cryptographic approval validation).
- `test/property/financial-invariants.prop.test.ts`: 3 property-based test suites (1,000 runs verifying invalid inputs are never authorized, 500 runs verifying monotonicity under price increases, 500 runs verifying total amount invariance).
- `test/integration/db-concurrency.test.ts`: 6 tests (concurrent budget races across connections, repeated execution dispatch races, approval/denial races, policy and catalog invalidation races, database close/reopen durability, mock/test mode isolation).
- `test/integration/auth-http.test.ts`: 5 tests (unauthenticated writes rejected with 401, cross-origin CSRF rejected with 403, forged and expired sessions rejected with 401, client-supplied approval flags safely ignored, controlled error responses without stack traces).

### 4.4 Playwright Browser E2E Tests
**Command**:
```bash
pnpm run test:e2e
```
**Actual Result**:
```
> boundpay@0.1.0 test:e2e /home/masa84/razorpay
> CONFIRM_RESET=true tsx src/infrastructure/db/reset.ts && playwright test

Running 8 tests using 1 worker

  ✓ Scenario 1: Operator login and Wireless Mouse auto-allowed (1.4s)
  ✓ Scenario 2: Mechanical Keyboard requires human approval and executes after approval (1.2s)
  ✓ Scenario 3: Subscription product is BLOCKED by deterministic policy (809ms)
  ✓ Scenario 4: Policy view displays live budget usage and updates policy (951ms)
  ✓ Scenario 5: Activity view displays persistent audit events and export (754ms)
  ✓ Scenario 6: Repeated clicks on checkout do not duplicate the order (1.1s)
  ✓ Scenario 7: Error messages are visible and actionable when policy fails (936ms)
  ✓ Scenario 8: Page reload preserves operator authentication session (778ms)

  8 passed (10.2s)
[Exit code: 0]
```

### 4.5 Production Build
**Command**:
```bash
pnpm run build
```
**Actual Result**:
```
> boundpay@0.1.0 build /home/masa84/razorpay
> next build

 ✓ Compiled successfully
   Linting and checking validity of types     ✓ Linting and checking validity of types 
   Collecting page data     ✓ Collecting page data 
 ✓ Generating static pages (14/14)
   Collecting build traces     ✓ Collecting build traces 
   Finalizing page optimization     ✓ Finalizing page optimization 
[Exit code: 0]
```

---

## 5. Concurrency Test Method

To satisfy the rigorous concurrency testing requirements:
- **Multiple Independent SQLite Connections**: Tests in `test/integration/db-concurrency.test.ts` do not merely execute `Promise.all` over a single connection. They instantiate separate `better-sqlite3` database handles pointing to the same database file in `WAL` mode.
- **Immediate Write Lock Assertion**: Execution claims invoke `sqlite.transaction(...).immediate()`. This immediately requests a SQLite `RESERVED`/`EXCLUSIVE` write lock.
- **Budget Race Verification**:
  Two concurrent purchases of ₹2,799 (279,900 paise each, totaling 559,800 paise) race concurrently against a daily budget of ₹5,000 (500,000 paise).
  - Test asserts that across the two independent connections, **at most one** succeeds (`fulfilled`, `success: true`), and the racing connection fails with `BudgetExceededError`.
  - Database state verification confirms exactly one reservation entry exists in `spend_ledger`.
- **Repeated Execution Race**:
  Five concurrent requests execute the same intent simultaneously. The test asserts that exactly one reservation/capture is created and subsequent requests safely return the existing confirmed status without duplicate adapter dispatch or duplicate ledger entries.
- **Rollback and Durability**:
  Tests verify that after completing a confirmed transaction, closing all connections and reopening the database preserves the exact ledger status (`CONFIRMED`) and intent state (`PAYMENT_CONFIRMED`).

---

## 6. What is Explicitly Mocked

1. **Payment Gateway Integration**:
   - `MockPaymentAdapter` implements the payment interface. All orders and payments are prefixed with `mock_order_` and `mock_pay_`.
   - Results in the UI and audit logs are visibly tagged `[MOCK_PAYMENT]` and `[MOCK_PAYMENT ADAPTER ACTIVE]`.
   - Controlled test faults (`SIMULATE_REJECTION`, `SIMULATE_TIMEOUT`, `SIMULATE_RESPONSE_LOSS`, `SIMULATE_PENDING`, `SIMULATE_DUPLICATE`) simulate provider responses through the real service path.
2. **AI Model Proposal**:
   - In Phase 1, proposals are driven through operator UI controls and fixture presets simulating future agent proposals (`product_id`, `quantity`, `purchase_budget_paise`, and `reason`).
   - No live language model is connected.

---

## 7. Remaining Limitations & Prototype Scope

1. **Local Append-Only Audit Trail**: The audit log is append-only through the BoundPay application layer. It is not an immutable cryptographic blockchain; a system administrator with root filesystem access could modify the SQLite file directly.
2. **Configured Merchant Trust**: The prototype trusts its server-configured merchant catalog. In Phase 1, merchant classifications are assumed truthful and do not guarantee merchant verification against arbitrary third-party stores.
3. **Single Merchant & Single Operator**: Phase 1 implements a single operator account and single merchant (`demo_store`). Multi-tenant organizations and multi-merchant routing are deferred to subsequent phases.
4. **No Direct Bank Account Debits**: BoundPay controls authorization and checkout handoff; it does not perform autonomous bank debits.

---

## 8. Manual Walkthrough Summary

1. Sign in at `/login` using `operator` / `BoundPayPass123!`.
2. On `/shop`:
   - Select **"2. Wireless Mouse x1"** &rarr; Submit Proposal &rarr; Observe state `READY FOR CHECKOUT` (&le; ₹2,500 threshold) &rarr; Click **"Execute Atomic Reservation & Mock Checkout"** &rarr; Observe immediate confirmation badge with Mock Order ID.
   - Select **"1. Mechanical Keyboard x1"** &rarr; Submit Proposal &rarr; Observe state `NEEDS HUMAN APPROVAL` (&gt; ₹2,500 threshold) &rarr; Click **"Human Operator Approve"** &rarr; State transitions to `OPERATOR APPROVED` &rarr; Execute checkout.
   - Select **"4. Support Plan Subscription"** &rarr; Submit Proposal &rarr; Observe state `POLICY BLOCKED` with reason `Subscriptions are prohibited by policy`.
3. On `/policy`:
   - Inspect live daily budget cards and update policy rules.
4. On `/activity`:
   - Inspect the real-time append-only event stream and click **"Export Audit JSON"** to download the structured log.
