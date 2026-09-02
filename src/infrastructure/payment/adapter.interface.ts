export type PaymentFaultType =
  | 'NONE'
  | 'SIMULATE_REJECTION'
  | 'SIMULATE_TIMEOUT'
  | 'SIMULATE_RESPONSE_LOSS'
  | 'SIMULATE_PENDING'
  | 'SIMULATE_DUPLICATE';

export interface CreateOrderParams {
  intentId: string;
  amountPaise: number;
  currency: string;
  merchantId: string;
  description: string;
  fault?: PaymentFaultType;
}

export interface PaymentOrderResult {
  isMock: true;
  success: boolean;
  orderId?: string;
  status: 'CREATED' | 'FAILED' | 'UNKNOWN';
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

export interface ConfirmCaptureParams {
  orderId: string;
  amountPaise: number;
  currency: string;
  fault?: PaymentFaultType;
}

export interface PaymentCaptureResult {
  isMock: true;
  success: boolean;
  paymentId?: string;
  orderId: string;
  status: 'CAPTURED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
  isDuplicate?: boolean;
}

export interface PaymentStatusResult {
  isMock: true;
  orderId: string;
  status: 'CREATED' | 'CAPTURED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  amountPaise: number;
  currency: string;
  rawResponse: Record<string, unknown>;
}

export interface PaymentAdapter {
  readonly mode: 'MOCK' | 'RAZORPAY_TEST';
  createOrder(params: CreateOrderParams): Promise<PaymentOrderResult>;
  confirmCapture(params: ConfirmCaptureParams): Promise<PaymentCaptureResult>;
  getOrderStatus(orderId: string): Promise<PaymentStatusResult>;
}
