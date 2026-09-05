import { eq } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import { Product, ProductInput, ProductInputSchema } from '../domain/catalog';
import { Clock, defaultClock } from '../infrastructure/clock/clock';
import { appendAuditEvent } from './audit.service';

export function listProducts(): Product[] {
  const { db } = getDb();
  const rows = db.select().from(schema.products).where(eq(schema.products.is_active, true)).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    unit_price_paise: r.unit_price_paise,
    currency: 'INR' as const,
    category: r.category,
    is_subscription: r.is_subscription,
    merchant_id: r.merchant_id,
    version: r.version,
    is_active: r.is_active,
    updated_at: r.updated_at,
  }));
}

export function getProductById(id: string): Product | null {
  const { db } = getDb();
  const r = db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    unit_price_paise: r.unit_price_paise,
    currency: 'INR' as const,
    category: r.category,
    is_subscription: r.is_subscription,
    merchant_id: r.merchant_id,
    version: r.version,
    is_active: r.is_active,
    updated_at: r.updated_at,
  };
}

export function addProduct(
  input: ProductInput,
  operatorId: string,
  clock: Clock = defaultClock
): Product {
  const { db } = getDb();
  const nowIso = clock.nowIso();

  const product: Product = {
    ...input,
    version: 1,
    is_active: true,
    updated_at: nowIso,
  };

  db.insert(schema.products).values(product).run();

  appendAuditEvent({
    eventType: 'CATALOG_PRODUCT_ADDED',
    operatorId,
    amountPaise: product.unit_price_paise,
    payload: { product },
    clock,
  });

  return product;
}

export function updateProduct(
  id: string,
  updates: Partial<Omit<ProductInput, 'id'>>,
  operatorId: string,
  clock: Clock = defaultClock
): Product {
  const { db } = getDb();
  // Keep direct service callers on the same trusted integer/shape boundary as
  // the HTTP route.  Catalog values are later used for authorization and must
  // never admit unsafe or fractional paise through an internal call path.
  const validatedUpdates = ProductInputSchema.partial().omit({ id: true, currency: true }).parse(updates);
  const existing = getProductById(id);
  if (!existing) {
    throw new Error(`Product with ID '${id}' not found`);
  }

  const nowIso = clock.nowIso();
  const newVersion = existing.version + 1;

  const updated: Product = {
    ...existing,
    ...validatedUpdates,
    version: newVersion,
    updated_at: nowIso,
  };

  db.update(schema.products)
    .set({
      name: updated.name,
      description: updated.description,
      unit_price_paise: updated.unit_price_paise,
      category: updated.category,
      is_subscription: updated.is_subscription,
      merchant_id: updated.merchant_id,
      version: newVersion,
      updated_at: nowIso,
    })
    .where(eq(schema.products.id, id))
    .run();

  appendAuditEvent({
    eventType: 'CATALOG_PRODUCT_UPDATED',
    operatorId,
    amountPaise: updated.unit_price_paise,
    payload: {
      productId: id,
      previousVersion: existing.version,
      newVersion,
      changes: validatedUpdates,
    },
    clock,
  });

  return updated;
}
