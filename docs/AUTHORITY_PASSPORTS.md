# Authority Passports (Phase 4)

## Purpose and scope

An Authority Passport is a signed, revocable, machine-verifiable mandate that describes exactly what one BoundPay agent may purchase for one authenticated operator. It constrains the existing Phase 3 policy and execution services; it is not a login token, a payment credential, an SDK, or a provider receipt. Phase 4 remains one operator, one approved merchant, INR, SQLite, `MOCK`/Razorpay TEST only, and a single application instance.

## Version-1 payload

The immutable signed payload uses canonical UTC timestamps and integer paise:

| Field | Meaning |
|---|---|
| `schemaVersion` | Versioned passport schema (`1`) |
| `passportId` | Server-generated `pass_…` identifier |
| `issuer`, `audience` | Configured BoundPay authority claims |
| `operatorId`, `ownerId` | Same authenticated operator; both are checked |
| `agentId`, `agentDisplayName` | Explicit agent subject and display label |
| `currency` | `INR` only in this phase |
| `allowedMerchantIds`, `allowedCategories` | Non-empty explicit allowlists; unknown values fail closed |
| `maximumAmountPerTransactionPaise` | Positive safe integer |
| `cumulativeBudgetPaise` | Positive safe integer, at least the per-transaction maximum |
| `approvalRequiredAbovePaise` | Non-negative safe integer, no greater than per-transaction maximum |
| `validFrom`, `expiresAt` | Canonical `YYYY-MM-DDTHH:mm:ss.sssZ`; enforcement is UTC |
| `maximumUsageCount` | Positive bounded integer |
| `policyVersion` | Server policy version observed at issuance (informational; current policy still wins) |
| `revocationNonce` | Server-generated random nonce retained for revocation/audit |
| `issuedAt` | Authority issuance timestamp |
| `keyId` | JWS protected-header `kid` and verification-registry key |

Empty merchant/category arrays never mean unrestricted access. Passport creation validates every allowlisted merchant/category against the active trusted catalog. No floating-point money is accepted by the domain or persistence layer.

## Storage and lifecycle

`authority_passports` stores the exact payload JSON, SHA-256 payload digest, compact JWS, key ID, owner, validity fields, and revocation metadata. Payload fields are immutable. Status is `ACTIVE`, `REVOKED`, or `EXPIRED`; expired status is derived from the UTC clock and persisted when encountered during proposal/execution. Revoked rows are never deleted. Every mutation is owner checked and audited.

Each bound intent has at most one `passport_usages` row by a unique `(passport_id, intent_id)` index. The row stores amount, adapter namespace, status, reservation timestamp, and release/commit timestamp. `RESERVED`, `COMMITTED`, `CONFIRMED`, and `UNKNOWN` consume budget and usage allowance. Only a definite provider rejection transitions to `RELEASED`; browser closure, lost responses, date changes, restart, or an unresolved provider result do not release authority.

## Signing and verification

Passports and decision receipts are compact JWS values with `alg=EdDSA`, Ed25519 signatures, an explicit `typ`, and a protected `kid`. Node's standard Ed25519 implementation emits the compact JWS synchronously so the existing synchronous proposal service architecture is preserved; the maintained `jose` package provides the async JOSE verification/offline proof path. The verifier rejects `alg=none`, unsupported algorithms/types, malformed or oversized tokens, unknown key IDs, header/payload key-ID mismatches, wrong issuer/audience, unsupported schemas, invalid UTC windows, and altered signatures/payloads.

Required server-only configuration in a non-test environment:

```text
AUTHORITY_SIGNING_PRIVATE_KEY or AUTHORITY_SIGNING_PRIVATE_KEY_FILE
AUTHORITY_SIGNING_PUBLIC_KEY or AUTHORITY_SIGNING_PUBLIC_KEY_FILE
AUTHORITY_SIGNING_KEY_ID
AUTHORITY_ISSUER
AUTHORITY_AUDIENCE
```

