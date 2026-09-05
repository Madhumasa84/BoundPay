# Authority Passport Threat Model (Phase 4)

## Assets

- The operator's authority to spend within explicit INR limits.
- Immutable passport payloads, revocation status, usage rows, and decision receipts.
- Exact intent/approval digests, daily budget reservations, and provider identifiers.
- Ed25519 signing private key and the configured verification-key registry.

## Trust boundaries

| Boundary | Untrusted input | Server control |
|---|---|---|
| Browser/model → proposal | Product request, quantity, budget, rationale, passport/agent IDs, model prose | Zod request schema; server catalog/policy resolution; owner session |
| Passport token → verifier | Header, payload, signature, `kid`, timestamps | Configured issuer/audience/key registry; EdDSA/JWS verification; schema/UTC checks |
| Operator → passport mutation | All constraint fields and idempotency key | Authenticated owner, trusted catalog allowlists, integer bounds, server issuer/kid/policy |
| Intent → execution | Stored quote, product, policy, passport, approval, budget | `BEGIN IMMEDIATE` revalidation and atomic ledger/usage reservation |
| Receipt/proof → external verifier | Downloaded JWS/JWK/payload | Standard JOSE offline verification; explicit limitation that it is not settlement proof |

## Threats and controls

### Forged or broadened authority

An attacker may alter one passport field, replace a signature, use `alg=none`, supply an unknown `kid`, wrong issuer/audience, future/expired timestamps, or an arbitrary public key. The verifier accepts only EdDSA, the expected type/schema, a protected/header-payload-matching `kid` present in the server registry, configured issuer/audience, and valid UTC timestamps. It never trusts a public key embedded by the token. Offline verification is a separately explicit proof-bundle operation.

### Horizontal IDOR and confused deputy

Every passport, intent, receipt, proof, approve, execute, revoke, and status path authenticates the operator and compares the stored owner. A valid passport from operator A cannot be used by operator B, and the signed owner/agent binding is checked against the authenticated owner and stored intent. Missing/foreign resources return sanitized not-found responses.

### Allowlist and model manipulation

Empty allowlists are invalid; unknown merchants/categories fail at issuance and at intersection. Price, currency, merchant, category, subscription status, policy version, budget, and approval are never accepted from model prose. Trusted catalog/policy values are used to produce the signed receipt and to authorize execution.

### Stale approval, revocation, and expiry

The passport ID and payload digest are part of the canonical intent hash. Product/policy/quote/passport changes, revocation, not-before, or expiry are revalidated immediately before dispatch. A revoked/expired mandate never widens access and creates a durable blocked/expired state plus a lifecycle receipt. The decision receipt cannot be replayed as an execution capability.

### Budget and usage races

The same SQLite `BEGIN IMMEDIATE` transaction claims the intent, rechecks current policy, sums mode-specific spend, checks passport cumulative budget and usage count, inserts the unique spend-ledger row, inserts the unique passport-usage row, and marks the intent executing. Worker-thread contention using independent SQLite connections and an Atomics barrier exercises one-use, one-budget, replay, revocation, expiry, policy, and catalog races. `UNKNOWN`, `COMMITTED`, and `CONFIRMED` rows remain consuming; only a definite rejection is released.

### Receipt misuse

Receipts contain trusted facts, stable reasons, observed budget, and a field explicitly marking the post-execution balance as projected. They are immutable signed statements, not Razorpay receipts, bearer tokens, payment credentials, or proof that a bank transfer happened. Proof bundles contain only public verification material and instructions.

### Secret exposure and denial of service

Private authority keys are environment/file-only, excluded by `.gitignore`, validated at startup, and absent from JSON responses/client bundles. Payload/token size limits prevent oversized requests. Sanitized error handlers omit stack traces, provider bodies, and internal secrets. Rate limiting, compromised hosts, stolen sessions/keys, power loss, storage corruption, and distributed multi-instance coordination remain outside this phase.

## Residual risk and evidence limits

The controls prove the explicit application invariants in automated tests with deterministic test keys and fixture/mock providers. They do not claim production security, universal prompt-injection prevention, complete issuer databases, uncompromised signing infrastructure, exactly-once external payment execution, immutable audit logs, real-money readiness, or third-party settlement. Existing Sarvam and Razorpay TEST evidence is historical and not rerun for Phase 4.
