# BoundPay Shared Authority — Phase 2 implementation record

**Branch:** `drunix-shared-authority` (isolated upgrade checkout)
**Status:** implemented vertical slice; actual Drunix local-network execution verified on 2026-09-27. Payment calls in the recorded two-service run were **MOCK only**.

This adds a shared, Passport-bound allowance to the existing BoundPay flow. Two separately configured BoundPay services reserve from the same Drunix mandate before either may dispatch. The result is a tested integration, not a new authorization algorithm, a production payment product, or a claim of affiliation with Citi, NPCI, or the event organizers.

## Existing features and Phase 2 additions

| Status | Features |
| --- | --- |
| **Existing BoundPay** | Ed25519 Authority Passports; deterministic merchant/category/amount/subscription/daily-budget policy; quote revalidation; human approval bound to an exact intent digest; SQLite reservation; MOCK and Razorpay TEST adapters; callback verification and reconciliation. |
| **Added in Phase 2** | Go Drunix chaincode for Passport-bound mandates and atomic reservations; certificate-derived identity checks; transaction commit-status validation and state queries; local durable outbox; one-time dispatch claim; unknown outcome recovery; prospective revocation; salted commitments; `/shared-authority` status UI. |
| **Still simulated** | `PAYMENT_ADAPTER_MODE=MOCK` creates synthetic orders/payments in process. The accepted demo uses this mode and does not call a provider or move funds. |
| **Available, not exercised here** | `PAYMENT_ADAPTER_MODE=RAZORPAY_TEST` uses Razorpay Test keys and the existing checkout/callback flow. No Razorpay credentials, live provider request, or bank settlement was used in the Phase 2 Drunix demo. |
| **Not implemented as a ledger** | `SHARED_AUTHORITY_MODE=SIMULATED` is a visible label only and fails closed before dispatch. `DRUNIX` is the only network-backed authorization mode; a connection/commit error never falls back to simulation or SQLite-only authorization. `DISABLED` preserves the existing single-service path. |

The original Razorpay evaluation checkout remains on the separate `razorpay-evaluation` checkout. The Phase 2 changes live on the isolated upgrade branch. The pre-existing modified `evaluation/policy-latency.json` is preserved and was not used as a test input. [Submission readiness and three-minute demo](./DRUNIX_SUBMISSION_READINESS.md) summarize the final review.

## Requirement-to-feature map and evidence

| Requirement | Implementation | Evidence/status |
| --- | --- | --- |
| Passport-bound issue, reserve, outcome, failure release, revoke and query | `contracts/shared-authority/chaincode/contract.go`; `src/services/shared-authority.service.ts` | Go unit tests and actual Drunix demo; one active mandate per Passport. |
| Contract-side bounds and identity | Mandate amount/usage/scope checks, authenticated MSP plus certificate-derived client ID, exact participant/executor/verifier allowlists | Actual Org1/Org2 network checks reject unauthorized issue/spend/revoke/outcome/unknown updates. |
| Idempotency and replay resistance | Stable request/reservation/payment-attempt IDs; immutable request commitment; same authenticated executor required for same-content retry; request index is unique per mandate | Actual retry returns one reservation; changed contents under a used ID are rejected. |
| Commit before dispatch | Gateway waits for a successful VALID commit status, then queries exact state. `BeginDispatch` must also commit VALID and be queried as `DISPATCHING` with the same tx ID | Actual concurrent BoundPay service run; `dispatchOnlyAfterCommittedClaim` contract demo check. No call follows an endorsement, submission response, timeout, or invalid commit alone. |
| Existing policy and human gates | `ExecutionService` still revalidates policy, catalog, Passport, and exact approval before `prepareSharedDispatch`; new shared cap is intersected with local Passport and daily-policy headroom at issuance | Both INR 2,799 keyboard intents in the app race required and passed the existing human-approval gate. Local TypeScript checks and E2E suite. |
| One authorized executor | `BeginDispatch` binds the claim to the identity that reserved; the app writes durable `MAY_HAVE_SENT` before the provider call and refuses automatic resend after that point | Actual race, timeout and restart checks. The identity key must not be cloned across separate service databases; see trust limits below. |
| External-payment gap and recovery | Pre-send ledger failure is retryable; provider uncertainty retains the Drunix hold; provider success/failure is recorded by an allowlisted verifier after provider evidence is checked; operator reconciliation reuses the same provider attempt | App demo tested a pre-send ledger outage, recovery after service restart, and an ambiguous provider timeout. Success-after-crash uses the existing provider lookup/callback path; not exercised against a real provider here. |
| Prospective revocation | Owner revocation commits `REVOKED`; Reserve checks that state. Existing RESERVED/DISPATCHING/UNKNOWN entries are unchanged and may be resolved; revocation does not recall a dispatched payment | Actual chaincode demo verifies committed revocation blocks new reservations. |
| Privacy | Signed Passport and purchase proof travel as transient proposal data; detailed purchase proof is not written to public world state. Commitment salt stays encrypted in each service’s SQLite outbox | Inspected chaincode writes; actual two-service run. Endorsing peers still see transient input, as described below. |
| Reproducible and honest integration | Pinned Drunix tag/commit, image digests, Node/pnpm/Go/Gateway dependencies, scripts and explicit MOCK/TEST/DRUNIX labels | Actual network and app commands, tx IDs, versions, and test outcomes are recorded below. |

