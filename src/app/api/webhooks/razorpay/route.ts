import { ExecutionService } from '@/services/execution.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WEBHOOK_PAYLOAD_BYTES = 1024 * 1024; // 1 MB

export async function POST(req: Request) {
  try {
    const signature = req.headers.get('x-razorpay-signature');
    const eventIdHeader = req.headers.get('x-razorpay-event-id') || undefined;

    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing x-razorpay-signature header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read exact raw body text without parsing or mutating whitespace
    const rawBody = await req.text();

    if (rawBody.length > MAX_WEBHOOK_PAYLOAD_BYTES) {
      return new Response(JSON.stringify({ error: 'Payload exceeds size limit' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const executionService = new ExecutionService();
    const result = await executionService.handleRazorpayWebhook(rawBody, signature, eventIdHeader);

    if (result.status === 'INVALID_SIGNATURE') {
      return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Razorpay requires a 200 OK response upon receiving webhook
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Webhook processing error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
