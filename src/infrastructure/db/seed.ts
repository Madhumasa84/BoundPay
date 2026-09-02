import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createSqliteConnection, createDrizzleClient, getDatabasePath, schema } from './index';
import { runMigrations } from './migrate';
import { SEED_CATALOG_ITEMS } from '../../domain/catalog';
import { DEFAULT_POLICY } from '../../domain/policy';
import { eq } from 'drizzle-orm';

export function seedDatabase(dbPath: string = getDatabasePath()) {
  const sqlite = createSqliteConnection(dbPath);
  runMigrations(sqlite);
  const db = createDrizzleClient(sqlite);

  const nowIso = new Date().toISOString();

  // 1. Seed Operator (if none exists)
  const username = process.env.OPERATOR_USERNAME || 'operator';
  const password = process.env.OPERATOR_INITIAL_PASSWORD || 'BoundPayPass123!';
  
  const existingOperator = db.select().from(schema.operators).where(eq(schema.operators.username, username)).get();
  let operatorId: string;
  
  if (!existingOperator) {
    operatorId = crypto.randomUUID();
    const salt = bcrypt.genSaltSync(10);
    const password_hash = bcrypt.hashSync(password, salt);
    
    db.insert(schema.operators).values({
      id: operatorId,
      username,
      password_hash,
      created_at: nowIso,
    }).run();
    console.log(`[Seed] Created default operator: ${username}`);
  } else {
    operatorId = existingOperator.id;
    console.log(`[Seed] Operator ${username} already exists (skipping creation)`);
  }

  // 2. Seed Default Policy (if none exists)
  const existingPolicy = db.select().from(schema.policies).get();
  if (!existingPolicy) {
    db.insert(schema.policies).values({
      id: crypto.randomUUID(),
      version: 1,
      currency: DEFAULT_POLICY.currency,
      max_transaction_amount_paise: DEFAULT_POLICY.max_transaction_amount_paise,
      daily_budget_paise: DEFAULT_POLICY.daily_budget_paise,
      approval_threshold_paise: DEFAULT_POLICY.approval_threshold_paise,
      allowed_categories_json: JSON.stringify(DEFAULT_POLICY.allowed_categories),
      approved_merchant_id: DEFAULT_POLICY.approved_merchant_id,
      allow_subscriptions: DEFAULT_POLICY.allow_subscriptions,
      expires_at: DEFAULT_POLICY.expires_at,
      created_at: nowIso,
    }).run();
    console.log('[Seed] Created default spending policy (version 1)');
  } else {
    console.log('[Seed] Spending policy already exists (skipping creation)');
  }

  // 3. Seed Catalog Products (insert missing without overwriting existing)
  for (const item of SEED_CATALOG_ITEMS) {
    const existing = db.select().from(schema.products).where(eq(schema.products.id, item.id)).get();
    if (!existing) {
      db.insert(schema.products).values({
        id: item.id,
        name: item.name,
        description: item.description,
        unit_price_paise: item.unit_price_paise,
        currency: item.currency,
        category: item.category,
        is_subscription: item.is_subscription,
        merchant_id: item.merchant_id,
        version: 1,
        is_active: true,
        updated_at: nowIso,
      }).run();
      console.log(`[Seed] Added product: ${item.name} (${item.id})`);
    }
  }

  // 4. Log Seed Audit Event
  db.insert(schema.auditEvents).values({
    timestamp: nowIso,
    event_type: 'DATABASE_SEEDED',
    operator_id: operatorId,
    payload_json: JSON.stringify({ message: 'Database seeded safely' }),
  }).run();

  sqlite.close();
  console.log('[Seed] Database seeding completed successfully.');
}

if (require.main === module) {
  seedDatabase();
}
