import crypto from 'crypto';
import {
  ConfirmCaptureParams,
  CreateOrderParams,
  PaymentAdapter,
  PaymentCaptureResult,
  PaymentOrderResult,
  PaymentStatusResult,
} from './adapter.interface';

export interface RazorpayAdapterConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  apiBaseUrl?: string; // defaults to https://api.razorpay.com/v1
  customFetch?: typeof fetch;
}

export class RazorpaySecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RazorpaySecurityError';
  }
}

export class RazorpayTestAdapter implements PaymentAdapter {
  readonly mode = 'RAZORPAY_TEST' as const;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(config: RazorpayAdapterConfig) {
    if (!config.keyId || !config.keySecret) {
      throw new RazorpaySecurityError('Razorpay test credentials (keyId, keySecret) are required.');
    }

    // Strictly reject live-mode keys
    if (config.keyId.startsWith('rzp_live_') || config.keySecret.startsWith('live_')) {
      throw new RazorpaySecurityError(
        'Live Razorpay keys are strictly prohibited in BoundPay. Only test keys (rzp_test_...) are permitted.'
      );
    }

    if (!config.keyId.startsWith('rzp_test_')) {
      throw new RazorpaySecurityError(
        `Invalid Razorpay key ID format '${config.keyId}'. Expected 'rzp_test_...' prefix.`
      );
    }

    this.keyId = config.keyId;
    this.keySecret = config.keySecret;
    this.webhookSecret = config.webhookSecret || '';
    this.apiBaseUrl = config.apiBaseUrl || 'https://api.razorpay.com/v1';
    this.fetcher = config.customFetch || fetch;
  }

  getPublicClientKeyId(): string {
    return this.keyId;
  }

  private getAuthHeader(): string {
    const creds = `${this.keyId}:${this.keySecret}`;
    return `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  /**
   * Creates a single order on Razorpay TEST API.
   * Uses server-calculated integer paise, INR, stable receipt, and intent ID in notes.
   */
  async createOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    const receipt = params.receipt || `rcpt_${params.intentId.replace(/-/g, '').substring(0, 16)}`;

    const payload = {
      amount: params.amountPaise,
      currency: params.currency,
      receipt,
      notes: {
        intent_id: params.intentId,
        merchant_id: params.merchantId,
        description: params.description.slice(0, 120),
      },
      partial_payment: false,
    };

    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/orders`, {
        method: 'POST',
        headers: {
          Authorization: this.getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const isClientError = response.status >= 400 && response.status < 500;
        return {
          isMock: false,
          success: false,
          status: isClientError ? 'FAILED' : 'UNKNOWN',
          rawResponse: errBody,
          errorMessage: `Razorpay order creation failed (HTTP ${response.status}): ${JSON.stringify(errBody)}`,
        };
      }

      const orderData = (await response.json()) as any;

      // Strict contract validation
      if (!orderData.id || typeof orderData.id !== 'string') {
        return {
          isMock: false,
          success: false,
          status: 'UNKNOWN',
          rawResponse: orderData,
          errorMessage: 'Razorpay response missing order ID',
        };
      }

      if (orderData.amount !== params.amountPaise || orderData.currency !== params.currency) {
        return {
          isMock: false,
          success: false,
          status: 'UNKNOWN',
          rawResponse: orderData,
          errorMessage: `Razorpay order amount/currency mismatch: expected ${params.amountPaise} ${params.currency}, got ${orderData.amount} ${orderData.currency}`,
        };
      }

      return {
        isMock: false,
        success: true,
        orderId: orderData.id,
        keyId: this.keyId,
        status: 'CREATED',
        rawResponse: orderData,
      };
    } catch (err: any) {
      // Network failure, timeout, or dropped connection
      return {
        isMock: false,
        success: false,
        status: 'UNKNOWN',
        rawResponse: { error: err.message },
        errorMessage: `Network error connecting to Razorpay: ${err.message}`,
      };
    }
  }

