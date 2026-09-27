# BoundPay: Shared Spending Authority for AI Agents

**Phase 1 design and feasibility record — snapshot taken 2026-09-26**

**Historical status:** at this snapshot, the Drunix extension was a proposal only. Phase 2 has since implemented and tested a Drunix-backed vertical slice on the isolated `drunix-shared-authority` branch. See the [Phase 2 implementation record](./DRUNIX_PHASE2_IMPLEMENTATION.md) for current code, network evidence, exact setup commands, test results, and remaining limits. The source review, prior-work comparison, hackathon-rule uncertainty, and baseline notes below remain the Phase 1 record.

## Proposal and decision

Extend BoundPay’s signed Authority Passports with a shared allowance that two independently operated services must reserve from the same Drunix state before either dispatches an external payment. The useful demo is a real concurrency race: two service processes, distinct Drunix identities, isolated local state, one mandate, and one remaining allowance. Both requests may be locally valid; Drunix’s committed state must allow only the requests that fit the aggregate balance.

This is a defensible integration proposal, not a claim of a new authorization algorithm. Public prior work already describes shared agent budgets, atomic reservation, and holding reservations across uncertain outcomes. The evidence-bounded contribution would be a working BoundPay/Drunix demonstration that joins signed Passport terms, multi-organization shared reservation and revocation evidence, and BoundPay’s explicit unknown-payment reconciliation behavior. That distinction remains a proposal until independently deployed services pass the acceptance tests below.

Drunix is justified only when independent organizations need to coordinate against shared state without making one BoundPay operator’s database the authority. For one owner and one operator, the existing SQLite service is simpler, cheaper, and already provides atomic reservation. If participants can use a central service, share a common database, or bypass the payment gate, Drunix adds operational cost without solving a necessary trust problem.

## Existing BoundPay: implemented, simulated, documented

| Status | What the repository currently provides |
| --- | --- |
| **Implemented locally** | One BoundPay operator issues owner/agent-bound, Ed25519-signed Authority Passports; records revocation in SQLite; intersects passport constraints with deterministic policy; atomically claims budget and passport usage in a SQLite transaction before provider dispatch. |
| **Implemented locally** | Stable intent/order handling, provider status reconciliation, append-only application audit records, signed decision receipts, and an explicit UNKNOWN state that retains the reservation after an ambiguous provider result. A definite provider failure can release it. These are single-service behaviors, not a shared ledger. |
| **Mocked** | FIXTURE proposal mode and MOCK payments. The mock adapter is a synthetic simulation; its confirmation is not evidence of a bank transfer. |
| **Test integration / historical evidence** | A Razorpay TEST adapter and signed callback/webhook verification exist. The repository records a previous successful Razorpay TEST checkout. TEST mode is not a live-money payment. A live Sarvam proposal integration and historical evaluation are also documented; neither was invoked for this baseline. |
| **Documented only / absent** | Drunix, chaincode, network identities, an external Drunix client, multi-organization issuer trust, shared allowance state, and cross-service concurrency are not present. Existing Passport revocation and budget checks are performed by one BoundPay service. |

The current signed Passport is issued by a single BoundPay authority. A second organization cannot safely trust that token merely because it is signed: the issuer key and issuance policy must be recognized by the participating organizations. The proposed design therefore binds the Passport digest and issuer identity to an on-ledger mandate and requires each participant to verify the same signed terms. The current application does not yet provide that cross-organization trust setup.

