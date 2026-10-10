# Verification and defect repairs — 2 October 2026

The repaired application passes 430 automated tests, including 27 new regression cases. Live Sarvam passed the unchanged 20-case manifest. Razorpay TEST verification remains **blocked** by HTTP 401, as requested; no payment order was created.

## Repairs

- Made the passport verification test use its fixed reference clock. Production expiry enforcement remains in place.
- Extended Sarvam's timeout through response-body reading, preserved UTF-8 characters across chunks, and bounded rate-limit retry delays.
- Redacted configured API credentials echoed in provider errors, successful reasons, and response-model metadata.
- Used a monotonic clock for latency after a live request recorded negative elapsed time during a wall-clock correction.
- Increased the Sarvam completion budget from 2,048 to 4,096 tokens with explicit low reasoning. Clarified repeated quantities and partial selection from requests for multiple products, and supplied computed affordable quantities. Reasoning consumes completion tokens according to the [Sarvam model documentation](https://docs.sarvam.ai/api/getting-started/models/sarvam-105b).
- Assigned the revised prompt `phase2-untrusted-catalog-v2`, owned by the provider; reports include its actual generation settings.
- Made failed live evaluations return exit code 1 while retaining their reports. Failures include incomplete responses, unmet shopping constraints, unknown case IDs, gate errors, and incorrect enforcement. Expected policy violations and approval requirements are computed from trusted inputs before observing the gate result.
- Repaired Drunix preparation to compare literal YAML values, install both clock overrides, pin the Docker overlay as well as the base compose file, reject unexpected references, and remain idempotent.
- Upgraded gRPC to 1.14.5 and patched vulnerable development dependencies. Overrides keep brace-expansion at patched versions within its existing majors, glob within major 10, and upgrade the old esbuild dependency used by the legacy loader. The full audit is clean.

The regressions were observed failing before their corresponding code repairs. Independent review also reproduced missing policy enforcement and credential echoes before those fixes, and found no remaining material issues afterward.

## Verification evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest suite | 430/430; 36 files | `/tmp/boundpay-defects-tests-complete.log` |
| Browser scenarios | 18/18, mock payments | `/tmp/boundpay-defects-e2e-verified.log` |
| Process contention stress | 7/7; 25 rounds | `/tmp/boundpay-defects-stress.log` |
| Lint and TypeScript | Passed | `/tmp/boundpay-defects-lint-complete.log`, `/tmp/boundpay-defects-types-complete.log` |
| Production build | Passed with patched dependencies | `/tmp/boundpay-defects-build-complete.log` |
| All dependency audit | Zero advisories | `/tmp/boundpay-defects-audit-all-verified.json` |
| Frozen offline installation | Passed | `/tmp/boundpay-defects-install-complete.log` |
| Drizzle schema export | Passed | `/tmp/boundpay-defects-drizzle-export.sql` |
| Legacy TypeScript loader | Patched esbuild transforms TypeScript | Independent review smoke check |
| Authority configuration | Valid | `/tmp/boundpay-defects-authority.log` |
| Public artifact secret scan | 104 files; configured secrets absent | `/tmp/boundpay-defects-artifacts.log` |
| Preparation against untouched pinned Drunix files | Four files; twice; byte-identical second result | `/tmp/boundpay-defects-prepare-real.log` |
| Live Sarvam | 20/20 complete and request-satisfied; two policy violations blocked; zero gate errors/mismatches or payment calls | [Retained live results](../evaluation/live-model-results-2026-10-02.json) |
| Actual Drunix ledger | 14 contract + 15 two-service timeout + 15 two-service response-loss checks | [Retained ledger results](../evaluation/drunix-verification-2026-10-02.json) |
| Go chaincode race tests and vet | Passed during the initial complete test run; Go source unchanged by repairs | `/tmp/boundpay-complete-chaincode.log`, `/tmp/boundpay-complete-go-vet.log` |
| Required JEV assessment | High risk; security sensitivity 0.900; addressed through review and enforcement/credential regressions | `/tmp/boundpay-defects-jev-complete.log` |

Final live Sarvam usage was 37,449 tokens, with median latency 8,097 ms and p95 20,769 ms. Earlier experimental runs with reasoning disabled satisfied 17/20 and 18/20 requests; those failed runs were retained under `/tmp/boundpay-defects-live/evaluation/` and were not treated as successes. The final run restored low reasoning and passed all 20 cases.

## Remaining limits and blocked checks

Razorpay rejected the configured TEST credentials with HTTP 401. Live order creation, readback, and reconciliation are blocked; the user's instruction to record that block was preserved, with no further attempts during repairs.

The actual Drunix checks use channel `boundpay-final` in the isolated `boundpaycomplete` Docker project, with mock payment adapters. They prove ledger behavior, not a bank settlement. Both sample services can access the demo verifier certificate, so verifier governance is not independent. The existing local test network uses a five-second Yugabyte clock-skew tolerance to accommodate the host; the preparation helper's separately verified default is 1.5 seconds. Test containers were stopped afterward and their data preserved.

Go coverage in the initial race run was 14.3%; passing the suites does not imply every code path was exercised. Live model results describe the observed run and remain nondeterministic. Sandbox socket, subprocess, and network failures were rerun with the necessary permissions and distinguished from application defects.
