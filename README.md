# BoundPay (Phase 1)
> **Bounded Financial Authority for Agentic Commerce**  
> *Track: Razorpay AI Growth & Agentic Commerce Buildathon*

BoundPay is a deterministic authorization, persistence, and state management platform that decouples autonomous AI shopping proposals from financial spending authority. In autonomous agentic workflows, an untrusted AI model may propose catalog products, but server-enforced spending policies, exact-intent cryptographic approvals, and atomic budget reservations strictly constrain monetary commitments.

---

## Technical Stack

- **Framework**: Next.js 14 App Router (Node.js runtime for financial routes)
- **Language**: TypeScript (strict mode, no implicit any)
- **Styling**: Tailwind CSS
- **Validation**: Zod (strict schema boundaries)
- **Database & ORM**: SQLite via `better-sqlite3` and `drizzle-orm` (WAL mode, serialized atomic transactions)
- **Testing**:
  - `vitest` for unit, boundary, and database concurrency integration tests
  - `fast-check` for property-based financial invariant tests
  - `@playwright/test` for end-to-end browser scenarios
- **Authentication**: `bcryptjs` password hashing, HttpOnly session cookies, SameSite enforcement, login rate-limiting, and CSRF origin verification
- **Payment Adapter**: Explicitly labeled `MockPaymentAdapter` with fault injection controls

---

## Scope & Non-Goals

### Implemented in Phase 1
- Single operator account and authentication session.
- Single approved merchant (`demo_store`).
- Strictly INR currency with **integer paise** arithmetic (₹1 = 100 paise; e.g., ₹2,799 = 279900 paise). Zero floating-point rupee math.
- Server-controlled, versioned catalog (tax and shipping included).
- Monotonically increasing, editable spending policy with Asia/Kolkata daily budget windows.
- Dual-bounded spending: `effective_limit = min(policy.max_transaction_amount_paise, purchase_budget_paise)`.
- Exact-intent human approval bound to canonical SHA-256 intent digests.
- Transaction-safe atomic budget reservations (`BEGIN IMMEDIATE`) preventing concurrent overspending.
- Scoped idempotency `(owner_id, idempotency_key, payment_adapter_mode)`.
- Append-only persistent audit trail with JSON export.
- Mock payment adapter supporting simulated bank rejections, timeouts, response loss, and pending auth.
- Three full views: **Shop**, **Policy**, and **Activity**.

### Explicitly Excluded (Do Not Add in Phase 1)
- No live LLM or external model APIs.
- No live Razorpay API calls (only explicitly labeled mock adapter).
- No multi-agent orchestration, RAG, vector databases, or blockchain.
- No model training.
- No refunds, payouts, or subscription billing integrations.
- No multi-tenant team management or organization hierarchies.
- Not claimed to be production-ready or immune to arbitrary real-world merchant misclassification.

---

## Quick Start & Verification

### 1. Prerequisites
- Node.js 20.x or higher
- `pnpm` (version 10+) or `npm`

### 2. Setup Environment
```bash
# Copy placeholder environment configuration
cp .env.example .env
```

### 3. Install Dependencies & Build Native SQLite Addon
```bash
pnpm install
```

### 4. Database Initialization (Safe Seed)
```bash
pnpm run db:seed
```
*Note: `db:seed` is idempotent and safe; it will never destroy financial history if run repeatedly.*

### 5. Running Tests

#### Run Unit, Property, and Database Integration Tests
```bash
pnpm test
```
Runs Vitest across all 7 test suites (77 tests passed):
- Unit & boundary tests (`test/unit/money.test.ts`, `test/unit/policy.test.ts`, `test/unit/state-machine.test.ts`, `test/unit/intent-canonical.test.ts`)
- Property-based tests (`test/property/financial-invariants.prop.test.ts`)
- Database concurrency & transactions (`test/integration/db-concurrency.test.ts`)
- Authentication & HTTP security (`test/integration/auth-http.test.ts`)

#### Run Playwright End-to-End Browser Tests
```bash
pnpm run test:e2e
```
Executes all 8 browser scenarios against the Next.js server with Playwright Chromium.

#### Typecheck and Lint
```bash
pnpm run typecheck
pnpm run lint
```

#### Production Build
```bash
pnpm run build
pnpm start
```

---

## Operator Credentials

For local testing and browser evaluation:
- **URL**: `http://localhost:3000/login`
- **Username**: `operator`
- **Password**: `BoundPayPass123!`

---

## Manual Walkthrough

1. **Sign In**: Navigate to `/login` and sign in with `operator` / `BoundPayPass123!`.
2. **Shop View (`/shop`)**:
   - Inspect the **Server-Controlled Catalog** showing Mechanical Keyboard (₹2,799), Wireless Mouse (₹1,499), Systems Engineering Book (₹899), and Support Subscription (₹12,999).
   - Click fixture **"2. Wireless Mouse x1"** (₹1,499) &rarr; Click **"Submit Proposal to Policy Engine"** &rarr; Notice state is `READY FOR CHECKOUT` because ₹1,499 is within the ₹2,500 auto-approval threshold &rarr; Click **"Execute Atomic Reservation & Mock Checkout"** &rarr; Payment confirmed immediately with Mock Order and Payment IDs!
   - Click fixture **"1. Mechanical Keyboard x1"** (₹2,799) &rarr; Submit proposal &rarr; State transitions to `NEEDS HUMAN APPROVAL` because ₹2,799 exceeds the ₹2,500 threshold &rarr; Click **"Human Operator Approve"** &rarr; State updates to `OPERATOR APPROVED` &rarr; Click checkout to complete payment.
   - Click fixture **"4. Support Plan Subscription"** &rarr; Submit proposal &rarr; Immediately `POLICY BLOCKED` because subscriptions are strictly prohibited by policy.
   - Select **"Simulate Bank Rejection"** or **"Simulate Gateway Timeout"** in the Mock Fault Injection dropdown to verify that timeouts preserve budget reservations in state `UNKNOWN` while definite rejections transition to `BLOCKED`.
3. **Policy View (`/policy`)**:
   - Inspect the **Daily Budget**, **Confirmed Spend Today (Asia/Kolkata)**, **Active Reservations**, and **Remaining Budget** cards.
   - Note the financial protection notice: the engine strictly rejects budget reductions below currently committed funds.
   - Update limits or allowed categories and click **"Save & Publish New Policy Version"** to increment the policy version.
4. **Activity View (`/activity`)**:
   - View the chronological append-only audit stream tracking every proposal, policy check, state transition, and reservation.
   - Click **"Export Audit JSON"** to download the complete audit trail as a JSON file.

---

## Persistent Documentation

Detailed architectural and verification documentation:
- [`docs/BOUNDPay_SPEC.md`](./docs/BOUNDPay_SPEC.md) – Authoritative specification covering trust boundaries, financial invariants, state machine, database schema, and API contracts.
- [`docs/PHASE_1_REPORT.md`](./docs/PHASE_1_REPORT.md) – Verification report detailing test results, concurrency testing methodology, invariants, and implementation details.
