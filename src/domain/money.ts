/**
 * Money and Currency Domain Logic
 * Strictly uses integer paise (1 INR = 100 paise)
 * Floating point arithmetic for authorization or accounting is strictly forbidden.
 */

export const CURRENCY = 'INR' as const;
export type Currency = typeof CURRENCY;

export class MoneyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyValidationError';
  }
}

/**
 * Validates that an amount is a valid non-negative integer paise value.
 */
export function assertValidPaise(amount: unknown, fieldName = 'amount'): asserts amount is number {
  if (typeof amount !== 'number') {
    throw new MoneyValidationError(`${fieldName} must be a number, received ${typeof amount}`);
  }
  if (!Number.isFinite(amount)) {
    throw new MoneyValidationError(`${fieldName} must be finite`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyValidationError(`${fieldName} must be a safe integer`);
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyValidationError(`${fieldName} must be an integer (paise cannot have fractional units)`);
  }
  if (amount < 0) {
    throw new MoneyValidationError(`${fieldName} must be non-negative, received ${amount}`);
  }
}

/**
 * Validates that an amount is a strictly positive integer paise value (> 0).
 */
export function assertPositivePaise(amount: unknown, fieldName = 'amount'): asserts amount is number {
  assertValidPaise(amount, fieldName);
  if (amount <= 0) {
    throw new MoneyValidationError(`${fieldName} must be strictly greater than 0, received ${amount}`);
  }
}

/**
 * Computes the total price in paise for a given unit price and quantity.
 * Throws if either input is invalid or if result overflows Number.MAX_SAFE_INTEGER.
 */
export function calculateTotalPaise(unitPricePaise: number, quantity: number): number {
  assertValidPaise(unitPricePaise, 'unitPricePaise');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new MoneyValidationError(`Quantity must be an integer between 1 and 10, received ${quantity}`);
  }
  const total = unitPricePaise * quantity;
  assertValidPaise(total, 'totalPaise');
  return total;
}

/**
 * Formats integer paise into a human-readable INR string.
 * Example: 279900 -> "₹2,799.00"
 */
export function formatPaise(paise: number): string {
  assertValidPaise(paise, 'paise');
  const rupees = Math.floor(paise / 100);
  const remainingPaise = paise % 100;
  const formattedRupees = rupees.toLocaleString('en-IN');
  const formattedPaise = remainingPaise.toString().padStart(2, '0');
  return `₹${formattedRupees}.${formattedPaise}`;
}

/**
 * Formats integer paise into a clean short display.
 * Example: 279900 -> "₹2,799"
 */
export function formatPaiseShort(paise: number): string {
  assertValidPaise(paise, 'paise');
  if (paise % 100 === 0) {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  }
  return formatPaise(paise);
}

/**
 * Safe conversion from rupees number to integer paise, rejecting floats with more than 2 decimal places.
 */
export function rupeesToPaise(rupees: number): number {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees < 0) {
    throw new MoneyValidationError(`Invalid rupee amount: ${rupees}`);
  }
  // Check that there are at most 2 decimal places
  const scaled = Math.round(rupees * 100);
  if (Math.abs(rupees - scaled / 100) > 1e-6) {
    throw new MoneyValidationError(`Rupee amount cannot have fractional paise: ${rupees}`);
  }
  assertValidPaise(scaled, 'convertedPaise');
  return scaled;
}
