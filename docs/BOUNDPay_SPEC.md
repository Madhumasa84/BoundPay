# BOUNDPay Persistent Specification (Phase 1)
**Project**: BoundPay – Bounded Financial Authority for Agentic Commerce  
**Track**: Razorpay AI Growth & Agentic Commerce Buildathon  
**Phase**: Phase 1 (Deterministic Financial Core, Persistence, Mock Adapter, Operator UI)  
**Status**: Authoritative Reference Document

---

## 1. Executive Summary & Product Scope

### 1.1 Goal
BoundPay decouples shopping proposal intelligence from financial authorization. In autonomous and agentic commerce, an AI shopping agent may propose purchases based on conversational requests. BoundPay ensures that financial authority remains deterministic, strictly bounded, and subject to server-enforced rules and human oversight.

### 1.2 Phase 1 Implemented Scope
- **Single Operator Account**: Authenticated operator session with password hashing (`bcryptjs`), HttpOnly cookies, SameSite enforcement, session expiry, and login rate limiting.
- **Single Merchant**: Configured approved merchant (`demo_store`).
- **Currency**: `INR` only.
- **Monetary Unit**: Integer paise only (₹1 = 100 paise; e.g., ₹2,799 = 279900 paise). Zero floating-point rupee arithmetic.
- **Catalog Management**: Server-controlled, persistent, editable catalog with versioning. Shipping and tax are included in total catalog prices.
- **Spending Policy Engine**: Persistent, editable spending policy with versioning.
  - Default maximum transaction: 400,000 paise (₹4,000).
  - Default daily budget: 500,000 paise (₹5,000).
  - Default approval threshold: 250,000 paise (₹2,500).
  - Default allowed categories: `electronics`, `books`.
  - Subscriptions: Prohibited (`allow_subscriptions: false`).
- **Explicit Purchase Budget**: Required numeric UI field specifying the maximum spend authorized for the specific purchase request. The effective spending limit is the minimum of the standing policy transaction limit and this explicit purchase budget:
  $$\text{effective\_limit} = \min(\text{policy.max\_transaction\_amount\_paise}, \text{purchase\_budget\_paise})$$
- **Exact-Intent Human Approval**: Human approvals cryptographically bind to a canonical SHA-256 digest of all authorization-relevant fields. Any change in catalog price, quantity, category, or policy invalidates prior approvals.
- **Transaction-Safe Budget Reservations**: Real SQLite atomic transactions (`BEGIN IMMEDIATE`) verify available daily budget, insert ledger reservations, and transition intent state to `EXECUTING` in a single atomic commit before calling payment adapters.
- **Idempotency**: Scoped uniqueness on `(owner_id, idempotency_key, payment_adapter_mode)`. Matching requests return existing intents; mismatched requests return HTTP 409 Conflict; repeated checkout attempts reuse the existing execution claim.
- **Append-Only Audit Trail**: Every proposal, policy check, state transition, human decision, budget reservation, and payment adapter outcome appends an immutable event log.
- **Mock Payment Adapter**: Narrow payment interface with controlled fault scenarios (success, rejection, timeout, response loss, pending, duplicate notifications) clearly labeled in UI and logs.
- **Operator Views**: Shop (catalog, fixture/manual proposal, policy evaluations, approval/decline, checkout), Policy (editable rules, version, limits), Activity (audit events, state transitions, JSON export).

### 1.3 Explicit Non-Goals (Not in Phase 1)
- No live LLM connections or external AI APIs.
- No live Razorpay API calls (only explicitly labeled mock adapter).
- No multi-agent orchestration, RAG, vector databases, or blockchain.
- No model training.
- No refunds, chargebacks, or outbound payouts.
- No subscription billing integrations.
- No multi-tenant team management or organization hierarchies.
- No autonomous bank account debits or production claims.

---

## 2. Trust Boundaries & Security Model

```
       [ Untrusted Client / Browser / LLM ]
                          │
                          ▼ (product_id, quantity, reason, purchase_budget)
   ═══════════════════════╪══════════════════════════════════════════════
   BOUNDPAY TRUST BOUNDARY│ (Server-Side Deterministic Authority)
                          ▼
             [ 1. Catalog Attribute Resolution ]
             (Price, Category, Subscription status, Merchant, Version)
                          │
                          ▼
             [ 2. Deterministic Policy Engine ]
             (Limits, Categories, Subscriptions, Merchant, Expiry)
                          │
                          ▼
             [ 3. Exact Intent & Approval Authority ]
             (Canonical SHA-256 Digest & Human Signature)
                          │
                          ▼
             [ 4. Atomic Ledger & Budget Reservation ]
             (SQLite Serialized Transaction: Spend Invariant Check)
                          │
                          ▼
             [ 5. Payment Adapter Dispatch ]
             (Mock Adapter in Phase 1; External API outside DB tx)
                          │
                          ▼
             [ 6. Append-Only Audit Trail ]
```

