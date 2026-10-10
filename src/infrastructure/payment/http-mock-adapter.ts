import { z } from 'zod';
import { callService, serviceToken, serviceUrl } from '../http/local-service';
import type { PaymentAdapter, CreateOrderParams, ConfirmCaptureParams, PaymentOrderResult, PaymentCaptureResult, PaymentStatusResult } from './adapter.interface';

const statusSchema = z.object({
  isMock: z.literal(true), orderId: z.string(), status: z.enum(['CREATED', 'CAPTURED', 'PENDING', 'FAILED', 'UNKNOWN']),
  amountPaise: z.number().int().safe().nonnegative(), currency: z.string(), paymentId: z.string().optional(), rawResponse: z.record(z.string(), z.unknown()),
});
const orderSchema = z.object({
  isMock: z.literal(true), success: z.boolean(), orderId: z.string().optional(), status: z.enum(['CREATED', 'FAILED', 'UNKNOWN']),
  rawResponse: z.record(z.string(), z.unknown()), errorMessage: z.string().optional(),
});
const captureSchema = z.object({
  isMock: z.literal(true), success: z.boolean(), orderId: z.string(), paymentId: z.string().optional(),
  status: z.enum(['CAPTURED', 'PENDING', 'FAILED', 'UNKNOWN']), rawResponse: z.record(z.string(), z.unknown()),
  errorMessage: z.string().optional(), isDuplicate: z.boolean().optional(),
});

/** Explicitly synthetic provider boundary with durable state in a separate process. */
export class HttpMockPaymentAdapter implements PaymentAdapter {
  readonly mode = 'MOCK' as const;
  private readonly url: URL;
  private readonly token: string;
  constructor(url = process.env.MOCK_PROVIDER_URL || '', token = process.env.MOCK_PROVIDER_TOKEN) {
    this.url = serviceUrl(url, 'MOCK_PROVIDER_URL');
    this.token = serviceToken(token, 'MOCK_PROVIDER_TOKEN');
  }
  async createOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    return orderSchema.parse(await callService(this.url, this.token, '/orders', params));
  }
  async confirmCapture(params: ConfirmCaptureParams): Promise<PaymentCaptureResult> {
    return captureSchema.parse(await callService(this.url, this.token, '/capture', params));
  }
  async getOrderStatus(orderId: string): Promise<PaymentStatusResult> {
    return statusSchema.parse(await callService(this.url, this.token, `/orders/${encodeURIComponent(orderId)}`));
  }
  async reconcileOrderByReceipt(receipt: string): Promise<PaymentStatusResult | null> {
    const result = await callService(this.url, this.token, `/receipts/${encodeURIComponent(receipt)}`);
    return result === null ? null : statusSchema.parse(result);
  }
}
