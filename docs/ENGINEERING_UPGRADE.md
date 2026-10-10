# Engineering upgrade

Purchasing services now request an independent outcome verifier over authenticated HTTP. Each purchasing process loads its participant certificate and key only. The verifier loads its own certificate and key, independently reads the provider, checks the intent/reservation/payment-attempt binding and exact amount, currency, order, payment and mode, then submits the outcome. The purchasing service reads the ledger under its participant identity before it accepts that outcome. Missing evidence, missing credentials, a refused request, or mismatched readback retains the hold.

For MOCK runs, a separate provider process persists orders and capture evidence in SQLite. Dispatch and read credentials must differ; the verifier receives only the read credential. Provider evidence survives a provider restart. Receipt reuse with changed purchase terms is refused, captured payments remain captured on retry, and failed synthetic orders are terminal. This is synthetic payment evidence, without a bank or external payment-provider call.

Existing deployments must provision the verifier service; the application no longer signs outcomes with an embedded verifier key. See `.env.example` for the added variables. Use separate process environments: put `DRUNIX_CLIENT_*` in purchasing services and `DRUNIX_VERIFIER_CLIENT_*` in the verifier. Give the verifier `MOCK_PROVIDER_READ_TOKEN`, and purchasing services `MOCK_PROVIDER_TOKEN`. Both tokens go in the provider environment. All HTTP tokens require at least 32 non-whitespace characters. HTTPS is required outside loopback. The verifier requires an explicit `PAYMENT_ADAPTER_MODE` and checks its configuration before reporting readiness. For Razorpay TEST it independently looks up the exact receipt and captured payment; a failed Razorpay payment alone does not authorize release of the order hold.

## Persistent setup

The setup command clones Drunix v1.0.0 at commit `3fb2b135a5b2adf7e1071d9b1624052a1bbb1772` into `.drunix/source`, pins the sample images and local clock override, and compiles matching CLI tools from its vendored source in a pinned Go 1.26.1 container. Chaincode still uses the separately pinned Go 1.23 container. Preparation does not start or tear down a network.

```bash
pnpm run shared-authority:prepare
BOUNDPAY_DIR="$(pwd)"
cd .drunix/source/drunix-network/test-network
PATH="$BOUNDPAY_DIR/scripts/drunix-toolchain:$PATH" ./network.sh up createChannel -c boundpay
PATH="$BOUNDPAY_DIR/scripts/drunix-toolchain:$PATH" ./network.sh deployCC -c boundpay -ccn boundpay-shared-authority -ccp "$BOUNDPAY_DIR/contracts/shared-authority/chaincode" -ccl go -ccv 1.2 -ccs 1 -ccep "AND('Org1MSP.member','Org2MSP.member')" -cccg "$BOUNDPAY_DIR/contracts/shared-authority/collections_config.json"
cd "$BOUNDPAY_DIR"
pnpm run build
pnpm run shared-authority:drunix-app-demo
```

The startup/deployment block assumes a fresh dedicated sample-network host and channel. Inspect existing containers before startup: the official sample uses fixed container names and its cleanup routines can affect other sample networks. For an existing chaincode definition, choose the next lifecycle sequence. `DRUNIX_TEST_NETWORK_HOME` overrides the persistent default if using an existing prepared network. The historical Phase 2 runbook describes an older temporary-directory setup and earlier verifier arrangement.

## Retained evidence

The app demo launches two purchasing services, a separate verifier, and a durable MOCK provider. It retains role configuration files with permissions `0600`, keys, databases, measurements and `report.json` under `.boundpay-runs/`. Both `.drunix/` and `.boundpay-runs/` are ignored by Git. Role configuration files contain local secrets; keep them private. It asserts that the losing purchase made no provider call and that an uncertain attempt was dispatched once. Existing checks cover competing purchases, lost local acknowledgement, service restart, unknown holds and a pre-dispatch ledger outage.

```bash
DRUNIX_DEMO_RUNS=10 pnpm run shared-authority:verify-repeatability
```

The repeatability runner uses a fresh mandate and isolated application databases per run, alternates timeout and response-loss faults, stops on any failed assertion, and saves per-run evidence plus p50/p95/max latency for each HTTP route. These measurements include application and network overhead; they are not isolated consensus benchmarks. No successful repeatability result is claimed until this command completes on a running network.

## Verification and limits

New tests exercise verifier evidence rejection, role-specific credential loading, independent purchasing-service ledger readback, real provider process restart and credential restrictions. Go tests exercise actual contract methods for one-time dispatch, unknown holds, settlement/release idempotency, exact identity authorization and prospective revocation. The Go fixture does not simulate MVCC or endorsement; those properties require the real network checks. Local process separation does not establish OS isolation or independently operated organizations.

The upgrade was checked with the full application suite, Chromium scenarios, production build, TypeScript, lint, and Go race/static checks. Exact counts and commands are retained in `evaluation/engineering-upgrade-2026-10-10.json`. A fresh ledger-backed app demo, ten-run ledger measurement, live model evaluation and Razorpay provider verification remain unexecuted for this upgrade.