### 2.1 Untrusted Components
1. **The Model**: Untrusted. The model is permitted to supply only:
   - `product_id` (string)
   - `quantity` (integer between 1 and 10)
   - `reason` (untrusted text string)
2. **The Browser / Client**: Untrusted. Cannot dictate unit price, total price, category, merchant ID, product version, policy version, or approval status.
3. **Free-Form Text**: Shopping prompts or model rationales cannot alter spending limits, bypass approvals, or synthesize catalog items.

### 2.2 Server-Enforced Authority
- **Catalog Ground Truth**: Unit prices, categories, merchant IDs, and subscription flags are retrieved exclusively from server database storage.
- **Rejection of Unknown Products**: Unrecognized product IDs are immediately rejected.
- **Untrusted Text Sanitization**: Product descriptions and model rationales are escaped and never rendered as raw HTML.
- **Merchant Catalog Disclaimer**: BoundPay trusts its configured merchant catalog. This prototype assumes the merchant is truthful; it does not solve real-world fraudulent merchant classification.

---

## 3. Financial Invariants & Accounting Rules

### 3.1 Currency and Monetary Representation
- Currency is strictly `INR`.
- All monetary amounts are non-negative 64-bit safe integers representing **paise** (1 INR = 100 paise).
- Floating-point representations (e.g., `27.99`) are strictly forbidden in business logic, schemas, and persistence.
- Any fractional, negative, unsafe integer (exceeding `Number.MAX_SAFE_INTEGER`), or non-integer input is rejected at boundary schemas.

### 3.2 Daily Budget Accounting Convention
- **Time Window**: `Asia/Kolkata` calendar day (00:00:00.000 to 23:59:59.999 IST).
- **Confirmed Spend**: Sum of all ledger entries with status `CONFIRMED` where confirmation timestamp falls within the current `Asia/Kolkata` day.
- **Active Reservations**: Sum of all ledger entries with status `RESERVED` regardless of creation day (unresolved reservations lock budget until explicitly resolved or operator-audited).
- **Budget Invariant at Authorization**:
  $$\text{DailyConfirmedSpend}_{\text{today}} + \sum \text{ActiveReservations} + \text{ProposedReservation} \le \text{Policy.daily\_budget\_paise}$$
- **Committed Reservation Durability**: Reservations are **never** released due to client disconnects, HTTP timeouts, calendar day rollovers, server restarts, or ambiguous adapter responses.
- **Budget Reduction Constraint**: An operator cannot update the policy to a `daily_budget_paise` less than current $(\text{DailyConfirmedSpend}_{\text{today}} + \sum \text{ActiveReservations})$.

---

## 4. State Machine & Transition Specification

### 4.1 Intent States
1. `PROPOSED`: Initial proposal created by operator or fixture.
2. `BLOCKED`: Rejected by hard deterministic policy (e.g., category forbidden, subscription prohibited, unapproved merchant, exceeds transaction limit, exceeds explicit purchase budget). Terminal.
3. `NEEDS_APPROVAL`: Passes hard policy checks, but total amount exceeds approval threshold.
4. `READY`: Passes all policy checks and total amount is within auto-approval threshold.
5. `APPROVED`: Explicitly approved by authenticated operator matching the exact canonical intent digest.
6. `DECLINED`: Explicitly declined by operator. Terminal.
7. `EXECUTING`: Budget atomically reserved; lock acquired for payment adapter dispatch.
8. `ORDER_CREATED`: Mock payment provider order created.
9. `PAYMENT_CONFIRMED`: Mock payment provider capture confirmed; reservation converted to confirmed spend. Terminal.
10. `UNKNOWN`: Payment provider timed out, lost response, or returned ambiguous state. Requires operator inspection. Non-regressive.
11. `EXPIRED`: Quote validity duration elapsed or policy expired before reservation commitment. Terminal.

### 4.2 State Transition Matrix

