import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { authenticateRequest, OperatorSession, validateSameOrigin } from '../../infrastructure/auth/session';
import { ConflictError, NotFoundError } from '../../services/purchase.service';
import { BudgetExceededError, QuoteRevalidationError, StateConflictError } from '../../services/execution.service';
import { AuthorityConfigurationError, AuthorityVerificationError } from '../../infrastructure/authority/signing';
import { PassportNotFoundError, PassportValidationError } from '../../services/passport.service';
import { PaymentModeConfigurationError } from '../../domain/intent';

export class PayloadTooLargeError extends Error {
  constructor(message = 'Request payload exceeds the permitted size') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor(message = 'Content-Type must be application/json') {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

/** Read JSON with a body-size limit even when a client omits Content-Length. */
export async function readJsonBody(req: Request, maxBytes = 128 * 1024): Promise<unknown> {
  const mediaType = (req.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new UnsupportedMediaTypeError();
  const body = await req.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new PayloadTooLargeError();
  try {
    return JSON.parse(body);
  } catch {
    throw new ZodError([{ code: 'custom', path: [], message: 'Malformed JSON body' }]);
  }
}

export function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): NextResponse {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Cache-Control')) responseHeaders.set('Cache-Control', 'private, no-store, max-age=0');
  if (!responseHeaders.has('Pragma')) responseHeaders.set('Pragma', 'no-cache');
  return NextResponse.json(data, { status, headers: responseHeaders });
}

export function errorResponse(error: unknown, status = 500): NextResponse {
  if (error instanceof PayloadTooLargeError) {
    return jsonResponse({ error: 'Payload Too Large', message: error.message }, 413);
  }
  if (error instanceof UnsupportedMediaTypeError) {
    return jsonResponse({ error: 'Unsupported Media Type', message: error.message }, 415);
  }
  if (error instanceof ZodError) {
    const issues = error.issues || (error as any).errors || [];
    return jsonResponse(
      {
        error: 'Validation Error',
        details: issues.map((e: any) => ({ path: e.path ? e.path.join('.') : '', message: e.message })),
      },
      400
    );
  }

  if (error instanceof ConflictError || error instanceof StateConflictError) {
    return jsonResponse(
      { error: 'Conflict', message: error.message },
      409
    );
  }

  if (error instanceof NotFoundError) {
    return jsonResponse(
      { error: 'Not Found', message: error.message },
      404
    );
  }

  if (error instanceof PassportNotFoundError) {
    return jsonResponse({ error: 'Not Found', message: error.message }, 404);
  }

  if (error instanceof PassportValidationError || error instanceof AuthorityVerificationError) {
    return jsonResponse({ error: 'Passport Verification Failed', message: error.message }, 400);
  }

  if (error instanceof AuthorityConfigurationError) {
    return jsonResponse({ error: 'Authority Configuration Error', message: 'Authority signing is not configured for this environment' }, 503);
  }

  if (error instanceof PaymentModeConfigurationError) {
    return jsonResponse({ error: 'Payment Configuration Error', message: error.message }, 503);
  }

  if (error instanceof BudgetExceededError) {
    return jsonResponse(
      { error: 'Budget Exceeded', message: error.message },
      422
    );
  }

  if (error instanceof QuoteRevalidationError) {
    return jsonResponse(
      { error: 'Revalidation Failed', message: error.message },
      400
    );
  }

  const message = status >= 500
    ? 'The request could not be completed'
    : error instanceof Error ? error.message : 'An unexpected error occurred';
  // Never serialize internal exception messages on server failures.
  return jsonResponse(
    { error: status >= 500 ? 'Internal Server Error' : 'Request Error', message },
    status
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
