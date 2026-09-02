/**
 * Intent State Machine and Allowed Transitions
 */

export const IntentStates = {
  PROPOSED: 'PROPOSED',
  BLOCKED: 'BLOCKED',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  READY: 'READY',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  ORDER_CREATED: 'ORDER_CREATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type IntentState = (typeof IntentStates)[keyof typeof IntentStates];

export const TERMINAL_STATES: ReadonlySet<IntentState> = new Set([
  IntentStates.BLOCKED,
  IntentStates.PAYMENT_CONFIRMED,
  IntentStates.DECLINED,
  IntentStates.EXPIRED,
]);

/**
 * Allowed transitions mapping: fromState -> Set of valid toStates
 */
export const ALLOWED_TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  [IntentStates.PROPOSED]: [
    IntentStates.BLOCKED,
    IntentStates.NEEDS_APPROVAL,
    IntentStates.READY,
    IntentStates.EXPIRED,
  ],
  [IntentStates.NEEDS_APPROVAL]: [
    IntentStates.APPROVED,
    IntentStates.DECLINED,
    IntentStates.EXPIRED,
  ],
  [IntentStates.READY]: [
    IntentStates.EXECUTING,
    IntentStates.EXPIRED,
  ],
  [IntentStates.APPROVED]: [
    IntentStates.EXECUTING,
    IntentStates.EXPIRED,
  ],
  [IntentStates.EXECUTING]: [
    IntentStates.ORDER_CREATED,
    IntentStates.PAYMENT_CONFIRMED, // Direct confirmation in mock/sync environments
    IntentStates.UNKNOWN,
    IntentStates.BLOCKED,
    IntentStates.DECLINED,
  ],
  [IntentStates.ORDER_CREATED]: [
    IntentStates.PAYMENT_CONFIRMED,
    IntentStates.UNKNOWN,
    IntentStates.DECLINED,
  ],
  [IntentStates.PAYMENT_CONFIRMED]: [], // Terminal: confirmed payments NEVER regress
  [IntentStates.DECLINED]: [],          // Terminal
  [IntentStates.BLOCKED]: [],           // Terminal
  [IntentStates.EXPIRED]: [],           // Terminal
  [IntentStates.UNKNOWN]: [],           // Terminal for automated flow
};

export class InvalidStateTransitionError extends Error {
  constructor(public fromState: string, public toState: string, details?: string) {
    super(`Illegal state transition from ${fromState} to ${toState}${details ? `: ${details}` : ''}`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Checks if a transition is permitted by the state machine.
 */
export function isValidTransition(fromState: IntentState, toState: IntentState): boolean {
  if (fromState === toState) {
    return true; // Idempotent no-op transition
  }
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return !!allowed && allowed.includes(toState);
}

/**
 * Asserts that a state transition is permitted. Throws InvalidStateTransitionError otherwise.
 */
export function assertValidTransition(fromState: IntentState, toState: IntentState, details?: string): void {
  if (!isValidTransition(fromState, toState)) {
    throw new InvalidStateTransitionError(fromState, toState, details);
  }
}
