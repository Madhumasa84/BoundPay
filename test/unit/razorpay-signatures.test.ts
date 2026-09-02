import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { RazorpayTestAdapter } from '@/infrastructure/payment/razorpay-test-adapter';

describe('Razorpay Signature Verification Unit Tests', () => {
  const secret = 'sec_test_mockSecret123456';
  const webhookSecret = 'whsec_test_webhookSecret987654';

  const adapter = new RazorpayTestAdapter({
    keyId: 'rzp_test_mockKeyId',
    keySecret: secret,
    webhookSecret,
  });

  describe('Standard Checkout Callback Signatures', () => {
    // Known test vector independently generated via standard openssl HMAC-SHA256
    // Payload: "order_DBJOWzybf0sJbb|pay_29QQoUBi66xm2f"
    // Key: "sec_test_mockSecret123456"
    // SHA256 HMAC: crypto.createHmac('sha256', secret).update(payload).digest('hex')
    const orderId = 'order_DBJOWzybf0sJbb';
    const paymentId = 'pay_29QQoUBi66xm2f';
    const knownSignature = crypto
      .createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    it('Accepts a mathematically valid checkout signature', () => {
      const isValid = adapter.verifyCheckoutSignature(orderId, paymentId, knownSignature);
      expect(isValid).toBe(true);
    });

    it('Rejects a signature with a single byte modification', () => {
      // Flip the last character
      const lastChar = knownSignature[knownSignature.length - 1];
      const replacementChar = lastChar === '0' ? '1' : '0';
      const modifiedSignature = knownSignature.slice(0, -1) + replacementChar;

      const isValid = adapter.verifyCheckoutSignature(orderId, paymentId, modifiedSignature);
      expect(isValid).toBe(false);
    });

    it('Rejects signature verified with wrong secret', () => {
      const adapterWrongSecret = new RazorpayTestAdapter({
        keyId: 'rzp_test_mockKeyId',
        keySecret: 'wrong_secret_abcdef123456',
      });

      const isValid = adapterWrongSecret.verifyCheckoutSignature(orderId, paymentId, knownSignature);
      expect(isValid).toBe(false);
    });

    it('Rejects signature when order ID is different', () => {
      const differentOrderId = 'order_DIFFERENT_99999';
      const isValid = adapter.verifyCheckoutSignature(differentOrderId, paymentId, knownSignature);
      expect(isValid).toBe(false);
    });

    it('Rejects signature when payment ID is different', () => {
      const differentPaymentId = 'pay_DIFFERENT_88888';
      const isValid = adapter.verifyCheckoutSignature(orderId, differentPaymentId, knownSignature);
      expect(isValid).toBe(false);
    });

    it('Rejects empty or malformed signatures', () => {
      expect(adapter.verifyCheckoutSignature(orderId, paymentId, '')).toBe(false);
      expect(adapter.verifyCheckoutSignature(orderId, paymentId, 'not-a-hex-signature')).toBe(false);
      expect(adapter.verifyCheckoutSignature('', paymentId, knownSignature)).toBe(false);
      expect(adapter.verifyCheckoutSignature(orderId, '', knownSignature)).toBe(false);
    });
  });

  describe('Webhook Raw-Body Signatures & Whitespace Sensitivity', () => {
    const rawPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_ABC123',
            amount: 279900,
            currency: 'INR',
            status: 'captured',
            order_id: 'order_XYZ456',
          },
        },
      },
    });

    const knownWebhookSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawPayload)
      .digest('hex');

    it('Accepts a valid raw body webhook signature', () => {
      const isValid = adapter.verifyWebhookSignature(rawPayload, knownWebhookSignature);
      expect(isValid).toBe(true);
    });

    it('Rejects signature when raw body whitespace has been altered (proves raw body must not be parsed and re-stringified)', () => {
      // Adding a single trailing newline or reformatting JSON alters HMAC!
      const alteredWhitespacePayload = rawPayload + '\n';
      const isValidWithAlteredWhitespace = adapter.verifyWebhookSignature(
        alteredWhitespacePayload,
        knownWebhookSignature
      );
      expect(isValidWithAlteredWhitespace).toBe(false);

      // Re-serializing with 2 space indentation alters HMAC!
      const prettyPayload = JSON.stringify(JSON.parse(rawPayload), null, 2);
      const isValidPretty = adapter.verifyWebhookSignature(prettyPayload, knownWebhookSignature);
      expect(isValidPretty).toBe(false);
    });

    it('Rejects webhook signature with one-byte modification', () => {
      const tampered =
        knownWebhookSignature.slice(0, -1) + (knownWebhookSignature.slice(-1) === 'a' ? 'b' : 'a');
      expect(adapter.verifyWebhookSignature(rawPayload, tampered)).toBe(false);
    });

    it('Rejects webhook signature verified against incorrect secret', () => {
      const adapterWrongWebhookSecret = new RazorpayTestAdapter({
        keyId: 'rzp_test_mockKeyId',
        keySecret: secret,
        webhookSecret: 'wrong_webhook_secret_123',
      });
      expect(adapterWrongWebhookSecret.verifyWebhookSignature(rawPayload, knownWebhookSignature)).toBe(
        false
      );
    });
  });
});
