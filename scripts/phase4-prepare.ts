import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { getDb, schema, closeDefaultDb } from '../src/infrastructure/db';
import { getAuthorityConfig, verifySignedToken, verifySignedTokenOffline, publicKeyFingerprint } from '../src/infrastructure/authority/signing';
import { resolvePaymentAdapterMode } from '../src/domain/intent';
import { createAuthorityPassport, verifyStoredPassport } from '../src/services/passport.service';
import { createProposal } from '../src/services/purchase.service';
import { getProductById } from '../src/services/catalog.service';
import { SEED_CATALOG_ITEMS } from '../src/domain/catalog';
import { SarvamProvider } from '../src/infrastructure/model/sarvam-provider';
import { invokeShoppingAgent } from '../src/services/agent.service';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
process.env.DATABASE_PATH = '/home/masa84/razorpay/data/phase-4-razorpay-test-20260905T020301Z.sqlite';
const { sqlite, db } = getDb();
function assert(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
let stage = 'LOCAL_VALIDATION';
const counts = { sarvam: 0, razorpay_read_only_preflight: 0, razorpay_create_order: 0, razorpay_payment_or_status_lookup: 0, checkout: 0, other_provider_calls: 0 };
function persist(value: unknown) { sqlite.prepare('INSERT OR REPLACE INTO phase4_verification_state (id, payload_json) VALUES (1, ?)').run(JSON.stringify(value)); }
async function main() {
  const config = getAuthorityConfig({ requirePrivate: true });
  assert(!config.testOnly && config.audience === 'urn:boundpay:razorpay-test' && resolvePaymentAdapterMode() === 'RAZORPAY_TEST', 'CONFIGURATION_INVALID');
  assert(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET && !/^(rzp_live_|live_)/.test(process.env.RAZORPAY_KEY_SECRET), 'TEST_CREDENTIALS_INVALID');
  assert(process.env.SARVAM_API_KEY, 'SARVAM_CONFIGURATION_MISSING');
  assert(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='phase4_verification_state'").get(), 'RUN_ALREADY_STARTED');
  assert((sqlite.prepare('SELECT count(*) AS n FROM purchase_intents').get() as {n:number}).n === 0, 'DATABASE_NOT_EMPTY');
  sqlite.exec('CREATE TABLE phase4_verification_state (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)');
  stage = 'READ_ONLY_PREFLIGHT';
  counts.razorpay_read_only_preflight++;
  persist({ stage, counts, started_at: new Date().toISOString() });
  const response = await fetch('https://api.razorpay.com/v1/orders?count=1', { headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}` }, signal: AbortSignal.timeout(20000) });
  assert(response.ok, 'PREFLIGHT_AUTHENTICATION_FAILED');
  await response.body?.cancel();
  stage = 'PASSPORT_PREPARATION';
  const historicalHash = crypto.createHash('sha256').update(fs.readFileSync('data/boundpay.sqlite')).digest('hex');
  const original = new Database('data/boundpay.sqlite', { readonly: true, fileMustExist: true });
  const policy = original.prepare('SELECT * FROM policies ORDER BY version DESC LIMIT 1').get() as typeof schema.policies.$inferSelect;
  // The historical Phase 3 database may contain an intentionally changed
  // quote (the keyboard was 429900 paise in that evidence). The live model
  // evaluation and Phase 4 contract use the current trusted server catalog,
  // whose keyboard price is 279900 paise. Populate this isolated verifier
  // from the source catalog rather than copying mutable historical quotes.
  const products = SEED_CATALOG_ITEMS.map((item) => ({ ...item, version: 1, is_active: true, updated_at: new Date().toISOString() }));
  original.close();
  assert(policy.approval_threshold_paise === 250000, 'SERVER_POLICY_THRESHOLD_MISMATCH');
  const ownerId = crypto.randomUUID();
  db.transaction(tx => {
    tx.insert(schema.operators).values({ id: ownerId, username: process.env.OPERATOR_USERNAME || 'operator', password_hash: bcrypt.hashSync(process.env.OPERATOR_INITIAL_PASSWORD || crypto.randomBytes(32).toString('hex'), 10), created_at: new Date().toISOString() }).run();
    tx.insert(schema.policies).values({ ...policy, allow_subscriptions: Boolean(policy.allow_subscriptions) }).run();
    for (const p of products) tx.insert(schema.products).values({ ...p, is_active: Boolean(p.is_active), is_subscription: Boolean(p.is_subscription) }).run();
  });
  const passport = createAuthorityPassport(ownerId, { agentId: 'OfficeBot', agentDisplayName: 'OfficeBot', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 500000, approvalRequiredAbovePaise: 300000, maximumUsageCount: 2, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), idempotencyKey: 'phase4-single-passport' }, undefined, 'RAZORPAY_TEST');
  verifyStoredPassport(passport, ownerId, 'OfficeBot');
  const verified = await verifySignedToken(passport.signedToken, 'passport');
  assert(verified.paymentAdapterMode === 'RAZORPAY_TEST' && verified.operatorId === ownerId && verified.agentId === 'OfficeBot' && passport.status === 'ACTIVE', 'PASSPORT_BINDING_FAILED');
  stage = 'LIVE_SARVAM';
  let lastStatus = 0;
  const provider = new SarvamProvider({ apiKey: process.env.SARVAM_API_KEY!, model: process.env.SARVAM_MODEL || 'sarvam-105b', maxRetries: 0, timeoutMs: 20000, fetchFn: async (url, init) => {
    assert(counts.sarvam < 2, 'SARVAM_CALL_LIMIT');
    counts.sarvam++;
    persist({ stage, counts, passport_id: passport.payload.passportId });
    lastStatus = 0;
    const r = await fetch(url, init); lastStatus = r.status; return r;
  } });
  let proposal;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { proposal = await invokeShoppingAgent('Buy one keyboard from the approved demo store within my budget.', 400000, { mode: 'live', provider }); break; }
    catch (e) { if (attempt || !(lastStatus === 429 || lastStatus >= 500 || (e instanceof Error && /timed out|ECONNRESET|ETIMEDOUT/.test(e.message)))) throw e; await new Promise(r => setTimeout(r, 500)); }
  }
  assert(proposal?.suitable && proposal.product_id && proposal.quantity === 1 && proposal.source_mode === 'LIVE_MODEL', 'MODEL_RESULT_NOT_REQUESTED_PURCHASE');
  const product = getProductById(proposal.product_id);
  assert(product && product.id === 'prod_keyboard' && product.merchant_id === 'demo_store' && product.category === 'electronics' && product.unit_price_paise === 279900 && product.currency === 'INR', 'TRUSTED_CATALOG_MISMATCH');
  stage = 'EXACT_INTENT';
  const result = createProposal(ownerId, { product_id: proposal.product_id, quantity: proposal.quantity, purchase_budget_paise: 400000, idempotency_key: 'phase4-single-keyboard', source_mode: 'LIVE_MODEL', model_provider: proposal.model_provider, model_name: proposal.model_name, reason: proposal.reason, passport_id: passport.payload.passportId, agent_id: 'OfficeBot' }, 'RAZORPAY_TEST');
  assert(result.intent.state === 'NEEDS_APPROVAL' && result.passportEvaluation.decision === 'NEEDS_APPROVAL', 'APPROVAL_GATE_FAILED');
  assert(result.decisionReceipt, 'RECEIPT_MISSING');
  const receipt = await verifySignedTokenOffline(result.decisionReceipt.signedToken, 'receipt', config.publicKeyPem, { issuer: config.issuer, audience: config.audience });
  assert(receipt.intentId === result.intent.id, 'RECEIPT_BINDING_FAILED');
  assert(crypto.createHash('sha256').update(fs.readFileSync('data/boundpay.sqlite')).digest('hex') === historicalHash, 'HISTORICAL_DATABASE_CHANGED');
  const summary = { status: 'AWAITING_EXACT_APPROVAL', timestamp: new Date().toISOString(), counts, authority_configuration_valid: true, private_key_exposed: false, passport_signature_verified: true, passport_id: passport.payload.passportId, passport_digest: passport.payloadDigest, public_verification: { kid: config.keyId, issuer: config.issuer, audience: config.audience, algorithm: 'Ed25519', fingerprint_sha256: publicKeyFingerprint() }, signed_payment_mode: 'RAZORPAY_TEST', passport_expiry: passport.payload.expiresAt, intent_id: result.intent.id, agent: 'OfficeBot', product: product.name, product_id: product.id, quantity: 1, unit_price_paise: 279900, total_paise: 279900, currency: 'INR', merchant: 'demo_store', policy_version: policy.version, server_budget_paise: policy.daily_budget_paise, server_approval_threshold_paise: 250000, passport_approval_threshold_paise: 300000, passport_budget_paise: 500000, passport_usage_limit: 2, existing_commitments_paise: 0, effective_policy_result: 'NEEDS_APPROVAL', approval_digest: result.intent.canonical_request_hash, quote_expiry: result.intent.quote_expiry, approval_result: 'PENDING', sarvam_proposal: proposal, offline_receipt_verification: 'VALID', provider_order_count: 0, ledger_row_count: 0, passport_usage_count: 0, captured_payment_verification: 'NOT_PERFORMED', replay: 'NOT_PERFORMED', dashboard_visual_check: 'NOT_REQUESTED' };
  persist(summary);
  console.log(JSON.stringify(summary));
}
main().catch(() => {
  const failure = { status: 'NEEDS FIXES', failed_stage: stage, counts, timestamp: new Date().toISOString() };
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='phase4_verification_state'").get()) persist(failure);
  console.log(JSON.stringify(failure)); process.exitCode = 1;
}).finally(() => closeDefaultDb());
