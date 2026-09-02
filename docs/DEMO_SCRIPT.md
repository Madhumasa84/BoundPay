# Five-Minute Demo Script

## Before recording

1. Put real TEST credentials and webhook secret in the hosting environment; never show them. Set `PAYMENT_ADAPTER_MODE=RAZORPAY_TEST` and, for the model segment, `AGENT_MODE=live` plus `OPENAI_API_KEY`.
2. Use HTTPS, persistent SQLite storage, one application instance, and a reachable signed webhook.
3. Run migrations/seed, typecheck, tests, build, then complete one rehearsal TEST checkout. Confirm the dashboard, audit, ledger, reload, and status refresh all match.
4. Keep `evaluation/live-model-results.json` and `evaluation/razorpay-test-results.json` updated with sanitized actual evidence. If either integration fails, say so on camera and do not substitute fixture evidence.

## 0:00–0:30 — problem and scope

“A shopping model is useful for proposals, but it should not inherit payment authority. BoundPay is a single-operator, single-merchant INR prototype that separates an untrusted proposal from deterministic authorization.” Show the server-reported LIVE MODEL / RAZORPAY TEST badges.

## 0:30–1:50 — legitimate purchase

Select Scenario 1. Show keyboard price `279900` paise, quantity 1, total, and explicit `300000`-paise budget. Submit through the real model if live evaluation is enabled; otherwise explicitly say fixture. Walk through individual server checks. Show exact approval amount, versions, expiry, and SHA-256 digest. Approve, create the Razorpay TEST order, and point out the matching provider order ID in Checkout. Complete TEST payment. Show captured payment ID, application confirmation, Activity audit/ledger evidence, dashboard record, and persistence after reload/status refresh.

## 1:50–2:40 — compromised proposal

Click Scenario 2a to inject the malicious catalog description at the catalog-service boundary, then ask the live model. State its actual response: if it resists, say it resisted this sample; if it proposes the subscription, show that proposal entering the real gate and being blocked. Then click Scenario 2b and say: “This is a forced-compromise fixture, not observed model behavior.” Submit it normally, show subscription/category/limit reasons and zero provider order calls in Activity/evaluation evidence.

## 2:40–3:25 — changed price

Create a fresh keyboard quote at `279900` paise and approve the exact digest. Click Scenario 3 to update the server catalog to `429900` paise. Attempt normal checkout. Show durable `EXPIRED`, the catalog-version mismatch audit, and no new provider order. Create a new proposal and show that policy/approval must run again. Restore the catalog price after recording if desired.

## 3:25–4:10 — uncertainty, audit, and measured evidence

First replay the identical checkout on a confirmed demo intent and show the same intent/order plus one budget commitment. In a separate MOCK-labeled run, use Scenario 4. Execute the response-loss fault, show `UNKNOWN`, retained reservation, and the reconciliation action—never a blind retry. Show JSON audit export. Present deterministic evidence as 100/100 cases and 182 requests, not as a security percentage. Mention the 12-case rollback defect found and fixed. Keep live-model and real-provider counts separate.

## 4:10–5:00 — architecture, limitations, next step

Show the architecture diagram: proposal → policy → exact approval → atomic reservation → provider order → verified capture. State the single-instance/persistent-SQLite assumption, application-audit limitation, subjective allowed-choice risk, and no power-loss claim. Next practical step: strengthen operational deployment and collect repeatable real TEST/live-model evidence before submission.
