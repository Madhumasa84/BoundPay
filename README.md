# BoundPay (Phase 1 & Phase 2)
> **Bounded Financial Authority for Agentic Commerce**  
> *Track: Razorpay AI Growth & Agentic Commerce Buildathon*

BoundPay is a deterministic authorization, persistence, and state management platform that decouples autonomous AI shopping proposals from financial spending authority. In autonomous agentic workflows, an AI model may propose catalog products, but server-enforced spending policies, exact-intent cryptographic approvals, atomic budget reservations, and human-completed Razorpay checkout strictly constrain monetary commitments.

---

## Technical Architecture

```
                      [ User / Operator ]
                              │
                              ▼
                "I need an ergonomic keyboard under ₹3,000"
                              │
                              ▼
               ┌───────────────────────────────┐
               │    AI Shopping Agent Service  │
               │ (OpenAI gpt-4o-mini / Fixture)│
               └──────────────┬────────────────┘
                              │ Proposed Product & Quantity
                              ▼
        ══════════════════════╪═════════════════════════════════════
        BOUNDPAY TRUST BOUNDARY (Deterministic Server Authority)
                              ▼
               ┌───────────────────────────────┐
               │ 1. Catalog Attribute Resolver │  (Trusted Price & Category)
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │ 2. Deterministic Policy Gate  │  (Limits, Allowed Categories)
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
               │ 4. Payment Adapter Dispatch   │
               │   - MOCK: Mock confirmation   │
               │   - RAZORPAY_TEST: Orders API │
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │ 5. Razorpay Standard Checkout │
               │   (Client Modal / Test Card)  │
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
   │    - Authoritative status check: status === 'captured'   │
   └──────────────────────────┬───────────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │ 7. Spend Confirmation & Append-Only Audit Trail          │
   │    - Ledger: RESERVED ──> CONFIRMED                      │
   │    - Intent: ORDER_CREATED ──> PAYMENT_CONFIRMED         │
   │    - Audit Log: PAYMENT_CONFIRMED                        │
   └──────────────────────────────────────────────────────────┘
```

---

## Technical Stack

- **Framework**: Next.js 14 App Router (Node.js runtime for financial routes)
- **Language**: TypeScript (strict mode, zero type errors)
- **Styling**: Tailwind CSS with Lucide icons
- **Validation**: Zod (strict schema boundaries and untrusted output sanitization)
- **Database & ORM**: SQLite via `better-sqlite3` and `drizzle-orm` (WAL mode, serialized atomic transactions)
- **AI Integration**: Official OpenAI SDK (`gpt-4o-mini`) + deterministic offline fixture matcher (`AGENT_MODE=fixture|live`)
- **Payment Gateway**: Official `razorpay` Node SDK + Standard Checkout client script (`checkout.js`) with hard `rzp_live_` safety guards
- **Testing**:
  - `vitest` for unit, contract, signature, and concurrency integration tests (129 tests)
  - `@playwright/test` for full-browser end-to-end scenarios (10 scenarios)
- **Authentication**: `bcryptjs` password hashing, HttpOnly session cookies, SameSite enforcement, and login rate limiting

---

## Core Financial Invariants

1. **Integer Paise Only**: 1 INR = 100 paise. Zero floating-point rupee arithmetic anywhere in authorization or accounting.
2. **Deterministic Bounded Authority**: The AI model has zero financial authority. It proposes products; server code enforces all spending limits, categories, and approval thresholds.
3. **Exact-Intent Approval**: Human approvals cryptographically bind to a canonical SHA-256 digest of intent parameters. Price changes or policy updates invalidate prior approvals.
4. **Atomic Budget Reservation**: Budget availability check and reservation insertion run inside SQLite serialized write transactions (`BEGIN IMMEDIATE`) before calling payment adapters.
5. **HMAC-SHA256 Signatures**: Standard checkout callbacks and webhooks verify HMAC signatures using timing-safe comparisons before any state transition.
6. **Authoritative Provider Verification**: The application verifies that payment status is `'captured'` on the Razorpay API; authorized payments remain pending.
7. **Webhook Deduplication & Race Handling**: Webhooks deduplicate on `(provider, event_id)` and retain unmatched events when notifications arrive before local order persistence.
8. **Lost Callback Recovery**: Operators can refresh provider status on demand to recover missed browser callbacks.
9. **Crash Recovery**: Stale executing intents recover to `UNKNOWN` without creating duplicate orders; reservations remain held for reconciliation.

---

## Quick Start & Verification

### 1. Prerequisites
- Node.js 20.x or higher
- `pnpm` (version 10+) or `npm`

### 2. Setup Environment
```bash
cp .env.example .env.local
```

### 3. Initialize & Seed Database
```bash
pnpm run db:reset
```
Default credentials:
- **Username**: `operator`
- **Password**: `BoundPayPass123!`

### 4. Run Automated Test Suite
```bash
# Run all 129 Vitest unit, contract, signature, and integration tests
pnpm test

# Run all 10 Playwright E2E browser scenarios
pnpm run test:e2e

# Run linting and TypeScript checks
pnpm run lint
pnpm run typecheck
```

### 5. Start Application
```bash
pnpm run build
pnpm start
```
Visit `http://localhost:3000` to interact with the BoundPay operator dashboard.

---

## Documentation Links

- **Phase 1 Implementation Report**: [`docs/PHASE_1_REPORT.md`](docs/PHASE_1_REPORT.md)
- **Phase 2 Implementation Report**: [`docs/PHASE_2_REPORT.md`](docs/PHASE_2_REPORT.md)
- **Complete Architecture Specification**: [`docs/BOUNDPay_SPEC.md`](docs/BOUNDPay_SPEC.md)