  /**
   * Verifies standard checkout callback signature and confirms captured status with provider.
   */
  async confirmCapture(params: ConfirmCaptureParams): Promise<PaymentCaptureResult> {
    if (!params.orderId) {
      return {
        isMock: false,
        success: false,
        orderId: '',
        status: 'FAILED',
        rawResponse: {},
        errorMessage: 'Missing orderId for checkout capture confirmation',
      };
    }

    if (!params.paymentId || !params.signature) {
      return {
        isMock: false,
        success: false,
        orderId: params.orderId,
        status: 'FAILED',
        rawResponse: {},
        errorMessage: 'Missing paymentId or signature for checkout verification',
      };
    }

    // 1. Verify checkout HMAC SHA-256 signature
    const isValidSignature = this.verifyCheckoutSignature(
      params.orderId,
      params.paymentId,
      params.signature
    );

    if (!isValidSignature) {
      return {
        isMock: false,
        success: false,
        paymentId: params.paymentId,
        orderId: params.orderId,
        status: 'FAILED',
        rawResponse: { signatureValid: false },
        errorMessage: 'Razorpay payment signature verification failed. Possible tampering.',
      };
    }

    // 2. Fetch authoritative payment details from Razorpay Payments API
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/payments/${params.paymentId}`, {
        method: 'GET',
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        return {
          isMock: false,
          success: false,
          paymentId: params.paymentId,
          orderId: params.orderId,
          status: 'UNKNOWN',
          rawResponse: errBody,
          errorMessage: `Failed to fetch payment status from Razorpay (HTTP ${response.status})`,
        };
      }

      const paymentData = (await response.json()) as any;

      // 3. Verify order association, amount, and currency
      if (paymentData.order_id !== params.orderId) {
        return {
          isMock: false,
          success: false,
          paymentId: params.paymentId,
          orderId: params.orderId,
          status: 'FAILED',
          rawResponse: paymentData,
          errorMessage: `Payment order ID mismatch: expected ${params.orderId}, got ${paymentData.order_id}`,
        };
      }

      if (paymentData.amount !== params.amountPaise || paymentData.currency !== params.currency) {
        return {
          isMock: false,
          success: false,
          paymentId: params.paymentId,
          orderId: params.orderId,
          status: 'FAILED',
          rawResponse: paymentData,
          errorMessage: `Payment amount/currency mismatch: expected ${params.amountPaise} ${params.currency}, got ${paymentData.amount} ${paymentData.currency}`,
        };
      }

      if (paymentData.status === 'captured') {
        return {
          isMock: false,
          success: true,
          paymentId: params.paymentId,
          orderId: params.orderId,
          status: 'CAPTURED',
          rawResponse: paymentData,
        };
      }

      if (paymentData.status === 'authorized') {
        // Authorized but not captured is treated as pending
        return {
          isMock: false,
          success: false,
          paymentId: params.paymentId,
          orderId: params.orderId,
          status: 'PENDING',
          rawResponse: paymentData,
          errorMessage: 'Payment is authorized but not yet captured by Razorpay.',
        };
      }

      return {
        isMock: false,
        success: false,
        paymentId: params.paymentId,
        orderId: params.orderId,
        status: 'FAILED',
        rawResponse: paymentData,
        errorMessage: `Payment status is ${paymentData.status}`,
      };
    } catch (err: any) {
      return {
        isMock: false,
        success: false,
        paymentId: params.paymentId,
        orderId: params.orderId,
        status: 'UNKNOWN',
        rawResponse: { error: err.message },
        errorMessage: `Network error verifying payment with Razorpay: ${err.message}`,
      };
    }
  }

  /**
   * Queries Razorpay for order and payment status.
   */
  async getOrderStatus(orderId: string): Promise<PaymentStatusResult> {
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/orders/${orderId}/payments`, {
        method: 'GET',
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return {
          isMock: false,
          orderId,
          status: 'UNKNOWN',
          amountPaise: 0,
          currency: 'INR',
          rawResponse: err,
        };
      }

      const data = (await response.json()) as { items?: Array<any>; count?: number };
      const payments = data.items || [];

      // Check for captured payment
      const capturedPayment = payments.find((p) => p.status === 'captured');
      if (capturedPayment) {
        return {
          isMock: false,
          orderId,
          status: 'CAPTURED',
          paymentId: capturedPayment.id,
          amountPaise: capturedPayment.amount,
          currency: capturedPayment.currency,
          rawResponse: capturedPayment,
        };
      }

      // Check for authorized payment
      const authorizedPayment = payments.find((p) => p.status === 'authorized');
      if (authorizedPayment) {
        return {
          isMock: false,
          orderId,
          status: 'PENDING',
          paymentId: authorizedPayment.id,
          amountPaise: authorizedPayment.amount,
          currency: authorizedPayment.currency,
          rawResponse: authorizedPayment,
        };
      }

      return {
        isMock: false,
        orderId,
        status: 'CREATED',
        amountPaise: 0,
        currency: 'INR',
        rawResponse: data as any,
      };
    } catch (err: any) {
      return {
        isMock: false,
        orderId,
        status: 'UNKNOWN',
        amountPaise: 0,
        currency: 'INR',
        rawResponse: { error: err.message },
      };
    }
  }

  /**
   * Reconciles an order by searching for its stable receipt string.
   */
  async reconcileOrderByReceipt(receipt: string): Promise<PaymentStatusResult | null> {
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/orders?receipt=${encodeURIComponent(receipt)}`, {
        method: 'GET',
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { items?: Array<any> };
      const orders = data.items || [];
      if (orders.length === 0) return null;

      const order = orders[0];
      return this.getOrderStatus(order.id);
    } catch {
      return null;
    }
  }

  /**
   * Constant-time comparison for Razorpay Standard Checkout HMAC signature:
   * HMAC-SHA256(order_id + "|" + payment_id, key_secret)
   */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!orderId || !paymentId || !signature) return false;
    try {
      const payload = `${orderId}|${paymentId}`;
      const expected = crypto
        .createHmac('sha256', this.keySecret)
        .update(payload)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const signatureBuf = Buffer.from(signature, 'utf8');

      if (expectedBuf.length !== signatureBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, signatureBuf);
    } catch {
      return false;
    }
  }

  /**
   * Constant-time comparison for Razorpay Webhook signature:
   * HMAC-SHA256(raw_body, webhook_secret)
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret || !rawBody || !signature) return false;
    try {
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const signatureBuf = Buffer.from(signature, 'utf8');

      if (expectedBuf.length !== signatureBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, signatureBuf);
    } catch {
      return false;
    }
  }
}
