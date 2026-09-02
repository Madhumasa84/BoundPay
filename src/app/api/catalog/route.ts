import { ProductInputSchema } from '@/domain/catalog';
import { addProduct, listProducts } from '@/services/catalog.service';
import { errorResponse, jsonResponse, requireAuth } from '@/app/api/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const products = listProducts();
    return jsonResponse({ products });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if ('status' in auth) return auth;

  try {
    const body = await req.json();
    const validated = ProductInputSchema.parse(body);
    const product = addProduct(validated, auth.operator.operatorId);
    return jsonResponse({ product }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