| Current State | Target State | Trigger / Guard Condition |
|---|---|---|
| `PROPOSED` | `BLOCKED` | Fails deterministic policy (category, subscription, merchant, limit, budget). |
| `PROPOSED` | `NEEDS_APPROVAL` | Passes hard rules, but `total_amount_paise > policy.approval_threshold_paise`. |
| `PROPOSED` | `READY` | Passes all rules and `total_amount_paise <= policy.approval_threshold_paise`. |
| `NEEDS_APPROVAL` | `APPROVED` | Authenticated operator submits approval with matching canonical hash. |
| `NEEDS_APPROVAL` | `DECLINED` | Authenticated operator declines proposal. |
| `READY` | `EXECUTING` | Atomic budget reservation succeeds; execution lock claimed. |
| `APPROVED` | `EXECUTING` | Atomic budget reservation succeeds; execution lock claimed. |
| `EXECUTING` | `ORDER_CREATED` | Payment adapter `createOrder` succeeds. |
| `ORDER_CREATED` | `PAYMENT_CONFIRMED` | Payment adapter `confirmCapture` succeeds; reservation converted to confirmed. |
| `EXECUTING` | `UNKNOWN` | Payment adapter times out or raises unhandled network exception. |
| `ORDER_CREATED` | `UNKNOWN` | Provider order created but capture response is lost or indeterminate. |
| `EXECUTING` | `DECLINED` / `BLOCKED` | Payment adapter returns definite non-retryable provider rejection. |
| `PROPOSED`, `NEEDS_APPROVAL`, `READY`, `APPROVED` | `EXPIRED` | Quote expiry timestamp exceeded, or policy version revoked/expired prior to execution. |

*Invariants*:
- `PAYMENT_CONFIRMED` is strictly terminal. A confirmed payment can never regress to `EXECUTING`, `READY`, or `PROPOSED`.
- No payment adapter call is made while in `PROPOSED`, `NEEDS_APPROVAL`, `BLOCKED`, `DECLINED`, or `EXPIRED`.

---

## 5. Canonical Intent Hashing & Approval Binding

To prevent time-of-check to time-of-use (TOCTOU) attacks, approvals are cryptographically bound to the canonical representation of the intent.

### 5.1 Canonical Hash Payload
The canonical SHA-256 hash is computed over a sorted, canonical JSON string of the following fields:
```json
{
  "category": "electronics",
  "currency": "INR",
  "idempotency_key": "user-key-123",
  "is_subscription": false,
  "merchant_id": "demo_store",
  "owner_id": "op_01",
  "policy_version": 1,
  "product_id": "prod_keyboard",
  "product_version": 1,
  "purchase_budget_paise": 300000,
  "quantity": 1,
  "quote_expiry": "2026-09-03T01:30:00.000Z",
  "total_amount_paise": 279900,
  "unit_price_paise": 279900
}
```
If an operator edits the product price, changes quantity, or updates the spending policy before checkout, the canonical hash changes. Any prior approval record references the old hash and is rejected during the revalidation phase of the atomic reservation transaction.

---

## 6. Database Schema & Storage Decisions

BoundPay uses SQLite via `better-sqlite3` and `drizzle-orm`. SQLite runs in WAL (Write-Ahead Logging) mode with synchronous = NORMAL to ensure serialized, ACID-compliant transactions across multiple connections.

### 6.1 Schema Tables
1. `operators`: ID, username, password_hash (bcrypt), created_at.
2. `operator_sessions`: ID, operator_id, token_hash, expires_at, created_at, revoked_at.
3. `login_attempts`: IP/identifier, consecutive_failures, locked_until, updated_at.
4. `products`: ID, name, description, unit_price_paise, currency, category, is_subscription, merchant_id, version, is_active, updated_at.
5. `policies`: ID, version, currency, max_transaction_amount_paise, daily_budget_paise, approval_threshold_paise, allowed_categories (JSON array), approved_merchant_id, allow_subscriptions, expires_at, created_at.
6. `purchase_intents`:
   - `id` (UUID)
   - `owner_id` (FK operators)
   - `idempotency_key` (text)
   - `canonical_request_hash` (text)
   - `product_id` (FK products)
   - `merchant_id` (text)
   - `quantity` (integer)
   - `unit_price_paise` (integer)
   - `total_amount_paise` (integer)
   - `currency` (text)
   - `category` (text)
   - `is_subscription` (boolean)
   - `product_version` (integer)
   - `policy_version` (integer)
   - `purchase_budget_paise` (integer)
   - `quote_expiry` (text/ISO)
   - `source_mode` (`MANUAL` | `FIXTURE` | `AGENT_PROPOSAL`)
   - `payment_adapter_mode` (`MOCK` | `RAZORPAY_TEST`)
   - `state` (text state machine enum)
   - `failure_reason` (text, nullable)
   - `created_at`, `updated_at`
   - *Constraint*: `UNIQUE(owner_id, idempotency_key, payment_adapter_mode)`
7. `intent_approvals`: ID, intent_id, operator_id, canonical_hash, approved_at, status (`APPROVED` | `DECLINED`), notes.
8. `spend_ledger`:
   - `id` (UUID)
   - `intent_id` (FK purchase_intents)
   - `amount_paise` (integer)
   - `status` (`RESERVED` | `CONFIRMED` | `RELEASED`)
   - `reservation_timestamp` (ISO)
   - `confirmation_timestamp` (ISO, nullable)
   - `payment_adapter_mode` (`MOCK` | `RAZORPAY_TEST`)
   - `provider_order_id` (text, nullable)
   - `provider_payment_id` (text, nullable)
