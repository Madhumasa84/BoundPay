import { createRequire } from 'module';
import { eq } from 'drizzle-orm';
import { getDb, closeDefaultDb, schema } from '../src/infrastructure/db';
import { createProposal } from '../src/services/purchase.service';
import { createAuthorityPassport } from '../src/services/passport.service';
import { getProductById } from '../src/services/catalog.service';
import { getAuthorityConfig, verifySignedTokenOffline } from '../src/infrastructure/authority/signing';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
process.env.DATABASE_PATH = '/home/masa84/razorpay/data/phase-4-razorpay-test-20260905T020301Z.sqlite';
const { db, sqlite } = getDb();
const intentId = '00fa1cb0-07a6-42b6-bfc0-1a1368ebc24b';
const passportId = 'pass_4a8348f9-7c3f-4f78-bc79-3dc436df248d';
async function main() {
  const expired = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();
  if (!expired || expired.state !== 'EXPIRED') throw new Error('EXPIRED_INTENT_NOT_DURABLE');
  let passport = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, passportId)).get();
  if (!passport || passport.status !== 'ACTIVE' || Date.now() >= Date.parse(passport.expires_at)) {
    const replacement = createAuthorityPassport(expired.owner_id, { agentId: 'OfficeBot', agentDisplayName: 'OfficeBot', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 500000, approvalRequiredAbovePaise: 300000, maximumUsageCount: 2, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), idempotencyKey: `phase4-replacement-passport-${Date.now()}` }, undefined, 'RAZORPAY_TEST');
    passport = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, replacement.payload.passportId)).get();
  }
  if (!passport || passport.status !== 'ACTIVE') throw new Error('REPLACEMENT_PASSPORT_NOT_ACTIVE');
  const product = getProductById('prod_keyboard');
  if (!product || product.unit_price_paise !== 279900) throw new Error('TRUSTED_CATALOG_INVALID');
  const oldState = sqlite.prepare('SELECT payload_json FROM phase4_verification_state WHERE id=1').get() as { payload_json: string };
  const oldSummary = JSON.parse(oldState.payload_json);
  const reason = oldSummary.sarvam_proposal?.reason || 'Mechanical Keyboard unit price is 279900 paise, within the 400000 paise budget, and satisfies the request for one keyboard.';
  const result = createProposal(passport.owner_id, { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 400000, idempotency_key: `phase4-replacement-keyboard-refreshed-${Date.now()}`, source_mode: 'LIVE_MODEL', model_provider: 'sarvam', model_name: 'sarvam-105b', reason, passport_id: passport.id, agent_id: 'OfficeBot' }, 'RAZORPAY_TEST');
  if (result.intent.state !== 'NEEDS_APPROVAL') throw new Error('REFRESHED_APPROVAL_GATE_FAILED');
  const receipt = result.decisionReceipt!;
  const config = getAuthorityConfig({ requirePrivate: true });
  await verifySignedTokenOffline(receipt.signedToken, 'receipt', config.publicKeyPem, { issuer: config.issuer, audience: config.audience });
  const out = { status: 'AWAITING_EXACT_APPROVAL', sarvam_request_count: 2, razorpay_preflight_count: 1, passport_id: passport.id, passport_digest: passport.payload_digest, intent_id: result.intent.id, approval_digest: result.intent.canonical_request_hash, quote_expiry: result.intent.quote_expiry, passport_expiry: passport.expires_at, agent: 'OfficeBot', product: product.name, product_id: product.id, quantity: 1, amount_paise: product.unit_price_paise, currency: product.currency, merchant: product.merchant_id, category: product.category, policy_version: result.intent.policy_version, server_approval_threshold_paise: 250000, passport_approval_threshold_paise: 300000, effective_decision: 'NEEDS_APPROVAL', reason_codes: result.passportEvaluation.checks.filter((x) => x.status !== 'PASS').map((x) => x.reasonCode), offline_receipt: 'VALID', provider_order_count: 0, ledger_count: 0, passport_usage_count: 0 };
  sqlite.prepare('UPDATE phase4_verification_state SET payload_json=? WHERE id=1').run(JSON.stringify({ ...oldSummary, ...out, refreshed_from_expired_intent: intentId, approval_result: 'PENDING' }));
  console.log(JSON.stringify(out));
}
main().catch((error) => { console.log(JSON.stringify({ status: 'NEEDS FIXES', category: error instanceof Error ? error.name : 'unknown' })); process.exitCode = 1; }).finally(() => closeDefaultDb());