## Contract, states, and participant permissions

The Go contract stores one mandate under `boundpay:mandate:<id>`, one Passport-to-mandate link, one request index and one reservation per unique ID. Reserving updates the mandate’s `reservedPaise` and `activeUsageCount` in the same transaction as the reservation write. The competing reservation transactions both read/write that mandate key; Drunix MVCC validation invalidates a stale contender instead of allowing the sum to exceed the cap.

Mandate state is `ACTIVE → REVOKED`. A reservation follows:

| From | To | Authorized actor and rule |
| --- | --- | --- |
| — | `RESERVED` | An allowlisted participant identity; contract validates the Passport signature, Passport/mandate binding, amount, scope, currency, usage count, request commitment, and remaining allowance. |
| `RESERVED` | `DISPATCHING` | Only the exact authenticated executor stored at reservation. `BeginDispatch` is a one-time committed claim. |
| `DISPATCHING` | `UNKNOWN` | Executor or verifier may mark uncertainty; amount remains reserved. |
| `DISPATCHING` or `UNKNOWN` | `SETTLED` | Allowlisted verifier records a success evidence commitment; reserved amount moves to settled. |
| `RESERVED` | `RELEASED` | Exact executor or verifier records a definitive failure. |
| `DISPATCHING` or `UNKNOWN` | `RELEASED` | Allowlisted verifier only; it must have definitive failure evidence. Timeouts never release. |

The owner identity that issued the mandate alone can revoke it. The owner, a named participant, or a named verifier may query it. A participant can query a reservation but cannot dispatch, resolve, or release another participant’s reservation. A verifier can record outcomes but cannot issue a new mandate or make a dispatch claim. Identities are derived by `GetClientIdentity()` from the authenticated Drunix transaction context, never copied from an HTTP body.

IDs are derived from the immutable BoundPay intent UUID: `req-`, `res-`, and `pay-` plus the first 32 lowercase hex digits of SHA-256(intent UUID). A retry must have the same mandate, request, attempt, Passport digest, executor identity, amount, currency, mode, scope and salted request commitment. Matching retry is idempotent; any changed content or a second reservation for the request is rejected. A failed dispatch attempt never gets a second payment attempt under the old ID.

**Dispatch authorization point:** `Reserve` must return a successful Drunix Gateway commit status (`VALID`), and a subsequent query must match the exact intent and show `RESERVED`. Then `BeginDispatch` must itself return `VALID`, and a query must show `DISPATCHING` with the same transaction ID. Only after both commits and both state checks does BoundPay write its durable pre-request marker and call the selected payment adapter. Endorsement or Submit acceptance is insufficient. A commit-status timeout is unknown; no provider call is made.

**Revocation order:** if revocation commits before a new Reserve, that Reserve is invalid or sees `REVOKED` on retry. If Reserve commits first, it remains valid even if revocation commits before the client observes the reserve commit. A RESERVED purchase may still receive its one-time dispatch claim after revocation. DISPATCHING/UNKNOWN payments remain eligible for verifier reconciliation. Revocation blocks future reservations; it does not cancel, refund, or recall a provider request already sent.

## Provider boundary, crash recovery, and duplicate dispatch

The local SQLite outbox is created before ledger activity. Its dispatch state is `NOT_SENT` until Drunix has authorized the one-time claim. BoundPay then commits `MAY_HAVE_SENT` before entering provider code. That conservative marker is not proof the bytes reached the provider; it prevents a restarted process from silently issuing a second request.

| Crash/failure point | Recovery behavior |
| --- | --- |
| Before Reserve commits | No provider call. Retry same intent and ID after Drunix returns. |
| Reserve committed, before local commit record/query | Repeat the same Reserve idempotently and query the reservation. Never dispatch until the VALID status and exact state are confirmed. |
| Dispatch claim committed, before `MAY_HAVE_SENT` | The exact executor may query the committed DISPATCHING entry and resume; code ordering means provider code has not yet been entered. |
| After `MAY_HAVE_SENT`, including immediately before send | Treat as possibly sent. Do not automatically repeat. Look up the same provider attempt; keep the amount reserved while evidence is absent or ambiguous. |
| Provider accepted/created an order, before local order ID was saved | Reconcile using the existing receipt where supported; save the recovered order ID and query status. No new create-order request is sent. |
| Provider captured payment, before Drunix outcome commit | Query the same order/payment or process the authenticated callback/webhook; validate the provider result, retry the idempotent verifier outcome transaction, then query Drunix. The reservation stays held until that ledger outcome is confirmed. |
| Provider timeout or lookup returns UNKNOWN/PENDING | Mark `UNKNOWN` where the network is available; retain the amount and expose the unresolved state. A missing result is not failure evidence. |
| Definitive provider failure | A configured verifier submits `ReleaseDefinitiveFailure`; local Passport and spend holds are released only after the Drunix release is VALID and query-confirmed. |

