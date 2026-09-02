import { z } from 'zod';
import { CURRENCY } from './money';

export interface Product {
  id: string;
  name: string;
  description: string;
  unit_price_paise: number;
  currency: typeof CURRENCY;
  category: string;
  is_subscription: boolean;
  merchant_id: string;
  version: number;
  is_active: boolean;
  updated_at: string;
}

export const ProductInputSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  unit_price_paise: z.number().int().positive(),
  currency: z.literal(CURRENCY),
  category: z.string().min(1).max(64),
  is_subscription: z.boolean(),
  merchant_id: z.string().min(1).max(64),
});

export type ProductInput = z.infer<typeof ProductInputSchema>;

export const DEFAULT_MERCHANT_ID = 'demo_store';

/**
 * Seed items defined by the product specification.
 * All prices include taxes and shipping.
 */
export const SEED_CATALOG_ITEMS: Omit<Product, 'version' | 'is_active' | 'updated_at'>[] = [
  {
    id: 'prod_keyboard',
    name: 'Mechanical Keyboard',
    description: 'Hot-swappable mechanical keyboard with RGB backlighting and tactile switches.',
    unit_price_paise: 279900, // ₹2,799
    currency: CURRENCY,
    category: 'electronics',
    is_subscription: false,
    merchant_id: DEFAULT_MERCHANT_ID,
  },
  {
    id: 'prod_mouse',
    name: 'Wireless Mouse',
    description: 'Ergonomic dual-mode wireless mouse with high-precision optical sensor.',
    unit_price_paise: 149900, // ₹1,499
    currency: CURRENCY,
    category: 'electronics',
    is_subscription: false,
    merchant_id: DEFAULT_MERCHANT_ID,
  },
  {
    id: 'prod_book',
    name: 'Designing Data-Intensive Applications',
    description: 'Comprehensive software systems engineering guide by Martin Kleppmann.',
    unit_price_paise: 89900, // ₹899
    currency: CURRENCY,
    category: 'books',
    is_subscription: false,
    merchant_id: DEFAULT_MERCHANT_ID,
  },
  {
    id: 'prod_subscription',
    name: 'Premium Support Subscription',
    description: 'Annual 24/7 dedicated engineering support plan with SLA guarantees.',
    unit_price_paise: 1299900, // ₹12,999
    currency: CURRENCY,
    category: 'subscriptions',
    is_subscription: true,
    merchant_id: DEFAULT_MERCHANT_ID,
  },
];

/**
 * Escapes untrusted text to prevent XSS if rendered anywhere outside React's default escaping.
 */
export function escapeUntrustedText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