`AUTHORITY_VERIFICATION_KEYS_JSON` may hold additional `kid` → public-key entries for rotation. The private key is never returned by an API, placed in a client bundle, logged, committed, or included in proof bundles. `pnpm run authority:keys` writes ignored `.authority/authority-private.pem` (0600) and `.authority/authority-public.pem` and prints only configuration instructions. `AUTHORITY_TEST_MODE=true`/`NODE_ENV=test` enables one deterministic, unmistakably test-only key; it is not a production fallback. `pnpm run authority:validate` is the strict configuration check used before startup/deployment.

An offline proof verifier may use the public JWK from a sanitized bundle. That verifies the configured authority's signature and signed-content integrity. It does not independently prove that the issuer database was complete, that the signing host was uncompromised, or that a bank/provider transfer settled.

## Effective-policy composition

At proposal authorization and again immediately before atomic execution, BoundPay intersects:

1. Current server policy (merchant, category, subscription, currency, limits, daily budget, approval, expiry).
2. Signed passport constraints (merchant/category, per-transaction/cumulative/usage limits, validity, owner, agent).
3. Trusted catalog data (product, current price/version, merchant/category, subscription flag).
4. Existing commitments in the selected adapter namespace.
5. Exact approval bound to the canonical intent digest.

The strictest per-transaction and approval limits win. A merchant/category must pass both layers. A passport cannot enable subscriptions prohibited by server policy. A current policy or catalog/price change invalidates stale approval. Revocation or expiry after approval blocks execution before provider dispatch. The receipt is not used as the sole execution authorization; execution revalidates all stored inputs.

## Decision receipts and debugger

Every deterministic passport authorization result (`ALLOWED`, `NEEDS_APPROVAL`, `BLOCKED`, `EXPIRED`, `REVOKED`) creates an immutable signed decision receipt. It includes the receipt schema/version and ID, intent/request/passport IDs and digests, owner-bound agent, trusted product/merchant/category/quantity/unit price/total/currency, policy version, decision, stable reason codes, human explanation, observed passport budget, clearly projected post-execution budget, approval requirement, timestamp, issuer, audience, and `kid`. It is explicitly not a Razorpay payment receipt.

Shop's Visual Authorization Debugger exposes signature, lifecycle, owner/agent, catalog, merchant/category, subscription, transaction, passport budget/usage, server budget, approval, quote/policy version, and execution-permission checks. Each check shows PASS, FAIL, or REQUIRES_ACTION, a stable reason code, plain-language explanation, and its source (`SIGNED_PASSPORT`, `AUTHENTICATED_OPERATOR`, `TRUSTED_CATALOG`, `CURRENT_SERVER_POLICY`, `LEDGER`, `PROVIDER`, or `SYSTEM`). It includes “Why was this blocked?”, “What would make it allowable?”, projected-budget labels, stricter-policy warnings, stale-approval warnings, and a receipt signature indicator. The interface is keyboard operable at 390×844.

## Five-minute demonstration

1. Run `DATABASE_PATH=/tmp/boundpay-e2e.sqlite CONFIRM_RESET=true pnpm run db:reset` only for a disposable demo DB; keep verified provider evidence elsewhere.
2. Start with `AGENT_MODE=fixture PAYMENT_ADAPTER_MODE=MOCK`, log in as the seeded operator, and open **Passports**.
3. Show OfficeBot's explicit INR/merchant/category/amount/budget/approval/usage/expiry constraints and EdDSA `kid`; issue another passport if desired.
4. Select an ACTIVE passport in Shop, submit a mouse/book, and inspect every debugger stage. Verify/download the signed decision receipt proof bundle.
5. Submit a keyboard to show NEEDS_APPROVAL, then approve the exact digest. Revoke a passport before execution (or let it expire) to show durable denial and a new-decision requirement.
6. State the mode labels and limitations: fixture/mock are synthetic; receipts prove signatures, not payment settlement.

## Remaining production limitations

No multi-organization tenancy, role hierarchy, refunds/disputes, durable worker system, public SDK/MCP, PostgreSQL, real-money mode, custom cryptography, audit hash chain, or complete prompt-injection defense is introduced. SQLite remains single-instance; power-loss, storage corruption, and independent bank settlement are not proven. A valid allowed choice may still be undesirable, and a compromised host/key remains outside application verification.
