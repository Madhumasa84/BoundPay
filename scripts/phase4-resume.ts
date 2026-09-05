import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import { eq } from 'drizzle-orm';
import { getDb, closeDefaultDb, schema } from '../src/infrastructure/db';
import { getAuthorityConfig, verifySignedToken, verifySignedTokenOffline, publicKeyFingerprint } from '../src/infrastructure/authority/signing';
import { resolvePaymentAdapterMode } from '../src/domain/intent';
import { createAuthorityPassport, verifyStoredPassport } from '../src/services/passport.service';
import { createProposal } from '../src/services/purchase.service';
import { getProductById } from '../src/services/catalog.service';
import { invokeShoppingAgent } from '../src/services/agent.service';
import { SarvamProvider } from '../src/infrastructure/model/sarvam-provider';
import { SEED_CATALOG_ITEMS } from '../src/domain/catalog';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
process.env.DATABASE_PATH = '/home/masa84/razorpay/data/phase-4-razorpay-test-20260905T020301Z.sqlite';
const { db, sqlite } = getDb();
function assert(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
const counts = { sarvam: 0, razorpay_read_only_preflight: 1, razorpay_create_order: 0, razorpay_payment_or_status_lookup: 0, checkout: 0, other_provider_calls: 0 };
const diagnostics: Record<string, unknown> = { request_id: null, http_status: null, error_category: null, response_content_type: null, retry_after: null, response_body_existed: false, request_bytes: null, response_bytes: null, latency_ms: null, retry_classification: 'NO_RETRY_PER_CONTROLLED_RESUMPTION' };
function persist(value: unknown) { sqlite.prepare('INSERT OR REPLACE INTO phase4_verification_state (id, payload_json) VALUES (1, ?)').run(JSON.stringify(value)); }
function sanitizeError(error: unknown): string { const msg = error instanceof Error ? error.message : 'unknown provider failure'; return msg.replace(/https?:\/\/\S+/g, '[URL_REDACTED]').replace(/\b(?:sk|rzp|live|key)_[A-Za-z0-9_-]+\b/gi, '[REDACTED]').slice(0, 240); }

async function main() {
  const config = getAuthorityConfig({ requirePrivate: true });
  assert(!config.testOnly && config.audience === 'urn:boundpay:razorpay-test' && resolvePaymentAdapterMode() === 'RAZORPAY_TEST', 'CONFIGURATION_INVALID');
  assert(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET && !/^(rzp_live_|live_)/.test(process.env.RAZORPAY_KEY_SECRET), 'TEST_CREDENTIALS_INVALID');
  assert(process.env.SARVAM_API_KEY, 'SARVAM_CONFIGURATION_MISSING');
  const old = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, 'pass_73ba6355-c739-4f12-8666-29cdc416b1c9')).get();
  assert(old?.status === 'REVOKED', 'EXPOSED_PASSPORT_NOT_REVOKED');
  assert((db.select().from(schema.purchaseIntents).all().filter((x) => Boolean(x.provider_order_id))).length === 0, 'ORDER_ALREADY_EXISTS');
  const trusted = SEED_CATALOG_ITEMS.find((x) => x.id === 'prod_keyboard')!;
  sqlite.prepare('UPDATE products SET unit_price_paise = ?, version = ?, updated_at = ? WHERE id = ?').run(trusted.unit_price_paise, 1, new Date().toISOString(), trusted.id);
  const ownerId = old.owner_id;
  const passport = createAuthorityPassport(ownerId, { agentId: 'OfficeBot', agentDisplayName: 'OfficeBot', allowedMerchantIds: ['demo_store'], allowedCategories: ['electronics'], maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 500000, approvalRequiredAbovePaise: 300000, maximumUsageCount: 2, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), idempotencyKey: 'phase4-replacement-passport' }, undefined, 'RAZORPAY_TEST');
  verifyStoredPassport(passport, ownerId, 'OfficeBot');
  const verified = await verifySignedToken(passport.signedToken, 'passport');
  assert(verified.paymentAdapterMode === 'RAZORPAY_TEST' && verified.operatorId === ownerId && verified.agentId === 'OfficeBot' && passport.status === 'ACTIVE', 'REPLACEMENT_PASSPORT_BINDING_FAILED');
  const provider = new SarvamProvider({ apiKey: process.env.SARVAM_API_KEY!, model: process.env.SARVAM_MODEL || 'sarvam-105b', maxRetries: 0, timeoutMs: 35000, fetchFn: async (url, init) => {
    assert(counts.sarvam === 0, 'SARVAM_CALL_LIMIT');
    counts.sarvam++;
    const started = Date.now();
    const response = await fetch(url, init);
    const copy = response.clone();
    let bytes = 0; try { bytes = (await copy.arrayBuffer()).byteLength; } catch {}
    diagnostics.http_status = response.status;
    diagnostics.response_content_type = response.headers.get('content-type');
    diagnostics.retry_after = response.headers.get('retry-after');
    diagnostics.response_body_existed = bytes > 0;
    diagnostics.response_bytes = bytes;
    diagnostics.latency_ms = Date.now() - started;
    diagnostics.request_bytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : null;
    diagnostics.request_id = response.headers.get('x-request-id') || response.headers.get('x-requestid') || null;
    persist({ stage: 'LIVE_SARVAM_DIAGNOSTICS', counts, diagnostics, passport_id: passport.payload.passportId });
    return response;
  } });
  let proposal;
  try { proposal = await invokeShoppingAgent('Buy one keyboard from the approved demo store within my budget.', 400000, { mode: 'live', provider }); }
  catch (error) {
    diagnostics.error_category = diagnostics.http_status === null ? 'HTTP_OR_NETWORK' : Number(diagnostics.http_status) >= 400 ? `HTTP_${diagnostics.http_status}` : 'PROVIDER_RESPONSE_PROCESSING';
    diagnostics.failure_detail = sanitizeError(error);
    persist({ status: 'NEEDS FIXES', stage: 'LIVE_SARVAM', counts, diagnostics, passport_id: passport.payload.passportId });
    console.log(JSON.stringify({ status: 'NEEDS FIXES', stage: 'LIVE_SARVAM', counts, diagnostics, passport_id: passport.payload.passportId }));
    return;
  }
  assert(proposal.suitable && proposal.product_id === 'prod_keyboard' && proposal.quantity === 1 && proposal.source_mode === 'LIVE_MODEL', 'MODEL_RESULT_INCOMPATIBLE');
  const product = getProductById(proposal.product_id);
  assert(product?.unit_price_paise === 279900 && product.merchant_id === 'demo_store' && product.category === 'electronics' && product.currency === 'INR', 'TRUSTED_CATALOG_MISMATCH');
  const result = createProposal(ownerId, { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 400000, idempotency_key: 'phase4-replacement-keyboard', source_mode: 'LIVE_MODEL', model_provider: proposal.model_provider, model_name: proposal.model_name, reason: proposal.reason, passport_id: passport.payload.passportId, agent_id: 'OfficeBot' }, 'RAZORPAY_TEST');
  assert(result.intent.state === 'NEEDS_APPROVAL' && result.passportEvaluation.decision === 'NEEDS_APPROVAL', 'APPROVAL_GATE_FAILED');
  const receipt = result.decisionReceipt!;
  const offline = await verifySignedTokenOffline(receipt.signedToken, 'receipt', config.publicKeyPem, { issuer: config.issuer, audience: config.audience });
  assert(offline.intentId === result.intent.id, 'RECEIPT_BINDING_FAILED');
  const summary = { status: 'AWAITING_EXACT_APPROVAL', counts, diagnostics, authority_configuration_valid: true, private_key_exposed: false, passport_signature_verified: true, passport_id: passport.payload.passportId, passport_digest: passport.payloadDigest, public_verification: { kid: config.keyId, issuer: config.issuer, audience: config.audience, algorithm: 'Ed25519', fingerprint_sha256: publicKeyFingerprint() }, signed_payment_mode: 'RAZORPAY_TEST', passport_expiry: passport.payload.expiresAt, intent_id: result.intent.id, agent: 'OfficeBot', product: product.name, product_id: product.id, quantity: 1, unit_price_paise: 279900, total_paise: 279900, currency: 'INR', merchant: product.merchant_id, category: product.category, policy_version: result.intent.policy_version, server_budget_paise: 1000000, server_approval_threshold_paise: 250000, passport_approval_threshold_paise: 300000, passport_budget_paise: 500000, passport_usage_limit: 2, existing_commitments_paise: 0, effective_policy_result: 'NEEDS_APPROVAL', approval_digest: result.intent.canonical_request_hash, quote_expiry: result.intent.quote_expiry, approval_result: 'PENDING', decision_checks: result.passportEvaluation.checks.map((x) => ({ id: x.id, status: x.status, reasonCode: x.reasonCode })), sarvam_proposal: { source_mode: proposal.source_mode, provider: proposal.model_provider, model: proposal.model_name, product_id: proposal.product_id, quantity: proposal.quantity, reason: proposal.reason }, offline_receipt_verification: 'VALID', provider_order_count: 0, ledger_row_count: 0, passport_usage_count: 0, captured_payment_verification: 'NOT_PERFORMED', replay: 'NOT_PERFORMED', dashboard_visual_check: 'NOT_REQUESTED' };
  persist(summary);
  console.log(JSON.stringify(summary));
}
main().catch((error) => { console.log(JSON.stringify({ status: 'NEEDS FIXES', counts, failure: sanitizeError(error) })); process.exitCode = 1; }).finally(() => closeDefaultDb());