Implementation evidence reviewed: [Passport service](../src/services/passport.service.ts), [Passport signing](../src/infrastructure/authority/signing.ts), [execution service](../src/services/execution.service.ts), [SQLite schema](../src/infrastructure/db/schema.ts), [MOCK adapter](../src/infrastructure/payment/mock-adapter.ts), and [Razorpay TEST adapter](../src/infrastructure/payment/razorpay-test-adapter.ts). Relevant tests include [Passport lifecycle](../test/unit/authority-passport.test.ts), [Passport process contention](../test/integration/authority-passport-process-contention.test.ts), [payment unknown outcomes](../test/integration/phase3-financial-regressions.test.ts), and [isolated offline verifier](../test/integration/offline-verifier-process.test.ts). Architecture and scope claims were cross-checked against [Architecture](./ARCHITECTURE.md), [Authority Passports](./AUTHORITY_PASSPORTS.md), [Threat Model](./THREAT_MODEL.md), [Passport Threat Model](./AUTHORITY_PASSPORT_THREAT_MODEL.md), [Demo Script](./DEMO_SCRIPT.md) and [Razorpay TEST evidence](./PHASE_4_RAZORPAY_TEST_VERIFICATION.md).

## Requirement-to-feature mapping

| Requirement | Existing feature | Phase 1 proposal / evidence still required |
| --- | --- | --- |
| Preserve the Razorpay evaluation build | Existing main checkout has an uncommitted evaluation/policy-latency.json edit. | Isolated local clone at /tmp/boundpay-razorpay-evaluation, branch razorpay-evaluation, preserves the same file and original HEAD. The source checkout’s .git is read-only, so this is a separate clone, not a branch written into the source checkout. |
| Verify platform and rules | No Drunix or event rulebook in the repo. | Source register and uncertainty record below. User-provided label CHL-7007 / Innovative Fintech Ideas is not independently confirmed. |
| Show two independent services sharing a cap | SQLite locks coordinate processes using one database. | Two processes with distinct MSP identities, isolated local data, one Drunix mandate and the same allowance. |
| Issue a mandate and check revocation | Single-authority Passport issue/revoke exists locally. | Record the signed Passport digest, terms, participants and ACTIVE/REVOKED state in Drunix. Reject a new reserve if revocation committed first. |
| Reserve before dispatch | Existing app reserves in SQLite before a provider call. | Commit a Drunix Reserve transaction and verify it is VALID before any provider call. Endorsement or orderer receipt is insufficient. |
| Commit success / release failure | Existing adapter reconciles payment state centrally. | Authorized verifier commits a verified outcome; release only on definitive failure. |
| Handle unknown payment outcomes | Existing app retains UNKNOWN reservations. | Keep the Drunix amount reserved; reconcile the same provider attempt and never infer failure from a timeout. |
| Protect privacy | Existing proof bundles are sanitized; credentials are environment-only. | Keep credentials and detailed purchase data off-ledger. Publish only necessary budget fields and salted commitments. |
| Reproduce and test | Existing Node/pnpm checks and Playwright demo. | Pin Drunix v1.0.0, source commit, image digests and tool versions; prove the full two-service race on a clean local network. |
| Make truthful integration claims | Existing docs distinguish MOCK and Razorpay TEST. | Label proposal, compiled chaincode, local Drunix execution, simulated payment, and any real API evidence separately. |

## Drunix capability review

