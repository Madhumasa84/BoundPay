import crypto from 'crypto';
import {
  ConfirmCaptureParams,
  CreateOrderParams,
  PaymentAdapter,
  PaymentCaptureResult,
  PaymentOrderResult,
  PaymentStatusResult,
} from './adapter.interface';

interface StoredMockOrder {
  orderId: string;
  intentId: string;
  amountPaise: number;
  currency: string;
  status: 'CREATED' | 'CAPTURED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  payments: string[];
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly mode = 'MOCK' as const;
  private orders: Map<string, StoredMockOrder> = new Map();

  async createOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    const { intentId, amountPaise, currency, fault = 'NONE' } = params;

    if (fault === 'SIMULATE_REJECTION') {
      return {
        isMock: true,
        success: false,
        status: 'FAILED',
        errorMessage: 'Mock provider rejected order creation: simulated policy/risk decline',
        rawResponse: { fault, code: 'MOCK_REJECTED' },
      };
    }

    if (fault === 'SIMULATE_TIMEOUT') {
      return {
        isMock: true,
        success: false,
        status: 'UNKNOWN',
        errorMessage: 'Mock provider order creation timed out with uncertain outcome',
        rawResponse: { fault, code: 'MOCK_TIMEOUT' },
      };
    }

    const orderId = `mock_order_${crypto.randomBytes(8).toString('hex')}`;
    const stored: StoredMockOrder = {
      orderId,
      intentId,
      amountPaise,
      currency,
      status: 'CREATED',
      payments: [],
    };
    this.orders.set(orderId, stored);

    if (fault === 'SIMULATE_RESPONSE_LOSS') {
      // Order exists in provider, but response is lost to caller
      return {
        isMock: true,
        success: false,
        orderId,
        status: 'UNKNOWN',
        errorMessage: 'Order created on mock gateway, but network response was lost in transit',
        rawResponse: { fault, code: 'MOCK_RESPONSE_LOSS', orderId },
      };
    }

    return {
      isMock: true,
      success: true,
      orderId,
      status: 'CREATED',
      rawResponse: {
        id: orderId,
        entity: 'order',
        amount: amountPaise,
        currency,
        status: 'created',
        created_at: Math.floor(Date.now() / 1000),
      },
    };
  }

  async confirmCapture(params: ConfirmCaptureParams): Promise<PaymentCaptureResult> {
    const { orderId, amountPaise, currency, fault = 'NONE' } = params;
    const order = this.orders.get(orderId);

    if (fault === 'SIMULATE_REJECTION') {
      if (order) order.status = 'FAILED';
      return {
        isMock: true,
        success: false,
        orderId,
        status: 'FAILED',
        errorMessage: 'Payment capture declined: simulated insufficient funds or card failure (MOCK)',
        rawResponse: { fault, code: 'MOCK_CAPTURE_REJECTED' },
      };
    }

    if (fault === 'SIMULATE_TIMEOUT') {
      if (order) order.status = 'UNKNOWN';
      return {
        isMock: true,
        success: false,
        orderId,
        status: 'UNKNOWN',
        errorMessage: 'Mock provider payment capture timed out with uncertain outcome',
        rawResponse: { fault, code: 'MOCK_CAPTURE_TIMEOUT' },
      };
    }

    if (fault === 'SIMULATE_PENDING') {
      if (order) order.status = 'PENDING';
      return {
        isMock: true,
        success: false,
        orderId,
        status: 'PENDING',
        errorMessage: 'Mock payment authorization is pending customer 2FA/OTP',
        rawResponse: { fault, code: 'MOCK_PENDING' },
      };
    }

    if (fault === 'SIMULATE_DUPLICATE' || (order && order.status === 'CAPTURED')) {
      const existingPaymentId = order?.payments[0] || `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
      return {
        isMock: true,
        success: true,
        isDuplicate: true,
        orderId,
        paymentId: existingPaymentId,
        status: 'CAPTURED',
        rawResponse: {
          id: existingPaymentId,
          order_id: orderId,
          status: 'captured',
          duplicate_notice: 'Duplicate capture request handled idempotently',
        },
      };
    }

    const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
    if (order) {
      order.status = 'CAPTURED';
      order.payments.push(paymentId);
    }

    return {
      isMock: true,
      success: true,
      orderId,
      paymentId,
      status: 'CAPTURED',
      rawResponse: {
        id: paymentId,
        entity: 'payment',
        order_id: orderId,
        amount: amountPaise,
        currency,
        status: 'captured',
        method: 'mock_card',
        captured: true,
      },
    };
  }

  async getOrderStatus(orderId: string): Promise<PaymentStatusResult> {
    const order = this.orders.get(orderId);
    if (!order) {
      return {
        isMock: true,
        orderId,
        status: 'UNKNOWN',
        amountPaise: 0,
        currency: 'INR',
        rawResponse: { error: 'Order not found in mock store' },
      };
    }

    return {
      isMock: true,
      orderId,
      status: order.status,
      amountPaise: order.amountPaise,
      currency: order.currency,
      rawResponse: {
        id: order.orderId,
        status: order.status,
        amount: order.amountPaise,
        currency: order.currency,
      },
    };
  }
}
