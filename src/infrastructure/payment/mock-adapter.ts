import crypto from 'crypto';
import Database from 'better-sqlite3';
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
  receipt?: string;
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly mode = 'MOCK' as const;
  private orders: Map<string, StoredMockOrder> = new Map();
  private store?: Database.Database;

  constructor(databasePath?: string) {
    if (databasePath) {
      this.store = new Database(databasePath);
      this.store.pragma('journal_mode = WAL');
      this.store.pragma('busy_timeout = 10000');
      this.store.exec('CREATE TABLE IF NOT EXISTS mock_orders (order_id TEXT PRIMARY KEY, receipt TEXT UNIQUE, data TEXT NOT NULL)');
    }
  }

  close(): void { this.store?.close(); }

  private get(orderId: string): StoredMockOrder | undefined {
    if (!this.store) return this.orders.get(orderId);
    const row = this.store.prepare('SELECT data FROM mock_orders WHERE order_id = ?').get(orderId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  private save(order: StoredMockOrder): void {
    if (!this.store) { this.orders.set(order.orderId, order); return; }
    this.store.prepare('INSERT INTO mock_orders(order_id, receipt, data) VALUES (?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET data = excluded.data')
      .run(order.orderId, order.receipt || null, JSON.stringify(order));
  }

  async reconcileOrderByReceipt(receipt: string): Promise<PaymentStatusResult | null> {
    const row = this.store?.prepare('SELECT order_id FROM mock_orders WHERE receipt = ?').get(receipt) as { order_id: string } | undefined;
    const orderId = row?.order_id || [...this.orders.values()].find((order) => order.receipt === receipt)?.orderId;
    return orderId ? this.getOrderStatus(orderId) : null;
  }

  async createOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    const { intentId, amountPaise, currency, fault = 'NONE' } = params;
    if (params.receipt) {
      const prior = await this.reconcileOrderByReceipt(params.receipt);
      if (prior) {
        const order = this.get(prior.orderId)!;
        if (order.intentId !== intentId || order.amountPaise !== amountPaise || order.currency !== currency) {
          return { isMock: true, success: false, status: 'UNKNOWN', rawResponse: {}, errorMessage: 'Receipt already belongs to different purchase terms' };
        }
        return { isMock: true, success: prior.status !== 'FAILED', orderId: prior.orderId, status: prior.status === 'FAILED' ? 'FAILED' : 'CREATED', rawResponse: prior.rawResponse };
      }
    }

    if (fault === 'SIMULATE_REJECTION') {
      const orderId = `mock_order_${crypto.randomBytes(8).toString('hex')}`;
      this.save({ orderId, intentId, amountPaise, currency, status: 'FAILED', payments: [], receipt: params.receipt });
      return {
        isMock: true,
        success: false,
        status: 'FAILED',
        orderId,
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
      receipt: params.receipt,
    };
    this.save(stored);

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
    const order = this.get(orderId);
    if (!order || order.amountPaise !== amountPaise || order.currency !== currency) {
      return { isMock: true, success: false, orderId, status: 'UNKNOWN', rawResponse: {}, errorMessage: 'Mock order is missing or does not match capture amount/currency' };
    }
    if (order.status === 'FAILED') return { isMock: true, success: false, orderId, status: 'FAILED', rawResponse: {}, errorMessage: 'Mock order failure is terminal' };
    if (order.status === 'CAPTURED') return { isMock: true, success: true, isDuplicate: true, orderId, paymentId: order.payments[0], status: 'CAPTURED', rawResponse: { id: order.payments[0], order_id: orderId, status: 'captured' } };

    if (fault === 'SIMULATE_REJECTION') {
      order.status = 'FAILED';
      this.save(order);
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
      order.status = 'UNKNOWN';
      this.save(order);
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
      order.status = 'PENDING';
      this.save(order);
      return {
        isMock: true,
        success: false,
        orderId,
        status: 'PENDING',
        errorMessage: 'Mock payment authorization is pending customer 2FA/OTP',
        rawResponse: { fault, code: 'MOCK_PENDING' },
      };
    }

    if (fault === 'SIMULATE_DUPLICATE') {
      const existingPaymentId = order.payments[0] || `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
      if (!order.payments.length) { order.status = 'CAPTURED'; order.payments.push(existingPaymentId); this.save(order); }
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
      this.save(order);
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
    const order = this.get(orderId);
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
      paymentId: order.payments[0],
      rawResponse: {
        id: order.orderId,
        status: order.status,
        amount: order.amountPaise,
        currency: order.currency,
        intent_id: order.intentId,
        receipt: order.receipt,
      },
    };
  }
}