The Phase 2 UI at `/shared-authority` shows allowance, reserved/settled amounts, mandate revocation, reservation and payment state, dispatch state, and ledger tx IDs/validation code. `PENDING` means commit/query work is unfinished; `UNKNOWN` means a payment or ledger result is ambiguous and the reservation remains held. Operators reconcile; they do not create another request from the warning screen.

The Razorpay TEST adapter uses one durable BoundPay receipt for each order request and can query by that receipt or a saved order ID. Razorpay's current [Create Order documentation](https://razorpay.com/docs/api/orders/create/?preferred-country=IN) says a receipt is unique and treated as an idempotency key: a repeated create is rejected when an order with that receipt already exists, and the caller should fetch/reuse it. The adapter now classifies that duplicate-receipt response as UNKNOWN, preserving the Drunix reservation while reconciliation looks up the existing order. It does not automatically resend a timed-out request. This protects against creating a second order with the same receipt; it does not guarantee exactly-once payment attempts, capture or bank settlement. [Razorpay's Fetch Order documentation](https://razorpay.com/docs/api/orders/fetch-with-id/?preferred-country=IN) describes order status. The Phase 2 network demo did not make a Razorpay request, so this provider behavior was not exercised with TEST credentials.

The Drunix outcome transaction stores a verifier’s evidence commitment; chaincode does not independently prove bank settlement. The verifier and its provider-evidence validation remain a trust boundary.

## Privacy and commitments

`src/infrastructure/shared-authority/commitment.ts` supports only the values used by these schemas: ASCII field names, safe integer numbers, strings, booleans, arrays and objects, serialized as RFC 8785 JSON Canonicalization Scheme (JCS). The SHA-256 preimage is exactly:

```text
UTF8("boundpay:commit:v1:" + kind) || 0x00 || salt[32 random bytes] || UTF8(JCS(payload))
```

`kind` is `passport-scope`, `purchase-scope`, or `payment-outcome`. The random 256-bit salt makes guessing predictable product/amount payloads from a public hash infeasible. Salts are encrypted in the local outbox with AES-256-GCM using a separate `SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY` per service. Losing that key prevents the service from reopening its commitments; back it up as a secret alongside its database.

Public state includes the mandate cap and balances, Passport ID/digest, policy version, participant identities, IDs, amount/currency, payment mode, salted commitments, states and Drunix tx IDs. Product, merchant/category scope terms are held in the configured private data collection. A purchase proof and signed Passport are transient input and are not persisted in public state. Endorsing peers can see transient input while executing the proposal; the Org1/Org2 endorsers in this demo are therefore inside the privacy boundary. Provider credentials, certificate private keys, product descriptions, customer/payer data, addresses, payment references and raw provider payloads are not put on the public ledger.

## Distinctive contribution and prior work

The supportable contribution is an evidence-backed BoundPay integration: existing signed Authority Passport terms feed a Drunix contract that reserves one allowance across distinct participant identities, and the BoundPay outbox does not release uncertain provider outcomes. It joins these pieces in a runnable two-service demo. It is not a new atomic-budget or agent-permissions primitive. Related approaches already cover adjacent parts:

| Prior approach | Existing overlap | Evidence-bounded distinction here |
| --- | --- | --- |
| [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) | Scoped wallet execution permissions and policy evaluation | This demo coordinates one aggregate allowance across off-chain payment services on permissioned Drunix; it does not use Ethereum. |
| [Coinbase Agentic Wallet / spend permissions](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-smart-accounts/create-a-spend-permission) | Agent spend limits and wallet permissions | This demo reserves across different Drunix participant identities and retains unknown provider outcomes. |
| [Stripe Issuing authorizations](https://docs.stripe.com/api/issuing/authorizations) | Authorization-time spend controls | A central issuer is simpler when one issuer controls every transaction. The DLT case is when separate organizations must observe and enforce one shared budget. |
| [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications) | Agent identity/context and replay signals | Does not itself supply this demo’s shared off-chain aggregate reservation state. |
| [ProofGrid shared authority budgets](https://www.theproofgrid.com/multi-agent/shared-authority-budgets/) | Atomic reservations and held budget across uncertain outcomes | Very close conceptual prior work; the difference evidenced here is an actual BoundPay/Drunix network path, not the budget idea. |
| [AgentPact](https://docs.agentpact.dev/) | Signed mandates and delegated agent execution | This vertical slice uses BoundPay Passports with a multi-org Drunix state transition and a payment-provider recovery outbox. |

These are architecture-level comparisons, not a complete patent or product search. No “first” or “unique” claim is supported.

**When Drunix is worth its cost:** with one trusted BoundPay operator and one database, SQLite’s atomic transaction is cheaper and easier to operate. Drunix adds value only when legally/operationally distinct participants cannot rely on one operator’s database and need shared reservation/revocation evidence under a jointly governed endorsement policy. That assumption is only approximated here: Org1 and Org2 are sample organizations on one developer-controlled Docker host and share the same local governance/operator.

## Threat model and trust limits

| Threat | Mitigation | Remaining trust/limit |
| --- | --- | --- |
| Competing spends, stale simulation, replay | Single mandate balance key; MVCC validation; unique request index; immutable IDs/content; one executor claim | Depends on correct Drunix deployment, ordering and peer validation. |
| Forged participant or verifier | Certificate-derived MSP/client identity and exact contract allowlists | Organization MSP administrators and private-key custody remain trusted. Do not copy a participant certificate/key across independent services. |
| Participant bypasses policy/approval by invoking chaincode directly | Integrated BoundPay app enforces deterministic policy, exact approval and Passport checks before dispatch; contract still enforces hard mandate/Passport amount, usage and scope limits | Contract does **not** cryptographically prove the app’s local human-approval receipt or the entire mutable daily-policy calculation. A participant authorized to submit directly can bypass those app-only gates within contract-enforced terms. Treat participants as trusted BoundPay deployments until an approval attestation and complete shared-policy model are added. |
| Passport time expiry | Normal app validates Passport status and expiry before execution | The pinned Drunix-vendored chaincode API says `GetTxTimestamp` comes from the transaction ChannelHeader and is the **client's timestamp** ([v1.0.0 source](https://github.com/npci/drunix/blob/v1.0.0/vendor/github.com/hyperledger/fabric-chaincode-go/shim/interfaces.go#L360-L364)). It is not a trusted clock. Chaincode does not enforce `validFrom`/`expiresAt`; comparing against this client-supplied time would allow backdating. A participant with direct ledger credentials could use an otherwise valid old signature after expiry. Close this only with a consortium-trusted time attestation/authority or a supported ledger-time primitive and an agreed trust model. |
| Allowance accidentally multiplied | Contract allows one mandate link per Passport; new app issuance carves the cap out of Passport usage and local daily headroom | Previous spending outside this shared mandate on another participant’s independent database cannot be discovered by the issuer. Start with a fresh Passport or reconcile all pre-existing usage; do not also spend it through non-Drunix services. |
| Guessing a low-entropy purchase from a public hash | 32-byte random salt, domain-separated canonical hash; salt encrypted locally | Authorized endorsers still see the transient payload. Salt/key loss prevents later opening/rechecking the commitment. |
| False provider outcome | Existing Razorpay callback/HMAC or provider status validation precedes verifier submission | Drunix records the verifier’s statement and digest; it is not a payment oracle or settlement proof. Verifier identity can lie if compromised. |
| Provider timeout or duplicate order/payment | Durable `MAY_HAVE_SENT`, stable Razorpay receipt, duplicate-receipt conflict stays UNKNOWN, provider lookup and manual reconciliation; unknown reservation retained | Razorpay documents one order per receipt, but that does not guarantee exactly-once payment attempts/capture. A lost provider response or inconclusive lookup may require manual investigation and retain allowance indefinitely. |
| Revocation race | Shared contract serializes revoke and reserve writes; committed revoke blocks later reserves | Existing reservations and provider requests are not cancelled. A local-only Passport revocation that returns HTTP 503 while Drunix revoke is unavailable is not yet a cross-service cutoff; retry and verify the on-chain `REVOKED` state. |
| Ledger outage/restart | DRUNIX errors are fail-closed; outbox survives app restart; pre-send hold can resume after the ledger returns | Power-loss/filesystem durability and multi-host SQLite storage are not established. Use durable per-service storage and one process/database per identity. |

## Drunix source, versions, and deployment

Verified source checkout: [official `npci/drunix` v1.0.0](https://github.com/npci/drunix/tree/v1.0.0), commit `3fb2b135a5b2adf7e1071d9b1624052a1bbb1772`. Phase 1’s [Drunix capability review](./DRUNIX_PHASE1_DESIGN.md#drunix-capability-review) has the fuller identity, contract language, endorsement, commit-status and hackathon source register. The [official local-network README](https://github.com/npci/drunix/blob/v1.0.0/drunix-network/test-network/README.md) documents the two-org sample network, Go/Java/JavaScript/TypeScript chaincode choices, deployment scripts and prerequisites. The contract here is **Go** using Fabric Contract API Go `v2.2.0`; there is no EVM or Ethereum compatibility assumption.

The official repository did not provide a verified external Drunix TypeScript SDK or compatibility guarantee. This client uses the pinned standard Fabric Gateway Node client and was experimentally exercised against the actual Drunix v1.0.0 sample network. It is an observed integration, not a Drunix-endorsed client SDK claim.

| Component | Tested pin |
| --- | --- |
| Drunix source | tag `v1.0.0`, commit above |
| Contract toolchain | Go `1.23.0`; pinned `golang:1.23.0` image `sha256:acfb46be39840f8c2a6b9efdd673c6627011200c73bab4e6d18b8b9ab4641c46`; Fabric Contract API Go `v2.2.0` |
| BoundPay client | Node `v20.20.2`; pnpm `10.33.0`; `@hyperledger/fabric-gateway` `1.10.0`; `@grpc/grpc-js` `1.14.0`; app dependencies pinned by `pnpm-lock.yaml` |
| Local engine | Docker Engine `29.6.1`; Docker Compose `5.3.0` |
| Drunix peer | `npcioss/drunix-peer@sha256:dac28b37f9bd724d34edb7f1c20ca5b987667efa3270809f2ed1507fcf5f754f` |
| Drunix orderer | `npcioss/drunix-orderer@sha256:991da76f33c87459667b9f815eb44fb63f160c9fb5dcb114ed7b70491c9fda7b` |
| Drunix VSCC | `npcioss/drunix-vscc@sha256:9156b22fb4c9a02747d30515ec7e04183f246fea02df8edfc1d0821c496f6664` |
| Chaincode runtime images | `drunix-ccenv@sha256:769082d57a8c4aadce47f10c55c8732c0e6c87665cfc9eb47cb929283b7a2b8f`; `drunix-baseos@sha256:d110fe483eb8dbde03ca5bb04098db0ebcd1596b1e439abb8c92e3710285e585` |
| Sample data services | Yugabyte `2025.2.0.0-b131@sha256:3f7607281e9169597948792969a984f98683fa1cc327a920fed250616bf5e8d2`; KeyDB sample image `eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac` |

The sample’s host peer CLI reported `v2.5.14` while the peer container reported Drunix `1.0.0`; the official script warned about the mismatch. The tested lifecycle and Gateway calls still succeeded, but pin/use a matching official CLI for any deployment beyond this evidence. The helper `scripts/prepare-drunix-local-network.sh` pins the listed image digests and applies `max_clock_skew_usec=1500000` to the sample Yugabyte master/tserver. That local-only clock override was needed because the sample’s default 500 ms skew failed in this environment; it is not a production tuning recommendation.

### Reproduce the local network and chaincode

Install the official Drunix prerequisites listed by its README, including Bash 4, Git, Docker/Compose, Go and `jq`; the checkout must have its `drunix-network/bin` tools installed. Run this block from the BoundPay upgrade checkout. `BOUNDPAY_DIR` makes the chaincode path independent of the checkout name:

```bash
BOUNDPAY_DIR="$(pwd)"
git clone --branch v1.0.0 --depth 1 https://github.com/npci/drunix.git /tmp/drunix-v1.0.0
git -C /tmp/drunix-v1.0.0 rev-parse HEAD
./scripts/prepare-drunix-local-network.sh /tmp/drunix-v1.0.0
cd /tmp/drunix-v1.0.0/drunix-network/test-network
PATH="$BOUNDPAY_DIR/scripts/drunix-toolchain:/tmp/drunix-v1.0.0/drunix-network/bin:$PATH" ./network.sh up createChannel -c boundpay
```

On a fresh channel the first lifecycle sequence is `1` (increment it for each later definition update). Deploy the Go contract with both organizations endorsing and the included private collection:

```bash
PATH="$BOUNDPAY_DIR/scripts/drunix-toolchain:/tmp/drunix-v1.0.0/drunix-network/bin:$PATH" ./network.sh deployCC -c boundpay -ccn boundpay-shared-authority -ccp "$BOUNDPAY_DIR/contracts/shared-authority/chaincode" -ccl go -ccv 1.2 -ccs 1 -ccep "AND('Org1MSP.member','Org2MSP.member')" -cccg "$BOUNDPAY_DIR/contracts/shared-authority/collections_config.json"
```

This configures the two-organization endorsement policy and `BoundPayParticipantsCollection`; it does not establish independent governance because both organizations run under one local operator. The original Phase 2 run updated chaincode version `1.2` at lifecycle sequence `3`. On 2026-09-27 the review also created a new `boundpay-review` channel on the already running sample network and deployed the same contract at **sequence `1`**, with Org1/Org2 approvals and committed definition visible from both peers. A full network teardown and boot from empty Docker state was not repeated in that review.

### Configure, migrate, and run BoundPay

Use [`.env.example`](../.env.example) as the non-secret template. Keep a separate `.env` and SQLite path for each service. Set:

```dotenv
SHARED_AUTHORITY_MODE=DRUNIX
PAYMENT_ADAPTER_MODE=MOCK
DRUNIX_MANDATE_ID=boundpay-mandate-demo-v1
DRUNIX_CHANNEL=boundpay
DRUNIX_CHAINCODE=boundpay-shared-authority
DRUNIX_MSP_ID=Org1MSP
DRUNIX_GATEWAY_ENDPOINT=localhost:7051
DRUNIX_PEER_HOST_ALIAS=peer0.org1.example.com
DRUNIX_PARTICIPANT_IDENTITIES_JSON='[{"mspId":"Org1MSP","clientId":"<exact GetCallerIdentity clientId>"},{"mspId":"Org2MSP","clientId":"<exact GetCallerIdentity clientId>"}]'
DRUNIX_VERIFIER_IDENTITIES_JSON='[{"mspId":"Org1MSP","clientId":"<exact verifier GetCallerIdentity clientId>"}]'
DRUNIX_TLS_ROOT_CERT_FILE=/path/to/peer-tls-ca.pem
DRUNIX_CLIENT_CERT_FILE=/path/to/participant-signcert.pem
DRUNIX_CLIENT_PRIVATE_KEY_FILE=/path/to/participant-private-key.pem
DRUNIX_VERIFIER_CLIENT_CERT_FILE=/path/to/verifier-signcert.pem
DRUNIX_VERIFIER_CLIENT_PRIVATE_KEY_FILE=/path/to/verifier-private-key.pem
SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY=<base64 of independent random 32-byte key>
DATABASE_PATH=/path/to/service-org1.sqlite
```

For Org2 set its own MSP, peer endpoint/alias, certificate/key, verifier config as appropriate, encryption key and database path. The `clientId` strings must come from `GetCallerIdentity` using those exact certificates. Never commit `.env`, credentials, keys, salts or generated crypto material. Keep each Drunix private key confined to its named service.

Install the locked application dependencies and migrate existing SQLite data before starting either service:

```bash
cd "$BOUNDPAY_DIR"
pnpm install --frozen-lockfile
pnpm run authority:keys
pnpm run db:migrate
pnpm run db:seed
pnpm run build
pnpm start
```

For a fresh local instance, generate its own ignored authority key files and run `db:migrate` and `db:seed` against that instance’s `DATABASE_PATH`; repeat with each service’s separate database path. The sample two-service script creates isolated deterministic test keys itself, so the generated files are for a manual setup. Standalone CLI commands load `.env.local` before `.env`, with explicit process environment values taking precedence. `db:migrate` is additive. Do not reset a deployment database. A mandate is immutable once issued; if an earlier experimental mandate or local outbox does not match the current participant/verifier IDs, policy version, or commitment key, reconcile it and use a new Passport/mandate ID. Do not erase ledger history to make a retry appear clean.

Run the two demonstrations while the configured local network is up:

```bash
pnpm run shared-authority:drunix-demo
pnpm run shared-authority:drunix-app-demo
```

The app demo starts two production-mode Next processes with distinct Org1/Org2 client certificates, distinct application signing keys, and separate SQLite files. Both accept the other service's public signing key for verification. It creates a fresh isolated demo database under the printed `/tmp/boundpay-drunix-services-*` directory and uses seeded, non-secret fixture credentials only for its local operator sessions. Temporary application private/public key files are removed when the script stops; the sample verifier certificate is still available to both test services and is not independently governed. It requires a built `.next` tree and the test network identities at `/tmp/drunix-v1.0.0/drunix-network/test-network/organizations` (override with `DRUNIX_TEST_NETWORK_HOME`). Set `DRUNIX_DEMO_REVIEW_SECONDS=90` to keep both dashboards open briefly after the checks, or `DRUNIX_DEMO_AMBIGUOUS_FAULT=SIMULATE_RESPONSE_LOSS` to exercise a mock order accepted before its response is lost. The default ambiguity is `SIMULATE_TIMEOUT`.

Cleanup is explicit. Stop the official sample network from its test-network directory:

```bash
PATH="$BOUNDPAY_DIR/scripts/drunix-toolchain:/tmp/drunix-v1.0.0/drunix-network/bin:$PATH" ./network.sh down
```

This stops/removes the sample network containers and generated channel/network data; it leaves the source checkout and cached images. Remove only the exact printed `boundpay-drunix-services-*` demo directory when its retained SQLite evidence is no longer needed. Do not delete a directory with an unverified name.

## Recorded Phase 2 evidence

### Actual Drunix contract demo

Command: `pnpm run shared-authority:drunix-demo` against Drunix v1.0.0 and `boundpay-shared-authority` v1.2, lifecycle sequence 3. Exit status 0. Passed checks covered one winner under concurrent reservations, idempotent retry, changed-content ID reuse rejection, one Passport/one allowance, unauthorized issue/spend/revoke/outcome/unknown-update rejection, committed dispatch claim, timeout retained until verifier reconciliation, and revocation blocking new reservations. The final mandate was `bp-demo-e1dc6f13-9831-4eaa-85ef-486e85db4b90`; it ended with INR 4,000 settled, no reservations, and INR 1,000 available. Its reserve-race tx was `3598319c39c70c8fc1f634f3966646890746809af80d6dbbf7f1a952a6cbde24`, dispatch-claim tx `6db0b29dc7808c05281e48daaff940d7b4b772f3d3eb1003bcb1d4c182d6e13e`, verifier outcome tx `154b82599956a0021a753eb7b4a82f393878d21a10069e77f6129f47d1899a90`, revocation tx `92ebc03eded9c1eb5a7e2ab47593c7fe3c7a9c07cb12be86d47011ed34dd9cff`, and definitive-failure release tx `499033358fb267acbb0a6e1bfc8a7dd8891b1d09dfb16f4e24ad1d6b32ef22da`.

### Two independent BoundPay services

Command: `pnpm run shared-authority:drunix-app-demo`. Exit status 0. Drunix network: v1.0.0; chaincode v1.2 sequence 3; Org1 and Org2 identities; separate production-mode service processes and separate SQLite databases. The race used one INR 5,000 mandate and two INR 2,799 purchases, each passing exact human approval. Exactly one request reserved and dispatched; one was blocked. After its success had committed on Drunix, the demo marked only the local outbox acknowledgement unknown and retried the same stored verifier commitment; Drunix remained at one INR 2,799 settlement and no second payment request was sent. The same run retained an INR 899 ambiguous provider reservation through service restart, did not release it when provider lookup remained unknown, failed closed on a Drunix outage before provider dispatch, then safely resumed that no-send request after the ledger returned. Final public totals were INR 3,698 settled, INR 899 reserved/unknown, INR 403 available. All external payment outcomes were explicitly **MOCK — synthetic**.

Recorded transaction IDs from the final run:

| Operation | Drunix transaction ID |
| --- | --- |
| Issue mandate | `f64a989a7581c8e50b4fae2254a9e98ac485e9977bc5081ef9dcff930960d490` |
| Winning reserve | `2db27e39f8f4509f33d33c2f0bfa3fc9d3a4f4eac918d7cf6e83258845ffefbf` |
| Dispatch claim | `9511edc2d3a9ac9342a2b02edac5a2568cc6333bc03640958960211f301ee80a` |
| Success outcome | `c8d32d3fe2e3821d98a4c815200c5a319a19dca8daf95f711b6c44ea58faddff` |
| Timeout reservation | `3b75c0658ab5a669ebe4ea3b46a98103b6af5a515c236a631b591bb790664eaa` |
| Timeout dispatch claim | `8bb9155140c97059a953e579becdfd1276c8eb9e4f42d2cea05055fc03c214d4` |

### Code and browser checks

Latest results for this branch:

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | Pass on the final implementation, no TypeScript errors. |
| `pnpm run lint` | Pass, no ESLint warnings/errors; Next 15 prints a deprecation notice for `next lint`. |
| `pnpm run build` | Pass on Next.js `15.5.21`; `/shared-authority` and all API routes compiled. |
| `pnpm test` | Pass: 343/343 across 31 files on 2026-09-27. The Phase 4 migration test now builds a synthetic Phase 3 schema and evidence fixture, and the Sarvam fixture test seeds an isolated temporary database. Neither depends on ignored local `data/boundpay.sqlite`. The migration test proves preservation of representative synthetic rows, not preservation of the historical developer database. |
| `pnpm exec vitest run test/unit/razorpay-adapter.test.ts` | Pass, 13/13 including the new duplicate-receipt UNKNOWN/reservation-retention classification. Uses a simulated HTTP response; no Razorpay API request was made. |
| `pnpm run test:e2e` | Pass, 18/18 Chromium tests on the final source state; the reconciliation assertion requires an explicit UNKNOWN/held/no-retry message. |
| `PATH=/tmp/boundpay-drunix-upgrade/scripts/drunix-toolchain:$PATH go test -mod=readonly ./...` from `contracts/shared-authority/chaincode` in the pinned Go 1.23.0 container | Pass after final contract code; `go fmt ./...` also passed. |
| `pnpm run security:public-artifacts` | Clean-checkout scan passed across 104 public artifacts; configured authority private key and four configured secret checks were `NOT_FOUND`. This checks named configured values, not every possible secret. |
| `git diff --check` | Pass before the final documentation update; rerun at completion. |

## Hackathon fit and unverified rules

The event-rule source register and original announcement snapshot are in [Phase 1](./DRUNIX_PHASE1_DESIGN.md#hackathon-rules-and-fit). Rechecked on 2026-09-27 against the [Innovation Carnival announcement](https://www.linkedin.com/posts/innovation-carnival_drunix-innovationcarnival-activity-7506253600449523712-jeWj): it publicly lists AI & Fraud Detection, Real-Time Payments, Financial Inclusion, Cross-Border Remittances, and Open Finance APIs; it advertises registration from 10–30 September 2026. It does not list `CHL-7007` or “Innovative Fintech Ideas” in the visible post. The registration short links could not be opened by the available research tool, and no rulebook was exposed. Existing-project reuse, submission stages, complete team/judging rules, actual API credentials/access, and the final submission deadline remain unverified. Registration closing on 30 September is not evidence of a final prototype deadline. The vertical slice is a plausible fintech/shared-control fit; its MOCK demo is not itself a real-time payment rail. Do not imply access to NPCI/Citi APIs, endorsement, or event eligibility without organizer confirmation.

## Acceptance checklist and remaining limitations

- [x] Two service instances and identities race against the same allowance; one purchase succeeds and the cap is not exceeded.
- [x] Reserve and dispatch both require VALID commit status plus matching committed-state queries before provider code.
- [x] Duplicate Reserve is idempotent; changed transaction contents under a used ID are rejected.
- [x] Unauthorized identities cannot issue, revoke, spend, or alter/confirm another participant’s outcome.
- [x] Committed revocation blocks new reservations and does not pretend to cancel existing/in-flight payments.
- [x] Ambiguous provider result remains reserved through restart; no blind retry; ledger outage before send fails closed and can recover after restore.
- [x] Razorpay's documented duplicate-receipt response is classified UNKNOWN so it cannot release a reservation while the prior order may exist; adapter regression test passes. This is not a live provider test.
- [x] Existing deterministic policy, exact approval, Passport checks and Razorpay TEST/MOCK separation remain in the execution path; browser suite passes 18/18.
- [ ] Actual Razorpay TEST order/capture plus crash-after-acceptance and outcome-commit reconciliation; credentials and provider transaction were not available or exercised for this Phase 2 run.
- [ ] Independent organization governance/peer hosts; the tested two-org topology ran on one local Docker host.
- [ ] On-chain trusted Passport expiry, cryptographic proof of local human approval, and distributed enforcement of mutable daily-policy state. Current service gates enforce these only for participating BoundPay applications; authorized identities are trusted not to bypass the application directly.
- [ ] Exactly-once payment attempt/capture/settlement. Razorpay documents duplicate Order creation protection per receipt, but that does not make payment capture or settlement exactly once; ambiguous outcomes remain held for provider/manual reconciliation.
- [x] Fresh **channel** deployment of version 1.2, sequence 1, was run on the already running sample network; this does not claim a full Docker network cold start.
- [ ] Reusable migration/recovery for experimental on-chain mandates with stale identity or policy terms; keep old history and issue a fresh Passport/mandate as instructed.

The principal uncertainty is no longer whether Drunix can run this vertical slice: it did on the pinned local sample. The unresolved platform and event questions are governance/client support outside the sample, contract-enforced Passport time and app approval, production deployment topology, and event eligibility/API access.

## External inputs needed to close the remaining gaps

The operator reported that no official CHL-7007 rulebook, Razorpay TEST credentials, or separately operated Org2 endpoint are available and chose a mock demonstration for those unavailable inputs. The reproducible local run therefore keeps **actual Drunix ledger commits** while using **MOCK synthetic payments** and **two identities on one developer-controlled sample network**. Public event information remains an unverified planning assumption. A mock cannot establish organizer eligibility, independent governance, official SDK support, trusted ledger time, human presence, or actual provider settlement. Those items remain open rather than being marked complete.

| Gap | Required input/evidence |
| --- | --- |
| Independent organization governance | A second organization must operate its own peer/CA and service host, approve the endorsement/channel rules, and participate with its own credentials. A second identity on this local sample is not independent governance. |
| Official external client support | Drunix maintainer documentation or confirmation of a supported external SDK/protocol. The current Node Gateway integration is network-tested but remains an experimental compatibility result. |
| On-ledger Passport expiry | A consortium-approved trusted-time or time-attestation design. Drunix's `GetTxTimestamp` is explicitly client-supplied; chaincode cannot safely treat it as consensus time. |
| Cryptographic owner approval | An owner-controlled signing credential, separate from each participant service key, plus an agreed enrollment and user-presence model. A server-signed statement alone proves the server's assertion, not a human action. |
| Independent payment settlement evidence | A provider-signed verifiable receipt or a named trusted settlement oracle. A verifier signature records who attested; it does not make Drunix a bank/payment oracle. |
| Razorpay TEST demonstration | Test-only API credentials configured locally (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and where needed `RAZORPAY_WEBHOOK_SECRET`) and authorization to create a controlled TEST order/payment. None are set in this environment. Do not send keys in chat. |
| Challenge eligibility and rules | The organizer's CHL-7007 problem statement/rulebook or access to the registered event portal. Public posts currently expose only the general tracks and registration window; their short links were inaccessible to the research tool. |

The receipt-idempotency change is implemented and covered with a simulated HTTP response. It can be validated against Razorpay TEST once credentials and a test account are available. No provider request was made for this update.
