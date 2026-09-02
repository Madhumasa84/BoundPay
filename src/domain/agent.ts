import { z } from 'zod';

/**
 * Strict schema for AI Shopping Agent structured proposal.
 * The model may return only product_id, quantity (1-10), and reason,
 * or a structured suitable: false outcome when no catalog item fits.
 */
export const AgentSelectionSuccessSchema = z.object({
  suitable: z.literal(true),
  product_id: z.string().min(1, 'Product ID is required'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(10, 'Quantity cannot exceed 10'),
  reason: z.string().min(1, 'Reason is required').max(500, 'Reason cannot exceed 500 characters'),
});

export const AgentSelectionNoMatchSchema = z.object({
  suitable: z.literal(false),
  product_id: z.null().optional(),
  quantity: z.null().optional(),
  reason: z.string().min(1, 'Reason is required').max(500, 'Reason cannot exceed 500 characters'),
});

export const AgentProposalOutputSchema = z.discriminatedUnion('suitable', [
  AgentSelectionSuccessSchema,
  AgentSelectionNoMatchSchema,
]);

export type AgentProposalOutput = z.infer<typeof AgentProposalOutputSchema>;

export const ShoppingAgentRequestSchema = z.object({
  shopping_request: z.string().min(1, 'Shopping request cannot be empty').max(1000, 'Shopping request too long'),
  purchase_budget_paise: z.number().int().positive('Budget must be positive').max(Number.MAX_SAFE_INTEGER),
});

export type ShoppingAgentRequest = z.infer<typeof ShoppingAgentRequestSchema>;

/**
 * Strips HTML tags, script markers, and controls from reason or prompt output.
 */
export function sanitizeAgentReason(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '') // remove HTML tags
    .replace(/[<>{}\\]/g, '') // strip potential injection brackets
    .trim()
    .slice(0, 500);
}
