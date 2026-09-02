# BoundPay Phase 2 Implementation Report

**Project**: BoundPay – Bounded Financial Authority for Agentic Commerce  
**Buildathon Track**: Razorpay AI Growth & Agentic Commerce  
**Phase**: Phase 2 (Live Model Integration, Razorpay TEST Standard Checkout, Webhooks, & State Reconciliation)  
**Date**: September 2026  
**Status**: Completed and Verified  

---

## 1. Executive Summary

Phase 2 builds upon the deterministic financial foundation established in Phase 1 by connecting:
1. **A Real AI Shopping Agent**: Translates natural language shopping requests into structured purchase proposals using OpenAI SDK (`gpt-4o-mini`) while strictly confining the agent to zero financial authority.
2. **Razorpay TEST Payment Gateway**: Creates orders via Razorpay Orders API, initiates human-completed payment via Razorpay Standard Checkout (`checkout.js`), verifies cryptographic signatures (`HMAC-SHA256`), confirms authoritative payment status (`status === 'captured'`), processes webhooks with deduplication, handles callback/webhook races, and supports status refresh and crash recovery.

All financial invariants from Phase 1 remain strictly enforced: integer paise, atomic budget reservations via SQLite serialized transactions, exact-intent cryptographic approval bindings, scoped idempotency, and an immutable append-only audit trail.

---

## 2. Architecture & Bounded Authority Flow

```
                      [ User / Browser ]
                              │
                              ▼
                "I need a wireless mouse for travel"
                     Budget: ₹2,000 (200000 paise)
                              │
                              ▼
                [ POST /api/agent/propose ]
                              │
                              ▼
               ┌───────────────────────────────┐
               │    AI Shopping Agent Service  │
               │   (OpenAI SDK / gpt-4o-mini)  │
               └──────────────┬────────────────┘
                              │ Returns: { product_id, quantity, reason }
                              ▼
        ══════════════════════╪═════════════════════════════════════
        BOUNDPAY TRUST BOUNDARY (Deterministic Server Authority)
                              ▼
               ┌───────────────────────────────┐
               │ 1. Catalog Attribute Resolver │  (Resolves price, category, merchant)
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │ 2. Deterministic Policy Gate  │  (Validates category, limits, budget)
               └──────────────┬────────────────┘
                              │
               ┌──────────────┴───────────────┐
               ▼                              ▼
        [ <= ₹2,500 threshold ]        [ > ₹2,500 threshold ]
             State: READY            State: NEEDS_APPROVAL
               │                              │
               │                   [ Human Operator Approves ]
               │                     (Exact SHA-256 Digest)
               │                              │
               └──────────────┬───────────────┘
                              │ State: READY / APPROVED
                              ▼
               ┌───────────────────────────────┐
               │ 3. Atomic Budget Reservation  │
               │   (SQLite BEGIN IMMEDIATE)    │
               │   Ledger: RESERVED            │
               │   State: EXECUTING            │
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │ 4. Razorpay Orders API Call   │
               │   (POST /v1/orders)           │
               │   Receipt: rcpt_intent...     │
               │   State: ORDER_CREATED        │
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │ 5. Razorpay Standard Checkout │
               │   (checkout.js Modal in UI)   │
               │   Human enters OTP / test card│
               └──────────────┬────────────────┘
                              │
               ┌──────────────┴────────────────┐
               ▼                               ▼
       [ Browser Callback ]           [ Webhook Notification ]
     POST /confirm-payment             POST /webhooks/razorpay
               │                               │
               ▼                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │ 6. Cryptographic Signature & Payment Verification        │
   │    - Checkout HMAC: order_id + "|" + payment_id          │
   │    - Webhook HMAC: raw request body + webhook secret     │
   │    - Timing-safe comparison (crypto.timingSafeEqual)     │
   │    - Authoritative Payment Check (status === 'captured') │
   └──────────────────────────┬───────────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │ 7. Exactly-Once Spend Confirmation & Audit Log           │
   │    - Ledger: RESERVED ──> CONFIRMED                      │
   │    - Intent: ORDER_CREATED ──> PAYMENT_CONFIRMED         │
   │    - Webhook Event: PROCESSED                            │
   │    - Audit Trail: PAYMENT_CONFIRMED                      │
   └──────────────────────────────────────────────────────────┘
```

---

## 3. Implementation Details

### 3.1 AI Shopping Agent (`src/services/agent.service.ts`, `src/domain/agent.ts`)
- **Structured Outputs**: Model is constrained via JSON schema validation (`AgentProposalOutputSchema`). It can return ONLY:
  ```json
  { "suitable": true, "product_id": "prod_mouse", "quantity": 1, "reason": "..." }
  ```
  or structured rejection:
  ```json
  { "suitable": false, "reason": "No catalog item matched budget..." }
  ```
- **Prompt-Injection Defense**:
  - Merchant product descriptions are labeled `[UNTRUSTED_TEXT]`.
  - System prompt explicitly commands the model to ignore any instructions, discounts, or authority claims embedded in descriptions.
  - Server-side catalog lookup enforces true prices and attributes; any model attempt to invent lower prices is ignored.
  - Sanitization (`sanitizeAgentReason`) strips HTML and script tags from model outputs.
- **Dual Mode**:
  - `AGENT_MODE=fixture`: Offline, deterministic keyword matcher for automated testing and zero-cost local runs.
  - `AGENT_MODE=live`: Invokes OpenAI API via official SDK. Throws clear actionable errors if API key is missing or invalid; **never silently falls back**.

