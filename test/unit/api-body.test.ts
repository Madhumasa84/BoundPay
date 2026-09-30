import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { PayloadTooLargeError, readJsonBody, UnsupportedMediaTypeError } from '@/app/api/api-helpers';

function jsonRequest(body: string): Request {
  return new Request('http://localhost/api/intents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}

describe('bounded JSON request bodies', () => {
  it('accepts a body at the byte limit', async () => {
    await expect(readJsonBody(jsonRequest('"abc"'), 5)).resolves.toBe('abc');
  });

  it('counts UTF-8 bytes rather than characters', async () => {
    await expect(readJsonBody(jsonRequest('"₹"'), 4)).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(readJsonBody(jsonRequest('"₹"'), 5)).resolves.toBe('₹');
  });

  it('rejects malformed JSON', async () => {
    await expect(readJsonBody(jsonRequest('{'))).rejects.toBeInstanceOf(ZodError);
  });

  it('requires a JSON content type', async () => {
    const req = new Request('http://localhost/api/intents', { method: 'POST', body: '{}' });
    await expect(readJsonBody(req)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  it('cancels oversized streams before consuming the rest of the body', async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(new TextEncoder().encode('"too large'));
        else controller.error(new Error('Body was consumed beyond the size limit'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const req = new Request('http://localhost/api/intents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      duplex: 'half',
    } as RequestInit);
    await expect(readJsonBody(req, 5)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(reads).toBe(1);
    expect(cancelled).toBe(true);
  });
});
