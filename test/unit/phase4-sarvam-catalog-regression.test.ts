import { describe, expect, it } from 'vitest';
import { SarvamProvider } from '@/infrastructure/model/sarvam-provider';
import { SEED_CATALOG_ITEMS } from '@/domain/catalog';

function sarvamResponse(content: string): Response {
  return new Response(JSON.stringify({
    model: 'sarvam-105b',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Phase 4 Sarvam catalog regression', () => {
  it('keeps the trusted keyboard quote at 279900 paise instead of stale historical 429900', async () => {
    const keyboard = SEED_CATALOG_ITEMS.find((item) => item.id === 'prod_keyboard');
    expect(keyboard?.unit_price_paise).toBe(279900);

    // This stub reproduces the observed failure shape: a model that sees a
    // stale 429900-paise keyboard correctly declines it under a 400000-paise
    // budget. The verifier must use the source catalog above and never coerce
    // this refusal into the requested keyboard purchase.
    const provider = new SarvamProvider({
      apiKey: 'stub-sarvam-key',
      model: 'sarvam-105b',
      maxRetries: 0,
      fetchFn: async () => sarvamResponse(JSON.stringify({
        selected: false,
        product_id: '',
        quantity: 0,
        reason: 'Keyboard quote exceeds the supplied budget.',
      })),
    });
    const result = await provider.propose(
      'Buy one keyboard from the approved demo store within my budget.',
      400000,
      [{ ...keyboard!, unit_price_paise: 429900 }],
    );
    expect(result.selected).toBe(false);
    expect(result.product_id).toBe('');
    expect(result.quantity).toBe(0);
  });
});