### 3.2 Razorpay TEST Payment Adapter (`src/infrastructure/payment/razorpay-test-adapter.ts`)
- **Security Guard**: Hard rejection of live keys. Any key ID starting with `rzp_live_` or key secret starting with `live_` throws an immediate `RazorpaySecurityError`.
- **Orders API**: Creates server-side orders with integer paise, `INR` currency, unique stable `receipt`, and `notes: { intent_id }`.
- **Payment Verification**:
  - Validates `HMAC-SHA256` signature using `crypto.timingSafeEqual`.
  - Authoritative verification: Queries Razorpay Payments API (`/v1/payments/:id`) and confirms only when `status === 'captured'`. Payments with status `'authorized'` remain pending.
- **Dedicated Webhook Handler (`src/app/api/webhooks/razorpay/route.ts`)**:
  - Signature verified on the exact raw request body text before parsing.
  - Enforces 1MB payload size limit.
  - Deduplicates events via `webhook_events` table on `(provider, event_id)`.
  - Handles callback/webhook race conditions: If a webhook arrives before the order is saved, it is durably retained as `UNMATCHED` and reconciled immediately once the order is persisted.
- **Status Refresh & Uncertainty Resolution**:
  - `/api/intents/[id]/refresh-status`: Queries Razorpay for order status to recover missed browser callbacks.
  - Crash recovery: Transitions stale `EXECUTING` intents to `UNKNOWN` while preserving their budget reservations.

---

## 4. Test Verification Matrix

### 4.1 Vitest Unit & Integration Tests (129 / 129 Passed)
| Suite | File | Tests | Coverage |
| :--- | :--- | :--- | :--- |
| **Agent Schema & Service** | `test/unit/agent-proposal.test.ts` | 17 | Output parsing, quantity bounds, prompt injection, price tampering defense, HTML sanitization |
| **Razorpay Adapter Contract** | `test/unit/razorpay-adapter.test.ts` | 12 | Live-key rejection, credentials guard, order creation, mismatch handling, error mapping |
| **HMAC Signatures** | `test/unit/razorpay-signatures.test.ts` | 10 | Known test vectors, 1-byte tamper, wrong secret, wrong IDs, raw-body whitespace sensitivity |
| **Razorpay Checkout & Webhooks** | `test/integration/razorpay-checkout.test.ts` | 6 | Order creation, callback verification, webhook dedup, race reconciliation, status refresh, crash recovery |
| **Security & Auth HTTP** | `test/integration/agent-security.test.ts` | 7 | Auth guards on new routes, cross-owner protection, forgery defense, secret leakage prevention |
| **Phase 1 Regression Suites** | `test/unit/*.test.ts`, `test/integration/*.test.ts` | 77 | Money, catalog, policy, state machine, sqlite transactions, real concurrency, auth |
| **Total Vitest Tests** | **12 Files** | **129** | **100% Passed (3.88s)** |

### 4.2 Playwright End-to-End Browser Tests (10 / 10 Passed)
| Scenario | Description | Result |
| :--- | :--- | :--- |
| **Scenario 1** | Operator login and Wireless Mouse auto-allowed checkout | Passed (830ms) |
| **Scenario 2** | Mechanical Keyboard requires human approval, executes after approval | Passed (802ms) |
| **Scenario 3** | Subscription product is BLOCKED by deterministic policy | Passed (611ms) |
| **Scenario 4** | Policy view displays live budget usage and updates policy version | Passed (675ms) |
| **Scenario 5** | Activity view displays persistent audit events and JSON export | Passed (577ms) |
| **Scenario 6** | Repeated checkout clicks do not duplicate order or spend | Passed (817ms) |
| **Scenario 7** | Error messages are visible and actionable on policy rejection | Passed (638ms) |
| **Scenario 8** | Page reload preserves operator authentication session | Passed (608ms) |
| **Scenario 9** | AI Shopping Agent proposes product from natural language query | Passed (592ms) |
| **Scenario 10** | AI Shopping Agent rejects requests when no catalog items fit | Passed (720ms) |
| **Total Playwright Tests** | **1 Worker, Chromium Headless** | **10 Passed (8.8s)** |

### 4.3 Code Quality & Build Checks
- `pnpm run lint`: Passed with 0 errors and 0 warnings.
- `pnpm run typecheck`: Passed (`tsc --noEmit` exited 0).
- `pnpm run build`: Production build optimized successfully across all 14 routes.

---

## 5. Setup & Verification Instructions

### 5.1 Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Configure your credentials:
```ini
# Shopping Agent Mode ('fixture' for zero-cost offline, 'live' for OpenAI API)
AGENT_MODE=fixture
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini

# Payment Adapter Mode ('MOCK' or 'RAZORPAY_TEST')
PAYMENT_ADAPTER_MODE=MOCK
RAZORPAY_KEY_ID=rzp_test_yourKeyId
RAZORPAY_KEY_SECRET=yourKeySecret
RAZORPAY_WEBHOOK_SECRET=yourWebhookSecret
```

### 5.2 Running the Application
```bash
# 1. Reset and seed SQLite database
pnpm run db:reset

# 2. Run all unit and integration tests
pnpm test

# 3. Run Playwright E2E browser tests
pnpm run test:e2e

# 4. Start production server
pnpm run build
pnpm start
```
Access the application at `http://localhost:3000` and sign in with `operator` / `BoundPayPass123!`.
