/**
 * Narrow interface for shopping model providers.
 * The deterministic authorization service and proposal flow depend only on this abstraction.
 */

export interface CatalogProductInput {
  id: string;
  name: string;
  description: string;
  unit_price_paise: number;
  category: string;
  is_subscription: boolean;
}

export interface ShoppingModelInput {
  shoppingRequest: string;
  purchaseBudgetPaise: number;
  catalog?: CatalogProductInput[];
}

export interface ModelProposalResult {
  selected: boolean;
  product_id: string;
  quantity: number;
  reason: string;
  source_mode: 'LIVE_MODEL' | 'FIXTURE';
  model_provider: string;
  model_name: string;
  response_model?: string;
  finish_reason?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  retry_count?: number;
}

export interface ShoppingModelProvider {
  proposePurchase(input: ShoppingModelInput): Promise<ModelProposalResult>;
}
