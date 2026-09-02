import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { authenticateRequest, OperatorSession, validateSameOrigin } from '../../infrastructure/auth/session';
import { ConflictError, NotFoundError } from '../../services/purchase.service';
import { BudgetExceededError, QuoteRevalidationError, StateConflictError } from '../../services/execution.service';

export function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): NextResponse {
  return NextResponse.json(data, { status, headers });
}

export function errorResponse(error: unknown, status = 500): NextResponse {
  if (error instanceof ZodError) {
    const issues = error.issues || (error as any).errors || [];
    return NextResponse.json(
      {
        error: 'Validation Error',
        details: issues.map((e: any) => ({ path: e.path ? e.path.join('.') : '', message: e.message })),
      },
      { status: 400 }
    );
  }

  if (error instanceof ConflictError || error instanceof StateConflictError) {
    return NextResponse.json(
      { error: 'Conflict', message: error.message },
      { status: 409 }
    );
  }

  if (error instanceof NotFoundError) {
    return NextResponse.json(
      { error: 'Not Found', message: error.message },
      { status: 404 }
    );
  }

  if (error instanceof BudgetExceededError) {
    return NextResponse.json(
      { error: 'Budget Exceeded', message: error.message },
      { status: 422 }
    );
  }

  if (error instanceof QuoteRevalidationError) {
    return NextResponse.json(
      { error: 'Revalidation Failed', message: error.message },
      { status: 400 }
    );
  }

  const message = error instanceof Error ? error.message : 'An unexpected error occurred';
  // Return safe controlled error message without internal stack traces
  return NextResponse.json(
    { error: status >= 500 ? 'Internal Server Error' : 'Request Error', message },
    { status }
  );
}

export function requireAuth(req: Request): { operator: OperatorSession } | NextResponse {
  if (!validateSameOrigin(req)) {
    return jsonResponse({ error: 'Forbidden', message: 'Cross-origin request rejected' }, 403);
  }

  const operator = authenticateRequest(req);
  if (!operator) {
    return jsonResponse({ error: 'Unauthorized', message: 'Authentication required' }, 401);
  }

  return { operator };
}
