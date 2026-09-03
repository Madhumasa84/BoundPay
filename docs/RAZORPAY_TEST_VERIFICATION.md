# Razorpay TEST Integration & Verification Report

**Date:** 2026-09-03  
**Mode:** `RAZORPAY_TEST`  
**Status:** **VERIFIED** (Live API Order Creation, Human Approval, Standard Checkout, HMAC Signature Verification, Authoritative Captured Status Lookup, Atomic Ledger Accounting, and Idempotency Replay)

---

## 1. Executive Summary

BoundPay has completed its live, authenticated end-to-end integration with Razorpay's TEST API. The operator performed an actual interactive standard checkout through Razorpay Standard Checkout in the browser. The server verified the payment signature using timing-safe HMAC-SHA256, verified the captured status through an authenticated Razorpay Payments API request, converted the budget reservation to confirmed spending in SQLite WAL, and appended the full immutable audit trail.

---

## 2. End-to-End Transaction Evidence

| Field | Verified Value | Proof Source |
|---|---|---|
| **Intent ID** | `d35445ee-e077-4337-bf97-4d8123fc8b0f` | `purchase_intents` table |
| **Product** | Mechanical Keyboard (`prod_keyboard`) | Server Catalog v3 |
| **Quantity** | `1` | Purchase Intent |
| **Unit Price / Total** | `279900` paise (₹2,799.00) | Zero-floating-point integer math |
| **Purchase Budget** | `300000` paise (₹3,000.00) | Operator input constraint |
| **Canonical Request Hash** | `8b08d6a4ae13b0c25fbe4378a9bbef4453f78ae74dd4bb23c583121aef9464ae` | SHA-256 canonical digest |
| **Approval Record** | ID: `ed57fe66-d888-457a-a3f5-760998db087f` | `intent_approvals` table |
| **Approval Binding** | Operator `a9b5ad08...95c` at `2026-09-03T16:05:35.542Z` | Cryptographically bound |
| **Razorpay Order ID** | `order_TXcjbyB4QUPgxL` | Razorpay API `POST /v1/orders` |
| **Razorpay Payment ID** | `pay_TXcmIeKNdSAV4M` | Razorpay Checkout Browser Handler |
| **Payment Method** | `netbanking` (simulated test bank) | Razorpay API `GET /v1/payments/:id` |
| **Payment Status** | `captured` (`captured: true`) | Razorpay API authoritative record |
| **Order Status** | `paid` (`amount_paid: 279900`) | Razorpay API authoritative record |
| **Ledger Row** | ID: `d847a0b9-60b3-46b7-91f5-955e742cc1df` | `spend_ledger` table |
| **Ledger Status** | `CONFIRMED` (amount: 279,900 paise) | Atomic transition in SQLite WAL |

---

## 3. Authoritative Provider API Records

Direct read-only inspection against official Razorpay API endpoints:

### Order Details (`GET https://api.razorpay.com/v1/orders/order_TXcjbyB4QUPgxL`):
```json
{
  "id": "order_TXcjbyB4QUPgxL",
  "amount": 279900,
  "amount_paid": 279900,
  "amount_due": 0,
  "currency": "INR",
  "receipt": "rcpt_d35445eee0774337",
  "status": "paid",
  "notes": {
    "intent_id": "d35445ee-e077-4337-bf97-4d8123fc8b0f",
    "merchant_id": "demo_store"
  },
  "created_at": "2026-09-03T16:05:45.000Z"
}
```

### Payment Details (`GET https://api.razorpay.com/v1/payments/pay_TXcmIeKNdSAV4M`):
```json
{
  "id": "pay_TXcmIeKNdSAV4M",
  "order_id": "order_TXcjbyB4QUPgxL",
  "amount": 279900,
  "currency": "INR",
  "status": "captured",
  "method": "netbanking",
  "captured": true,
  "description": "Mechanical Keyboard",
  "notes": {
    "intent_id": "d35445ee-e077-4337-bf97-4d8123fc8b0f",
    "merchant_id": "demo_store"
  },
  "created_at": "2026-09-03T16:08:18.000Z"
}
```

---

## 4. State Machine & Audit Trail Verification

The SQLite append-only audit trail records the exact progression:

| Event ID | Event Type | State Before | State After | Amount | Timestamp |
|---|---|---|---|---|---|
| 46 | `INTENT_PROPOSED` | `null` | `NEEDS_APPROVAL` | 279,900 paise | `2026-09-03T16:05:24.682Z` |
| 47 | `INTENT_APPROVED` | `NEEDS_APPROVAL` | `APPROVED` | 279,900 paise | `2026-09-03T16:05:35.546Z` |
| 48 | `INTENT_EXECUTING` | `APPROVED` | `EXECUTING` | 279,900 paise | `2026-09-03T16:05:44.881Z` |
| 49 | `ORDER_CREATED` | `EXECUTING` | `ORDER_CREATED` | 279,900 paise | `2026-09-03T16:05:45.500Z` |
| 50 | `PAYMENT_CONFIRMED` | `ORDER_CREATED` | `PAYMENT_CONFIRMED` | 279,900 paise | `2026-09-03T16:08:34.768Z` |

---

## 5. Invariant & Idempotency Checks

1. **Exactly One Confirmed Ledger Entry:**
   - Query: `SELECT count(*) FROM spend_ledger WHERE intent_id = 'd35445ee-e077-4337-bf97-4d8123fc8b0f'`
   - Result: Exactly `1` row.
   - Status: `CONFIRMED`.
2. **Provider Status Refresh:**
   - Calling `POST /api/intents/:id/refresh-status` queried Razorpay API, verified `status === 'paid'`, retained `PAYMENT_CONFIRMED`, and created **zero new orders**.
3. **Repeated Checkout Execution Replay:**
   - Calling `POST /api/intents/:id/execute` on the confirmed intent returned the existing order and payment details with message `Repeated checkout: intent already confirmed`.
   - Provider order count: unchanged (`order_TXcjbyB4QUPgxL` reused).
   - Spend ledger rows: exactly `1` before and `1` after replay (zero duplication).
4. **Namespace Isolation:**
   - `MOCK` and `RAZORPAY_TEST` namespaces remain completely isolated. Spend ledger entries under `RAZORPAY_TEST` do not pollute `MOCK` queries and vice-versa.

---

## 6. Webhook & Dashboard Status Disclosure

- **Razorpay Test Dashboard Confirmation:**
  - Operator should log into [Razorpay Dashboard](https://dashboard.razorpay.com/) in TEST mode.
  - Navigate to **Transactions > Payments**: confirm Payment ID `pay_TXcmIeKNdSAV4M` (Amount: ₹2,799.00, Status: Captured).
  - Navigate to **Transactions > Orders**: confirm Order ID `order_TXcjbyB4QUPgxL` (Amount: ₹2,799.00, Status: Paid, Receipt: `rcpt_d35445eee0774337`).
- **Actual Webhook Delivery Status:**
  - Marked **PENDING**: Razorpay servers require a publicly accessible HTTPS endpoint to deliver webhooks. Localhost is not publicly routable without an authorized tunnel or deployed domain.
  - The webhook handler logic itself (`/api/webhooks/razorpay`) is fully verified locally using exact HMAC-SHA256 signature fixtures and raw body byte-preservation tests.
  - Browser-callback payment verification does **not** depend on public webhooks; the server directly verified the signature and called the Razorpay Payments API to confirm captured status.
