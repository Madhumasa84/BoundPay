import { createRequire } from 'module';
import { eq } from 'drizzle-orm';
import { getDb, closeDefaultDb, schema } from '../src/infrastructure/db';
import { approveIntent } from '../src/services/purchase.service';
import { ExecutionService } from '../src/services/execution.service';

const req = createRequire(require.resolve('next/package.json'));
req('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
process.env.DATABASE_PATH = '/home/masa84/razorpay/data/phase-4-razorpay-test-20260905T020301Z.sqlite';
const { db } = getDb();
const intentId = 'bf5eba88-4efa-43e8-aa8b-c16b379e5853';
async function main() {
  const row = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();
  if (!row) throw new Error('INTENT_NOT_FOUND');
  const approved = approveIntent(intentId, row.owner_id, 'Exact intent approved by operator');
  const execution = await new ExecutionService().executeIntent(intentId, row.owner_id);
  const stored = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get()!;
  const orderCount = db.select().from(schema.purchaseIntents).all().filter((x) => Boolean(x.provider_order_id)).length;
  const ledger = db.select().from(schema.spendLedger).where(eq(schema.spendLedger.intent_id, intentId)).all();
  const usage = db.select().from(schema.passportUsages).where(eq(schema.passportUsages.intent_id, intentId)).all();
  console.log(JSON.stringify({ status: execution.status, success: execution.success, approval_state: approved.state, intent_state: stored.state, provider_order_id: execution.providerOrderId || stored.provider_order_id || null, public_key_id: execution.keyId || null, amount_paise: stored.total_amount_paise, currency: stored.currency, order_count: orderCount, ledger_count: ledger.length, ledger_status: ledger[0]?.status || null, passport_usage_count: usage.length, passport_usage_status: usage[0]?.usage_status || null, message: execution.message }));
}
main().catch((error) => {
  console.log(JSON.stringify({ status: 'NEEDS FIXES', category: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
}).finally(() => closeDefaultDb());
