import { describe, it, expect } from 'vitest';
import {
  assertValidPaise,
  assertPositivePaise,
  calculateTotalPaise,
  formatPaise,
  formatPaiseShort,
  rupeesToPaise,
  MoneyValidationError,
} from '@/domain/money';

describe('Money and Integer Paise Domain Logic', () => {
  describe('assertValidPaise', () => {
    it('accepts zero paise', () => {
      expect(() => assertValidPaise(0)).not.toThrow();
    });

    it('accepts positive safe integers', () => {
      expect(() => assertValidPaise(1)).not.toThrow();
      expect(() => assertValidPaise(279900)).not.toThrow();
      expect(() => assertValidPaise(500000)).not.toThrow();
      expect(() => assertValidPaise(Number.MAX_SAFE_INTEGER)).not.toThrow();
    });

    it('rejects negative numbers', () => {
      expect(() => assertValidPaise(-1)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(-279900)).toThrow(MoneyValidationError);
    });

    it('rejects fractional numbers (no floating point paise)', () => {
      expect(() => assertValidPaise(10.5)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(0.01)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(2799.99)).toThrow(MoneyValidationError);
    });

    it('rejects non-finite numbers', () => {
      expect(() => assertValidPaise(Infinity)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(-Infinity)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(NaN)).toThrow(MoneyValidationError);
    });

    it('rejects unsafe integers (overflow protection)', () => {
      expect(() => assertValidPaise(Number.MAX_SAFE_INTEGER + 10)).toThrow(MoneyValidationError);
    });

    it('rejects non-numeric types', () => {
      expect(() => assertValidPaise('279900' as any)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(null as any)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise(undefined as any)).toThrow(MoneyValidationError);
      expect(() => assertValidPaise({} as any)).toThrow(MoneyValidationError);
    });
  });

  describe('assertPositivePaise', () => {
    it('rejects zero', () => {
      expect(() => assertPositivePaise(0)).toThrow(MoneyValidationError);
    });

    it('accepts 1 and higher', () => {
      expect(() => assertPositivePaise(1)).not.toThrow();
      expect(() => assertPositivePaise(100)).not.toThrow();
    });
  });

  describe('calculateTotalPaise and Quantity Boundaries', () => {
    const unitPrice = 279900; // ₹2,799

    it('accepts quantity 1 (minimum boundary)', () => {
      expect(calculateTotalPaise(unitPrice, 1)).toBe(279900);
    });

    it('accepts quantity 10 (maximum boundary)', () => {
      expect(calculateTotalPaise(unitPrice, 10)).toBe(2799000);
    });

    it('rejects quantity 0 (below minimum boundary)', () => {
      expect(() => calculateTotalPaise(unitPrice, 0)).toThrow(MoneyValidationError);
    });

    it('rejects quantity 11 (above maximum boundary)', () => {
      expect(() => calculateTotalPaise(unitPrice, 11)).toThrow(MoneyValidationError);
    });

    it('rejects negative quantity', () => {
      expect(() => calculateTotalPaise(unitPrice, -1)).toThrow(MoneyValidationError);
    });

    it('rejects fractional quantity', () => {
      expect(() => calculateTotalPaise(unitPrice, 1.5)).toThrow(MoneyValidationError);
    });
  });

  describe('formatPaise and conversions', () => {
    it('formats ₹2,799 correctly', () => {
      expect(formatPaise(279900)).toBe('₹2,799.00');
      expect(formatPaiseShort(279900)).toBe('₹2,799');
    });

    it('formats ₹0.50 correctly', () => {
      expect(formatPaise(50)).toBe('₹0.50');
    });

    it('converts rupees to paise safely', () => {
      expect(rupeesToPaise(2799)).toBe(279900);
      expect(rupeesToPaise(2799.5)).toBe(279950);
      expect(rupeesToPaise(2799.99)).toBe(279999);
    });

    it('rejects rupees with fractional paise (>2 decimal places)', () => {
      expect(() => rupeesToPaise(2799.999)).toThrow(MoneyValidationError);
    });
  });
});
