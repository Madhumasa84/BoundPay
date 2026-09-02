import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  RazorpayTestAdapter,
  RazorpaySecurityError,
} from '@/infrastructure/payment/razorpay-test-adapter';

describe('Razorpay Test Adapter Contract & Security Tests', () => {
  const validKeyId = 'rzp_test_mockKeyId123';
  const validKeySecret = 'test_mockKeySecret456';
  const validWebhookSecret = 'test_webhookSecret789';

  describe('Credential Validation and Live-Key Protection', () => {
    it('Strictly rejects live-mode key ID (rzp_live_...)', () => {
      expect(() => {
        new RazorpayTestAdapter({
          keyId: 'rzp_live_1234567890abcdef',
          keySecret: 'secret',
        });
      }).toThrow(RazorpaySecurityError);
    });

    it('Strictly rejects live-mode key secret', () => {
      expect(() => {
        new RazorpayTestAdapter({
          keyId: 'rzp_test_valid',
          keySecret: 'live_secret123456',
        });
      }).toThrow(RazorpaySecurityError);
    });

    it('Rejects missing keyId or keySecret', () => {
      expect(() => {
        new RazorpayTestAdapter({
          keyId: '',
          keySecret: validKeySecret,
        });
      }).toThrow(RazorpaySecurityError);

      expect(() => {
        new RazorpayTestAdapter({
          keyId: validKeyId,
          keySecret: '',
        });
      }).toThrow(RazorpaySecurityError);
    });

    it('Rejects arbitrary key ID without rzp_test_ prefix', () => {
      expect(() => {
        new RazorpayTestAdapter({
          keyId: 'custom_key_prefix_test',
          keySecret: validKeySecret,
        });
      }).toThrow(/Invalid Razorpay key ID format/);
    });

    it('Accepts valid rzp_test_ credentials', () => {
      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        webhookSecret: validWebhookSecret,
      });
      expect(adapter.mode).toBe('RAZORPAY_TEST');
      expect(adapter.getPublicClientKeyId()).toBe(validKeyId);
    });
  });

  describe('Order Creation Contract Tests', () => {
    it('Sends integer paise, INR currency, stable receipt, and intent ID in notes', async () => {
      let capturedUrl = '';
      let capturedHeaders: any = {};
      let capturedBody: any = null;

      const mockFetch = async (url: any, init: any) => {
        capturedUrl = url.toString();
        capturedHeaders = init.headers;
        capturedBody = JSON.parse(init.body);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'order_testOrder123',
            entity: 'order',
            amount: 279900,
            amount_paid: 0,
            amount_due: 279900,
            currency: 'INR',
            receipt: 'rcpt_intent1234',
            status: 'created',
            notes: { intent_id: 'intent_uuid_123' },
            created_at: 1725321600,
          }),
        } as any;
      };

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const result = await adapter.createOrder({
        intentId: 'intent_uuid_123',
        amountPaise: 279900,
        currency: 'INR',
        merchantId: 'demo_store',
        description: 'Keyboard order',
        receipt: 'rcpt_intent1234',
      });

      expect(capturedUrl).toContain('/orders');
      expect(capturedBody.amount).toBe(279900);
      expect(capturedBody.currency).toBe('INR');
      expect(capturedBody.receipt).toBe('rcpt_intent1234');
      expect(capturedBody.notes.intent_id).toBe('intent_uuid_123');
      expect(result.success).toBe(true);
      expect(result.orderId).toBe('order_testOrder123');
      expect(result.isMock).toBe(false);
      expect(result.status).toBe('CREATED');
    });

    it('Returns status UNKNOWN on amount or currency mismatch in provider response', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'order_mismatched',
          amount: 500000, // unexpected amount
          currency: 'INR',
        }),
      } as any);

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const result = await adapter.createOrder({
        intentId: 'intent_123',
        amountPaise: 279900,
        currency: 'INR',
        merchantId: 'demo_store',
        description: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('UNKNOWN');
      expect(result.errorMessage).toContain('mismatch');
    });

    it('Returns status FAILED on 4xx HTTP client rejection', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid merchant parameters' },
        }),
      } as any);

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const result = await adapter.createOrder({
        intentId: 'intent_123',
        amountPaise: 279900,
        currency: 'INR',
        merchantId: 'demo_store',
        description: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
    });

    it('Returns status UNKNOWN on timeout / 5xx / network error to preserve budget reservation', async () => {
      const mockFetch = async () => {
        throw new Error('ETIMEDOUT: Connection timed out');
      };

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const result = await adapter.createOrder({
        intentId: 'intent_123',
        amountPaise: 279900,
        currency: 'INR',
        merchantId: 'demo_store',
        description: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('UNKNOWN');
    });
  });

  describe('Standard Checkout Capture & Signature Contract Tests', () => {
    it('Confirms payment when signature matches and status is captured', async () => {
      const orderId = 'order_test123';
      const paymentId = 'pay_test456';
      const signature = crypto
        .createHmac('sha256', validKeySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const mockFetch = async (url: any) => {
        if (url.toString().includes('/payments/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: paymentId,
              order_id: orderId,
              amount: 149900,
              currency: 'INR',
              status: 'captured',
            }),
          } as any;
        }
        return { ok: false } as any;
      };

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const capture = await adapter.confirmCapture({
        orderId,
        paymentId,
        signature,
        amountPaise: 149900,
        currency: 'INR',
      });

      expect(capture.success).toBe(true);
      expect(capture.status).toBe('CAPTURED');
      expect(capture.paymentId).toBe(paymentId);
    });

    it('Rejects capture when checkout signature is tampered', async () => {
      const orderId = 'order_test123';
      const paymentId = 'pay_test456';
      const validSig = crypto
        .createHmac('sha256', validKeySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      // Tamper 1 byte
      const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
      });

      const capture = await adapter.confirmCapture({
        orderId,
        paymentId,
        signature: tamperedSig,
        amountPaise: 149900,
        currency: 'INR',
      });

      expect(capture.success).toBe(false);
      expect(capture.status).toBe('FAILED');
      expect(capture.errorMessage).toContain('signature verification failed');
    });

    it('Treats authorized payment as PENDING (not captured)', async () => {
      const orderId = 'order_test123';
      const paymentId = 'pay_test456';
      const signature = crypto
        .createHmac('sha256', validKeySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: paymentId,
          order_id: orderId,
          amount: 149900,
          currency: 'INR',
          status: 'authorized', // authorized but not captured
        }),
      } as any);

      const adapter = new RazorpayTestAdapter({
        keyId: validKeyId,
        keySecret: validKeySecret,
        customFetch: mockFetch,
      });

      const capture = await adapter.confirmCapture({
        orderId,
        paymentId,
        signature,
        amountPaise: 149900,
        currency: 'INR',
      });

      expect(capture.success).toBe(false);
      expect(capture.status).toBe('PENDING');
    });
  });
});