9. `audit_events`:
   - `id` (monotonic integer primary key)
   - `timestamp` (ISO)
   - `event_type` (e.g. `POLICY_EVALUATED`, `INTENT_CREATED`, `APPROVAL_GRANTED`, `BUDGET_RESERVED`, `ORDER_DISPATCHED`, `PAYMENT_CONFIRMED`)
   - `intent_id` (nullable)
   - `operator_id` (nullable)
   - `policy_version` (nullable)
   - `amount_paise` (nullable)
   - `state_before` (nullable)
   - `state_after` (nullable)
   - `payload_json` (structured details)

---

## 7. API Contracts Implemented in Phase 1

### 7.1 Authentication
- `POST /api/auth/login`: `{ username, password }` -> sets HttpOnly cookie `boundpay_session`, returns `{ success: true, operator: { id, username } }`.
- `POST /api/auth/logout`: Revokes session token in database, clears cookie.
- `GET /api/auth/me`: Returns current operator identity and session status.

### 7.2 Catalog Management
- `GET /api/catalog`: Returns array of active products with prices, categories, and versions.
- `POST /api/catalog`: Add product `{ name, description, unit_price_paise, category, is_subscription, merchant_id }`.
- `PUT /api/catalog/[id]`: Update product price or attributes; increments `product_version`.

### 7.3 Spending Policy
- `GET /api/policy`: Returns current policy, version, daily confirmed spend, active reservations, and remaining daily budget.
- `PUT /api/policy`: Updates spending limits, categories, and expiry. Validates that new `daily_budget_paise` is not less than committed spend + outstanding reservations. Increments `policy_version`.

### 7.4 Purchase Proposals & Execution
- `POST /api/intents`:
  - Request: `{ product_id, quantity, idempotency_key, purchase_budget_paise, source_mode, fault_injection? }`
  - Resolves server-controlled catalog price, category, merchant, subscription flag.
  - Checks idempotency: returns existing intent if identical; 409 Conflict if key matches but payload differs.
  - Evaluates policy deterministically.
  - Inserts intent in `PROPOSED`, `BLOCKED`, `NEEDS_APPROVAL`, or `READY`.
- `POST /api/intents/[id]/approve`:
  - Validates operator session.
  - Verifies canonical hash matches current intent.
  - Transitions `NEEDS_APPROVAL` -> `APPROVED`.
- `POST /api/intents/[id]/decline`:
  - Transitions `NEEDS_APPROVAL` -> `DECLINED`.
- `POST /api/intents/[id]/execute`:
  - Atomically claims execution lock (`BEGIN IMMEDIATE`).
  - Revalidates current product price, version, policy version, quote expiry, and approval digest.
  - Checks daily spend limit invariant.
  - Inserts `RESERVED` ledger entry and updates state to `EXECUTING`.
  - Commits transaction.
  - Invokes Payment Adapter outside transaction.
  - On adapter success, updates intent to `ORDER_CREATED` then `PAYMENT_CONFIRMED`, and converts ledger reservation to `CONFIRMED`.
  - On adapter fault/timeout, updates intent to `UNKNOWN` or `BLOCKED` (reservation remains locked).

### 7.5 Audit Trail
- `GET /api/audit`: Returns paginated chronologically ordered audit events.
- `GET /api/audit/export`: Returns complete audit log as a downloadable JSON document.

---

## 8. Mock Payment Adapter & Test Fault Injection

The mock payment adapter implements:
- `createOrder(params)`
- `confirmCapture(orderId, params)`
- `getOrderStatus(orderId)`

Supported fault injection flags (for testing and manual verification in UI):
- `SIMULATE_SUCCESS`: Normal happy path (Order created -> Capture confirmed).
- `SIMULATE_REJECTION`: Mock provider explicitly declines card/funds (Definite rejection -> `BLOCKED`).
- `SIMULATE_TIMEOUT`: Mock provider call times out before responding -> `UNKNOWN`.
- `SIMULATE_RESPONSE_LOSS`: Order is created in provider, but response to client is dropped -> `UNKNOWN`.
- `SIMULATE_PENDING`: Provider returns payment authorization pending -> `ORDER_CREATED` (remains executing).
- `SIMULATE_DUPLICATE`: Multiple capture calls for same provider order -> Idempotent success without duplicate ledger spend.

All mock operations and states are visibly tagged `[MOCK_PAYMENT]` in the UI and audit logs.
