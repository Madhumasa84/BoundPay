import { z } from 'zod';
import { getProductById, updateProduct } from '@/services/catalog.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

const UpdateProductSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional(),
  unit_price_paise: z.number().int().positive().optional(),
  category: z.string().min(1).max(64).optional(),
  is_subscription: z.boolean().optional(),
  merchant_id: z.string().min(1).max(64).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const product = getProductById(params.id);
    if (!product) {
      return jsonResponse({ error: 'Not Found', message: `Product '${params.id}' not found` }, 404);
    }
    return jsonResponse({ product });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const body = await req.json();
    const validated = UpdateProductSchema.parse(body);
    const updated = updateProduct(params.id, validated, auth.operator.operatorId);
    return jsonResponse({ product: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