Sources checked on 2026-09-26: the [official Drunix repository](https://github.com/npci/drunix), its [architecture overview](https://github.com/npci/drunix/blob/main/docs/drunix-arch.md), and the [official sample-network README](https://github.com/npci/drunix/blob/main/drunix-network/test-network/README.md). The official Go module exposes a tagged **v1.0.0**, published 2026-06-15; see [Drunix v1.0.0 module documentation](https://pkg.go.dev/github.com/npci/drunix@v1.0.0). The main-branch documentation and the v1.0.0 package page were reviewed; this checkout has not compiled or run Drunix.

| Capability | Verified from Drunix sources | Effect / limitation |
| --- | --- | --- |
| Platform | Drunix describes itself as an enhanced Hyperledger Fabric fork. Its architecture separates Lite Peers (endorsement/simulation) from Committing Peers (validation and commit), and uses a Validation Service. The Committing Peer performs MVCC validation. | Suitable to test serialized shared-state updates. It is permissioned DLT, not an EVM chain. No Ethereum compatibility is assumed. |
| Chaincode languages and deployment | The sample network lists Go, Java, JavaScript and TypeScript; its default is Go. It documents package, deploy, invoke and query through network scripts and peer commands. | Use Go for the first contract unless a pinned-version compile test supports another language. |
| Local network | Sample is two peer organizations, each with a CP, LP and VSCC server, plus a one-node Raft orderer. Default state database is Yugabyte. Prerequisites list Linux, Git, Docker, Go and jq; scripts require Bash 4. | A documented local demo path exists. It is not evidence that we have deployed Drunix, that this sample is a production topology, or that the event supplies a network. |
| Identity | Drunix exposes Fabric-style MSP APIs. Its serialized identity includes an MSP ID and X.509 certificate; the helper that creates this object explicitly does not itself validate the certificate or MSP consistency. | Bind each service to a configured organization identity. Validate identities through the actual configured MSP, never trust an MSP ID copied into request JSON. |
| Endorsement | The sample network accepts a chaincode endorsement policy flag. Architecture documents endorsement/simulation separately from order, validation and commit. | Configure a multi-organization endorsement policy for the demo and verify it on the pinned network. A local developer-controlled policy is not independent governance. |
| Commit validation | The v1.0.0 peer gateway package documents Endorse, Submit, Evaluate and CommitStatus. CommitStatus returns a transaction validation code and waits for commit or context cancellation. The architecture describes submission, ordering, validation and commit as separate stages. | Dispatch only after the transaction is confirmed VALID and the committed reservation is queryable. A submit/endorsement response is not final authorization. |
| Client integration | No supported Drunix TypeScript client SDK or external-client compatibility statement was verified. The Go gateway package is under Drunix’s internal path and documents peer-side server functions, not a public app SDK. Fabric v2.5 compatibility does not prove a particular Fabric Gateway client works against Drunix. | **Critical Phase 2 go/no-go:** compile and run evaluate/invoke/commit-status/query smoke tests using a real external client against v1.0.0. If no supported client works, use only a documented CLI bridge if it exposes enough commit validation evidence; otherwise do not dispatch payments from the demo. No SDK methods are assumed here. |
| Version and reproducibility | v1.0.0 is an available tag/module. No immutable container digest or complete tested toolchain was established during this review. | Pin source tag and resolved commit, container image digests, Go/Docker versions and generated crypto material in the eventual runbook. |

The main integration uncertainty does not invalidate the shared-state design, but it prevents claiming a working Drunix integration. A chaincode-only compile is insufficient: the selected client must obtain the transaction ID, distinguish VALID from invalid commit, query state, and recover a timed-out commit-status request without making a duplicate payment.

The proposed evidence check is network-backed: each service verifies the BoundPay issuer signature and Passport digest, queries the current mandate/reservation from its configured Drunix member, and checks the reserve transaction’s validation result is VALID. This depends on that member’s configured MSP, channel, and policy trust. A transaction ID plus CommitStatus is not a portable offline cryptographic proof by itself; an exportable proof would also need committed block data and the verification context, which is outside this phase.

## Hackathon rules and fit

The only public event material located was an [Innovation Carnival announcement](https://www.linkedin.com/posts/innovation-carnival_drunix-innovationcarnival-activity-7506253600449523712-jeWj). It describes tracks for AI & Fraud Detection, Real-Time Payments, Financial Inclusion, Cross-Border Remittances and Open Finance APIs, says the event is open to innovators, and gives registration dates of 10–30 September 2026. As of this record, registration is scheduled to close in four days.

The public announcement does **not** verify challenge code CHL-7007, the exact “Innovative Fintech Ideas” track, project reuse eligibility, team rules, judging criteria, APIs actually available to entrants, prototype requirements, later submission stages or a final submission deadline. Its promotional “work with real NPCI APIs” language is not confirmation that credentials or API access are granted. The registration short link did not expose a rulebook during this review.

**Effect:** do not claim eligibility or infer that the registration close is the prototype deadline. Before submission, verify directly with the organizer whether an existing BoundPay project may be extended and how it must be disclosed. The challenge code and primary track in this proposal remain user-supplied; Real-Time Payments is a plausible secondary fit because the demo authorizes payment dispatch, but the prototype uses a simulated external payment and is not itself a real-time payment rail.

## Prior work and evidence-bounded distinction

| Public approach | Relevant overlap | Remaining distinction for this proposal |
| --- | --- | --- |
| [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) wallet execution permissions | Wallets grant scoped execution permissions with rule types such as expiry; the specification leaves enforcement to the wallet. | Does not specify one atomic allowance shared by independent off-chain payment services. It is an Ethereum-wallet standard and is not a Drunix interface. |
| [Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/show-wallet-app) and [CDP spend permissions](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-smart-accounts/create-a-spend-permission) | Per-call/session limits and smart-account allowance permissions are existing agent-spending controls. | Wallet-centric enforcement; this proposal targets separate payment services sharing one organization-governed allowance. |
| [Stripe Issuing authorizations](https://docs.stripe.com/api/issuing/authorizations) | Central issuer decisions and spending controls protect card authorizations. | A payment issuer can provide a natural central enforcement point; the proposed DLT is useful only where separate organizations require shared evidence and control. |
| [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications) | Signed agent/consumer context and nonce/signature checks support agent identity and replay resistance at merchant interactions. | Establishes signed identity/context; it is not itself a shared aggregate budget or cross-service reservation protocol. |
| [ProofGrid shared authority budgets](https://www.theproofgrid.com/multi-agent/shared-authority-budgets/) | Public architecture guidance directly describes atomic reservations for parallel agents and retaining reservations across uncertain provider outcomes. | This is very close conceptual prior art. Its public page is architectural guidance, not evidence of an independently tested Drunix payment integration. |
| [AgentPact documentation](https://docs.agentpact.dev/) | Public product documentation describes an atomic database budget check before agent financial actions. | Shows that a centralized atomic guardrail can implement the core budget invariant without a blockchain. |

No “first” or “unique” claim is justified. The narrow contribution to test is an interoperable multi-organization enforcement adapter for BoundPay Passports that demonstrates the same aggregate cap across distinct services, with valid Drunix commit evidence and an external-payment reconciliation state machine. It is a system integration and evidence contribution, not a new shared-budget primitive.

## Trust and why Drunix might be necessary

| Centralized BoundPay database | Drunix shared state |
| --- | --- |
| One trusted service controls authorization and transaction ordering. SQLite’s existing transaction is adequate for the current one-operator app. Fewer components and lower latency/operational cost. | Participating organizations can operate separately and observe the same endorsed, validated mandate/reservation state. MVCC can reject conflicting reservations against stale shared state. Each participant can query commit evidence from its network membership. |
| All participants must trust the operator, its database integrity and its availability. | Participants must trust network membership/CA administration, channel and endorsement-policy governance, the orderer/committing peers, chaincode lifecycle, and issuer/settlement-verifier identities. DLT does not remove administrators or automatically make them independent. |

The payment outcome remains off-ledger truth. Drunix cannot prove that a bank transfer settled, stop a service that bypasses the payment gate, reverse a dispatched payment, or make a lost provider response definitive. All payment credentials stay with the payment adapter. Participants must route every covered payment through a compliant service, protect their MSP keys, and verify provider evidence before committing settlement. Network outage fails closed for new dispatch; an existing uncertain reservation remains held.

The two-organization local demo can prove distinct client identities and shared committed state under one locally operated test network. It cannot prove that those organizations are independently governed in a real deployment.

If the participants all accept one trusted operator or can use the payment issuer’s existing controls, use a centralized atomic service. Drunix earns its cost only when common authorization state and independently queryable evidence are requirements across organizational boundaries.

## Minimal proposed protocol

The following are proposed **business operations**, not Drunix SDK method names: IssueMandate, Reserve, MarkUnknown, CommitOutcome, ReleaseDefinitiveFailure, RevokeFutureAuthority, QueryMandate and QueryReservation.

### State and permissions

| Object | State / transitions | Authorized actor |
| --- | --- | --- |
| Mandate | ACTIVE → REVOKED. Revocation is prospective. | Registered issuer/owner authority creates and revokes. The network’s MSP/endorsement policy governs which organization identities are accepted. |
| Reservation | absent → RESERVED → UNKNOWN → SETTLED or RELEASED. A direct RESERVED → SETTLED/RELEASED transition is allowed if the outcome is already definitive. SETTLED and RELEASED are terminal. UNKNOWN retains the full amount. | A participant listed in the mandate may reserve and mark its own attempt UNKNOWN. Only that participant or a registered settlement verifier may finalize it; release requires verified terminal failure evidence. Members with read permission query evidence. |

Each mandate binds: random mandate ID; original Authority Passport digest and issuer key ID; issuer/owner consent record reference; participating MSP identities; INR currency; aggregate cap; per-transaction cap; allowed coarse merchant/category scope or a commitment to the full scope; current reserved and settled totals; and status. The network must trust the BoundPay Passport issuer key under an explicit consortium registration/governance process. The digest is over the original signed Passport bytes; do not reserialize an existing v1 Passport and pretend it is the same signature.

Each reservation binds a random reservation ID to one mandate, one authenticated participant identity, request ID, amount, currency, scope commitment and lifecycle. Reserve is allowed only when the mandate is ACTIVE, the caller identity is permitted, the amount is positive and within the per-transaction cap, and:

    settled + active_reserved + requested_amount <= aggregate_cap

All competing reserves read and update the same mandate budget key. Drunix MVCC must ensure a transaction simulated against stale remaining balance cannot also commit as VALID. A duplicate reservation ID with an identical payload returns the existing result; reuse with different fields is rejected. Replaying a terminal reservation cannot dispatch again.

Use separate identifiers for the mandate, user/business request, payment attempt, reservation and Drunix transaction. A reservation ID is stable across retries of the same DLT operation. A payment attempt has one stable provider idempotency key derived from its reservation ID. If the provider does not guarantee idempotency and the outcome is unknown, do not send a second create/charge request. A deliberate new payment attempt is permitted only after a definitive failure and must use a new reservation ID linked to the same user request.

### Dispatch and the external-payment gap

1. Validate the signed Passport terms and exact proposed purchase locally. Persist an immutable request and provider idempotency key in a durable local outbox.
2. Submit Reserve. Wait for the commit-status API to report a **VALID** transaction, then query the reservation and confirm that the exact mandate, identity, amount and reservation ID are committed in RESERVED state.
3. **Only this valid committed reservation plus matching state query authorizes the one provider dispatch.** Never dispatch after endorsement, simulation, orderer receipt, a timeout waiting for commit, or an invalid transaction.
4. If the provider returns an authenticated success, verify it with the existing provider verifier and submit CommitOutcome with an evidence digest. If the provider returns a definitive terminal failure, submit ReleaseDefinitiveFailure with evidence. Record the Drunix transaction ID and validation result for both.
5. Any timeout, connection loss, process crash after the send may have started, or ambiguous provider response becomes UNKNOWN. Keep the full amount reserved. Reconcile the same provider attempt using its idempotency key or provider lookup; never release on elapsed time alone. If commit-status itself times out, retain the pending outbox row and query the same Drunix transaction/reservation later.

Drunix records the shared authorization decision and the participant’s outcome attestation; unless the provider supplies a verifiable signature or a trusted settlement oracle is added, chaincode cannot independently authenticate the off-chain payment. The settlement verifier and its evidence-validation code are an explicit trust boundary.

Revocation committed before a Reserve must prevent that Reserve from becoming valid (stale read/write conflicts must be covered by tests). If Reserve commits first, that reservation remains authorized even if a later revocation commits before the service receives its commit notification. Revoke blocks future reservations; it cannot cancel or recall an already-authorized or dispatched payment. Automatic timeout-based release is prohibited.

### Privacy and canonical commitments

Make amounts, currency, aggregate balance, participant MSP, coarse authorization scope and reservation state visible only to the channel members who need them; those fields are required for shared enforcement. Use Drunix private data collections for more sensitive shared scope only after the exact v1.0.0 network behavior has been tested. The first demo should keep the product SKU, description, full cart, personal data, address, raw provider response/reference, bank/card data, API tokens, private keys and credentials off-ledger and out of chaincode logs.

Define a new schema version using [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) for newly issued mandate and purchase-scope objects. Use integer paise only, uppercase currency codes, restricted ASCII IDs, explicit schema version, UTC timestamps with fixed millisecond precision, NFC-normalized text, and deterministically sorted unique arrays; reject floats and duplicate keys. Do not change the byte representation of existing signed Passport tokens.

For a scope or evidence commitment, define the preimage exactly as ASCII("boundpay:commit:v1:") || UTF8(type) || 0x00 || salt[32] || JCS(payload), then compute SHA-256. Keep the cryptographically random 32-byte salt off-ledger and encrypted for authorized verification. An unsalted hash of a predictable product, amount or merchant is vulnerable to dictionary guessing; salted commitments prevent that attack while the salt remains secret. Never put credentials in a commitment.

## Local reproducible demo plan

1. Clone the official Drunix source at v1.0.0 and record the resolved Git commit and Docker image digests. Record Linux, Docker, Go, jq, Bash, Node and pnpm versions. From the official test-network directory, use the documented command sequence:

       ./network.sh prereq
       ./network.sh up createChannel -c boundpay

2. Build and deploy the Go contract with the documented network command shape:

       ./network.sh deployCC -ccn boundpay -ccp CONTRACT_SOURCE_PATH -ccl go -ccep ENDORSEMENT_POLICY

   Record the exact contract path, policy and channel membership. No external payment keys or NPCI/Citi credentials are used.
3. Start two separately configured service processes with different organization identities and separate local outboxes/databases; do not share administrator credentials. Create one test mandate with INR 5,000 (500,000 paise).
4. Race Service A and Service B, each reserving INR 3,000 (300,000 paise), from the same starting balance. Exactly one reservation may become VALID and trigger a mock dispatch. The other must fail validation or, after a fresh query/retry, be denied because INR 2,000 remains. A request for exactly the remaining INR 2,000 may then reserve; a request for any positive amount above the remaining balance must be denied.
5. Re-run from a clean state with a forced mock timeout after dispatch. Show UNKNOWN, no second payment call, unchanged reserved capacity after process restart, and resolution only after reconciliation. Revoke the mandate and show that future reserves fail while the existing reservation is retained.

All payment results in this local exercise must be labeled SYNTHETIC / MOCK. A clean runbook must distinguish documented Drunix commands from commands actually verified against the pinned release. The current BoundPay README documents Node/pnpm setup and checks; the Drunix commands above remain proposed until executed.

## Threat model and mitigations

| Threat | Required behavior |
| --- | --- |
| Two services read the same balance and race | A shared budget-key read/write creates an MVCC conflict. Only a valid committed reservation can dispatch; retry re-reads state and re-evaluates the cap. |
| Replay or changed payload under a prior ID | Stable IDs and canonical payload digest; identical retry is idempotent, changed payload and terminal replay are rejected. |
| Revoked Passport or unauthorized organization | Reserve checks current mandate status and authenticated MSP identity; no cached revocation answer authorizes a payment. |
| Drunix/orderer/client timeout | Do not treat missing response as no commit. Query the original transaction and reservation; do not issue another provider call while outcome is uncertain. |
| Provider timeout after possibly accepting payment | Keep reservation UNKNOWN; query provider using the same idempotency key. Never free by timeout. |
| Fake success/failure report | Only registered verifier identity can settle/release; verify provider signature/HMAC and authoritative status off-chain before recording evidence. A verifier compromise remains a trust risk. |
| Participant bypasses BoundPay | Outside Drunix’s control. Restrict provider credentials and access so covered payments can only pass through the enforcing adapter; demo assumptions must say so. |
| Budget/scope privacy leak | Minimize public fields; use membership/private data where tested; keep payment payload and credentials off chain; use salted commitments. Amounts required for shared enforcement are visible to authorized ledger members. |
| Malicious or unavailable network governance | Pin chaincode and endorsement policy; document organization administrators and orderer trust. Network failure blocks new dispatch but does not release existing holds. |
| Clock skew / Passport expiry | Do not let client wall clocks decide shared expiry. The available reviewed docs did not establish a trusted deterministic expiry mechanism. Verify ledger-time/height support before enforcing expiry on-chain; until then, do not claim distributed expiry enforcement. |

## Implementation plan (future phases; not performed here)

1. **Phase 1 — feasibility and design (this change):** source and rule review, state machine, threat model, implementation boundaries and acceptance checklist.
2. **Phase 2 — Drunix spike:** pin v1.0.0, compile a small Go contract, configure identity and multi-organization endorsement, and prove two external clients can query VALID commit status and state. Resolve the client SDK/CLI and deterministic expiry questions before exposing payment dispatch.
3. **Phase 3 — shared mandate and reservation:** add versioned contract state and separate service processes; prove MVCC race, idempotency, revocation order and evidence queries without payment calls.
4. **Phase 4 — payment adapter and recovery:** add a durable outbox, MOCK-only dispatch, verified outcome/release and restart-safe UNKNOWN reconciliation. Only later consider a separately authorized payment TEST adapter.
5. **Submission readiness:** check official reuse and submission rules, then record an exact clean-build/demo transcript and evidence. Do not imply NPCI/Citi affiliation, real payment-rail access or event eligibility without confirmation.

## Acceptance checklist for implementation

- [ ] A clean, pinned Drunix v1.0.0 setup compiles and runs from documented commands; source commit, image digests, prerequisites and versions are recorded.
- [ ] The contract compiles for the selected documented language. The selected external client obtains transaction IDs, distinguishes VALID from invalid commit, queries current state and recovers commit-status timeouts. No unverified SDK method is called.
- [ ] Two separately run services use distinct registered MSP identities and independent local databases/outboxes; neither relies on a shared BoundPay SQLite lock.
- [ ] In the INR 5,000 / concurrent INR 3,000 scenario, accepted active reservations plus settled spend never exceed the mandate. At most one first-wave reservation is valid; the loser does not dispatch. A later INR 2,000 request succeeds and an over-limit request fails.
- [ ] Measure reserve submission-to-VALID-commit latency under the two-service race and report the observed distribution and environment. Do not infer real-time payment performance from a local test network.
- [ ] A dispatch counter proves zero provider calls before a valid committed reservation and exactly one call per payment attempt after it.
- [ ] Duplicate same-payload reserve is idempotent; changed-payload ID reuse, unauthorized MSP, stale revocation, and terminal replay are rejected.
- [ ] Revoke-before-reserve rejects; reserve-before-revoke remains held and may complete; revocation prevents subsequent reserves and is never presented as canceling a dispatched payment.
- [ ] Provider success settles only after verified evidence; definitive failure releases only after verified terminal evidence; timeout remains UNKNOWN across restart, keeps the full reservation and causes no retry dispatch until reconciled.
- [ ] Queryable evidence includes Passport digest, mandate/reservation IDs, participant, amount/currency, transaction IDs, validation codes, transitions and outcome commitment. It does not claim that a ledger commit independently proves bank settlement.
- [ ] Ledger state, events, logs and public artifacts contain no credentials, raw provider payloads, product/cart details or personal purchase data. Tests demonstrate that predictable low-entropy fields are not protected by unsalted hashes.
- [ ] The local demo labels mock payment results and local network governance clearly. Any NPCI/Citi API use, actual payment, event eligibility and real-world multi-organization deployment have separate evidence.
- [ ] Existing BoundPay baseline remains intact and passes the recorded checks, with known failures/flakes explicitly tracked.

## Phase 1 baseline record

The existing evaluation data was preserved. The source checkout remains on main with its pre-existing modified evaluation/policy-latency.json. Because .git is read-only in this environment, an isolated clone at /tmp/boundpay-razorpay-evaluation on its local razorpay-evaluation branch retains the same file and the original source HEAD. The evaluation artifact was not regenerated.

| Check run on 2026-09-26 | Actual result |
| --- | --- |
| pnpm run typecheck | Passed, exit 0. |
| pnpm run lint | Passed with zero warnings/errors; Next reports that next lint is deprecated for its future major version. |
| pnpm test | Full suite passed: 29 test files, 338 tests, exit 0. Vite emitted a native config-loader warning. |
| pnpm exec vitest run test/integration/offline-verifier-process.test.ts | Failed in an isolated run. Its tamper test changes the final base64url character of an Ed25519 signature; for some replacements only unused padding bits change, so decoding yields the original signature bytes. The verifier accepts the same cryptographic signature, not a forged one. The changed token text is a noncanonical-encoding concern; the test should mutate a meaningful signature bit or signed payload and separately check canonical encoding in a later test-fix phase. |
| pnpm run build | Passed with Next.js 15.5.21. |
| pnpm run test:e2e | Passed after the required production build: 18/18 Chromium scenarios, exit 0, fixture and MOCK modes. The command resets only its documented /tmp/boundpay-e2e.sqlite database. |
| pnpm run security:public-artifacts | Passed: scanned 94 public artifacts; the script reported NOT_FOUND for each of its five credential checks. The scan only checks configured values supplied through its environment/local-env inputs, so this result alone does not prove that an unconfigured secret is absent. |
| pnpm run authority:validate | Failed because the current AUTHORITY_SIGNING_KEY_ID value/configuration did not satisfy the validator’s required safe-identifier check. No signing key was displayed. |

The full Vitest suite passing does not erase the isolated tamper-test failure. The live model, Razorpay TEST provider, dependency audit, latency evaluation and Drunix network were not run for this Phase 1 record. In particular, the latency evaluation was not regenerated because it would overwrite the pre-existing evaluation artifact.

## Source register

- Drunix repository and v1.0.0 Go module: [GitHub source](https://github.com/npci/drunix), [tagged module docs](https://pkg.go.dev/github.com/npci/drunix@v1.0.0).
- Drunix architecture: [official architecture overview](https://github.com/npci/drunix/blob/main/docs/drunix-arch.md).
- Drunix network, identities, chaincode languages and deployment commands: [official sample-network README](https://github.com/npci/drunix/blob/main/drunix-network/test-network/README.md).
- Drunix peer Gateway operations and commit validation: [v1.0.0 gateway package](https://pkg.go.dev/github.com/npci/drunix@v1.0.0/internal/pkg/gateway); [MSP package](https://pkg.go.dev/github.com/npci/drunix@v1.0.0/msp).
- Public hackathon tracks and registration window: [Innovation Carnival announcement](https://www.linkedin.com/posts/innovation-carnival_drunix-innovationcarnival-activity-7506253600449523712-jeWj). No public rulebook or CHL-7007 page was verified.
- Canonical JSON: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).
- Prior work: [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715), [Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/show-wallet-app), [CDP spend permission API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-smart-accounts/create-a-spend-permission), [Stripe Issuing authorizations](https://docs.stripe.com/api/issuing/authorizations), [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications), [ProofGrid shared authority budgets](https://www.theproofgrid.com/multi-agent/shared-authority-budgets/), and [AgentPact documentation](https://docs.agentpact.dev/).
