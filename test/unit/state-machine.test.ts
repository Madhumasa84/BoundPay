import { describe, it, expect } from 'vitest';
import {
  IntentStates,
  isValidTransition,
  assertValidTransition,
  InvalidStateTransitionError,
  ALLOWED_TRANSITIONS,
} from '@/domain/state-machine';

describe('State Machine and Allowed Transitions', () => {
  describe('Happy Path Valid Transitions', () => {
    it('allows PROPOSED -> READY', () => {
      expect(isValidTransition(IntentStates.PROPOSED, IntentStates.READY)).toBe(true);
      expect(() => assertValidTransition(IntentStates.PROPOSED, IntentStates.READY)).not.toThrow();
    });

    it('allows PROPOSED -> NEEDS_APPROVAL', () => {
      expect(isValidTransition(IntentStates.PROPOSED, IntentStates.NEEDS_APPROVAL)).toBe(true);
    });

    it('allows PROPOSED -> BLOCKED', () => {
      expect(isValidTransition(IntentStates.PROPOSED, IntentStates.BLOCKED)).toBe(true);
    });

    it('allows NEEDS_APPROVAL -> APPROVED', () => {
      expect(isValidTransition(IntentStates.NEEDS_APPROVAL, IntentStates.APPROVED)).toBe(true);
    });

    it('allows NEEDS_APPROVAL -> DECLINED', () => {
      expect(isValidTransition(IntentStates.NEEDS_APPROVAL, IntentStates.DECLINED)).toBe(true);
    });

    it('allows READY -> EXECUTING', () => {
      expect(isValidTransition(IntentStates.READY, IntentStates.EXECUTING)).toBe(true);
    });

    it('allows APPROVED -> EXECUTING', () => {
      expect(isValidTransition(IntentStates.APPROVED, IntentStates.EXECUTING)).toBe(true);
    });

    it('allows EXECUTING -> ORDER_CREATED', () => {
      expect(isValidTransition(IntentStates.EXECUTING, IntentStates.ORDER_CREATED)).toBe(true);
    });

    it('allows ORDER_CREATED -> PAYMENT_CONFIRMED', () => {
      expect(isValidTransition(IntentStates.ORDER_CREATED, IntentStates.PAYMENT_CONFIRMED)).toBe(true);
    });

    it('allows EXECUTING -> UNKNOWN on timeout', () => {
      expect(isValidTransition(IntentStates.EXECUTING, IntentStates.UNKNOWN)).toBe(true);
    });

    it('allows ORDER_CREATED -> UNKNOWN on response loss', () => {
      expect(isValidTransition(IntentStates.ORDER_CREATED, IntentStates.UNKNOWN)).toBe(true);
    });
  });

  describe('Strict Terminal Invariants and Regressions', () => {
    it('forbids PAYMENT_CONFIRMED from regressing to ANY state', () => {
      const allStates = Object.values(IntentStates);
      for (const target of allStates) {
        if (target === IntentStates.PAYMENT_CONFIRMED) continue;
        expect(isValidTransition(IntentStates.PAYMENT_CONFIRMED, target)).toBe(false);
        expect(() =>
          assertValidTransition(IntentStates.PAYMENT_CONFIRMED, target)
        ).toThrow(InvalidStateTransitionError);
      }
    });

    it('forbids DECLINED from regressing to APPROVED or READY', () => {
      expect(isValidTransition(IntentStates.DECLINED, IntentStates.APPROVED)).toBe(false);
      expect(isValidTransition(IntentStates.DECLINED, IntentStates.READY)).toBe(false);
      expect(isValidTransition(IntentStates.DECLINED, IntentStates.EXECUTING)).toBe(false);
    });

    it('forbids BLOCKED from regressing to READY or APPROVED', () => {
      expect(isValidTransition(IntentStates.BLOCKED, IntentStates.READY)).toBe(false);
      expect(isValidTransition(IntentStates.BLOCKED, IntentStates.APPROVED)).toBe(false);
      expect(isValidTransition(IntentStates.BLOCKED, IntentStates.EXECUTING)).toBe(false);
    });

    it('forbids skipping authorization (PROPOSED directly to EXECUTING)', () => {
      expect(isValidTransition(IntentStates.PROPOSED, IntentStates.EXECUTING)).toBe(false);
    });

    it('forbids skipping approval (NEEDS_APPROVAL directly to EXECUTING)', () => {
      expect(isValidTransition(IntentStates.NEEDS_APPROVAL, IntentStates.EXECUTING)).toBe(false);
    });

    it('treats identical state transition as idempotent no-op', () => {
      expect(isValidTransition(IntentStates.READY, IntentStates.READY)).toBe(true);
      expect(isValidTransition(IntentStates.EXECUTING, IntentStates.EXECUTING)).toBe(true);
    });
  });
});
