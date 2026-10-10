import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function serviceUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${name} must be an origin without credentials or a path`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error(`${name} requires HTTPS except on loopback`);
  }
  return url;
}

export function serviceToken(value: string | undefined, name: string): string {
  if (!value || value.length < 32 || /[\s\r\n]/.test(value)) throw new Error(`${name} must contain at least 32 non-whitespace characters`);
  return value;
}

export function authenticated(req: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function readServiceJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Request body exceeds 16 KiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function serviceResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function callService(origin: URL, token: string, pathname: string, body?: unknown, timeoutMs = 15000): Promise<unknown> {
  const response = await fetch(new URL(pathname, origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Independent service returned HTTP ${response.status}`);
  // Service endpoints have small fixed response schemas; reject oversized output.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Independent service returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new Error('Independent service response exceeds 64 KiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
