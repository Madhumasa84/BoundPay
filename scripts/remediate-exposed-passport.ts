import { createRequire } from 'module';
import { eq } from 'drizzle-orm';
import { getDb, closeDefaultDb, schema } from '../src/infrastructure/db';
import { revokePassport } from '../src/services/passport.service';
import { appendAuditEvent } from '../src/services/audit.service';
import { createProposal } from '../src/services/purchase.service';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
process.env.DATABASE_PATH = '/home/masa84/razorpay/data/phase-4-razorpay-test-20260905T020301Z.sqlite';
const passportId = 'pass_73ba6355-c739-4f12-8666-29cdc416b1c9';
const { db } = getDb();
try {
  const row = db.select().from(schema.authorityPassports).where(eq(schema.authorityPassports.id, passportId)).get();
  if (!row) throw new Error('PASSPORT_NOT_FOUND');
  const revoked = revokePassport(passportId, row.owner_id);
  appendAuditEvent({ eventType: 'EXPOSED_TOKEN_REVOKED', operatorId: row.owner_id, payload: { passportId, passportDigest: row.payload_digest, incident: 'signed_readable_token_exposed', keyRotationRequired: false } });
  let blocked = false;
  try {
    createProposal(row.owner_id, { product_id: 'prod_keyboard', quantity: 1, purchase_budget_paise: 400000, idempotency_key: 'exposed-passport-block-probe', source_mode: 'MANUAL', passport_id: passportId, agent_id: 'OfficeBot' }, 'RAZORPAY_TEST');
  } catch { blocked = true; }
  const audit = db.select({ event_type: schema.auditEvents.event_type }).from(schema.auditEvents).where(eq(schema.auditEvents.operator_id, row.owner_id)).all();
  console.log(JSON.stringify({ passport_status: revoked.status, exposed_token_revoked_event: audit.some(x => x.event_type === 'EXPOSED_TOKEN_REVOKED'), revoked_token_blocked: blocked, provider_orders: db.select().from(schema.purchaseIntents).all().filter(x => Boolean(x.provider_order_id)).length, intents: db.select().from(schema.purchaseIntents).all().length }));
} catch (error) {
  console.log(JSON.stringify({ status: 'FAILED', category: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally { closeDefaultDb(); }
