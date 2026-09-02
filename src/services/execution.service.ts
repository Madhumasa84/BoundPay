import crypto from 'crypto';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import { IntentStates, assertValidTransition } from '../domain/state-machine';
import { PurchaseIntent } from '../domain/intent';
import { PaymentAdapter, PaymentFaultType } from '../infrastructure/payment/adapter.interface';
import { MockPaymentAdapter } from '../infrastructure/payment/mock-adapter';
import { Clock, defaultClock } from '../infrastructure/clock/clock';
import { getKolkataDayRange } from './policy.service';
import { appendAuditEvent } from './audit.service';

export interface ExecutionResult {
  intent: PurchaseIntent;
  ledgerId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  isMock: true;
  success: boolean;
  status: string;
  message: string;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class QuoteRevalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteRevalidationError';
  }
}

export class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateConflictError';
  }
}

export class ExecutionService {
  constructor(
    private paymentAdapter: PaymentAdapter = new MockPaymentAdapter(),
    private clock: Clock = defaultClock
  ) {}

  /**
   * Atomically claims intent, revalidates quote/policy/approval, checks daily budget invariant,
   * creates spend ledger reservation, and sets state to EXECUTING.
   * Runs inside a real SQLite immediate transaction (serialized write lock).
   */
  claimAndReserveAtomic(intentId: string, operatorId: string): { intent: PurchaseIntent; ledgerId: string } {
    const { sqlite, db } = getDb();
    const nowIso = this.clock.nowIso();
    const { startIso, endIso } = getKolkataDayRange(this.clock.now());

    const atomicTx = sqlite.transaction(() => {
      // 1. Fetch intent
      const intentRow = db
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.id, intentId))
        .get();

      if (!intentRow) {
        throw new StateConflictError(`Purchase intent '${intentId}' not found`);
      }

      if (intentRow.owner_id !== operatorId) {
        throw new StateConflictError('Unauthorized: operator does not own this intent');
      }

      // Check state: must be READY or APPROVED to transition to EXECUTING
      if (intentRow.state !== IntentStates.READY && intentRow.state !== IntentStates.APPROVED) {
        throw new StateConflictError(
          `Intent is in state '${intentRow.state}', cannot be claimed for execution (must be READY or APPROVED)`
        );
      }

      // 2. Revalidate Quote Expiry
      if (nowIso >= intentRow.quote_expiry) {
        db.update(schema.purchaseIntents)
          .set({
            state: IntentStates.EXPIRED,
            failure_reason: 'Quote validity window expired prior to execution',
            updated_at: nowIso,
          })
          .where(eq(schema.purchaseIntents.id, intentId))
          .run();

        appendAuditEvent({
          eventType: 'INTENT_EXPIRED',
          intentId,
          operatorId,
          stateBefore: intentRow.state,
          stateAfter: IntentStates.EXPIRED,
          payload: { reason: 'Quote expired at boundary', quoteExpiry: intentRow.quote_expiry, nowIso },
          clock: this.clock,
        });

        throw new QuoteRevalidationError(`Quote expired at ${intentRow.quote_expiry} (current: ${nowIso})`);
      }

      // 3. Revalidate Catalog Product
      const productRow = db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, intentRow.product_id))
        .get();

      if (
        !productRow ||
        !productRow.is_active ||
        productRow.version !== intentRow.product_version ||
        productRow.unit_price_paise !== intentRow.unit_price_paise ||
        productRow.merchant_id !== intentRow.merchant_id ||
        productRow.category !== intentRow.category ||
        productRow.is_subscription !== intentRow.is_subscription
      ) {
        throw new QuoteRevalidationError(
          'Catalog product price or attributes modified after proposal; new proposal and authorization required'
        );
      }

      // 4. Revalidate Policy
      const latestPolicy = db
        .select()
        .from(schema.policies)
        .orderBy(schema.policies.version)
        .all()
        .pop();

      if (!latestPolicy || latestPolicy.version !== intentRow.policy_version) {
        throw new QuoteRevalidationError(
          'Spending policy modified after proposal; new proposal and authorization required'
        );
      }

      if (nowIso >= latestPolicy.expires_at) {
        throw new QuoteRevalidationError(
          `Spending policy expired at ${latestPolicy.expires_at}`
        );
      }

      // 5. Revalidate Approval Binding (if state was APPROVED)
      if (intentRow.state === IntentStates.APPROVED) {
        const approvalRow = db
          .select()
          .from(schema.intentApprovals)
          .where(
            and(
              eq(schema.intentApprovals.intent_id, intentId),
              eq(schema.intentApprovals.status, 'APPROVED')
            )
          )
          .get();

        if (!approvalRow || approvalRow.canonical_hash !== intentRow.canonical_request_hash) {
          throw new QuoteRevalidationError(
            'Cryptographic approval binding mismatch: proposal parameters were altered'
          );
        }
      }

      // 6. Check Available Daily Budget Invariant
      // confirmed today + active reservations + proposed reservation <= daily_budget
      const confirmedRows = db
        .select({ amount: schema.spendLedger.amount_paise })
        .from(schema.spendLedger)
        .where(
          and(
            eq(schema.spendLedger.status, 'CONFIRMED'),
            eq(schema.spendLedger.payment_adapter_mode, intentRow.payment_adapter_mode),
            gte(schema.spendLedger.confirmation_timestamp, startIso),
            lte(schema.spendLedger.confirmation_timestamp, endIso)
          )
        )
        .all();
      const confirmedTodayPaise = confirmedRows.reduce((sum, r) => sum + r.amount, 0);

      const reservedRows = db
        .select({ amount: schema.spendLedger.amount_paise })
        .from(schema.spendLedger)
        .where(
          and(
            eq(schema.spendLedger.status, 'RESERVED'),
            eq(schema.spendLedger.payment_adapter_mode, intentRow.payment_adapter_mode)
          )
        )
        .all();
      const activeReservationsPaise = reservedRows.reduce((sum, r) => sum + r.amount, 0);

      const totalCommittedWithProposal =
        confirmedTodayPaise + activeReservationsPaise + intentRow.total_amount_paise;

      if (totalCommittedWithProposal > latestPolicy.daily_budget_paise) {
        throw new BudgetExceededError(
          `Daily budget exceeded: cannot reserve ${intentRow.total_amount_paise} paise. ` +
          `Committed: ${confirmedTodayPaise + activeReservationsPaise} paise (${confirmedTodayPaise} confirmed + ${activeReservationsPaise} reserved). ` +
          `Daily budget: ${latestPolicy.daily_budget_paise} paise.`
        );
      }

      // 7. Insert Spend Ledger Reservation
      const ledgerId = crypto.randomUUID();
      db.insert(schema.spendLedger).values({
        id: ledgerId,
        intent_id: intentId,
        amount_paise: intentRow.total_amount_paise,
        status: 'RESERVED',
        reservation_timestamp: nowIso,
        confirmation_timestamp: null,
        payment_adapter_mode: intentRow.payment_adapter_mode,
        provider_order_id: null,
        provider_payment_id: null,
      }).run();

      // 8. Transition Intent State to EXECUTING
      assertValidTransition(intentRow.state as any, IntentStates.EXECUTING);
      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.EXECUTING,
          updated_at: nowIso,
        })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      // 9. Append Audit Event
      appendAuditEvent({
        eventType: 'BUDGET_RESERVED',
        intentId,
        operatorId,
        policyVersion: latestPolicy.version,
        amountPaise: intentRow.total_amount_paise,
        stateBefore: intentRow.state,
        stateAfter: IntentStates.EXECUTING,
        payload: {
          ledgerId,
          reservationAmountPaise: intentRow.total_amount_paise,
          confirmedTodayPaise,
          activeReservationsPaise,
          dailyBudgetPaise: latestPolicy.daily_budget_paise,
        },
        clock: this.clock,
      });

      return {
        intent: {
          ...intentRow,
          state: IntentStates.EXECUTING,
          updated_at: nowIso,
        } as PurchaseIntent,
        ledgerId,
      };
    });

    return atomicTx.immediate();
  }

  /**
   * Executes the full purchase flow:
   * 1. Atomic claim & reservation
   * 2. Outside DB transaction: dispatch payment adapter createOrder & confirmCapture
   * 3. Record outcome & update ledger state
   */
  async executeIntent(
    intentId: string,
    operatorId: string,
    faultInjection: PaymentFaultType = 'NONE'
  ): Promise<ExecutionResult> {
    const { db } = getDb();

    // Check if intent is already executing or completed (repeated checkout attempt idempotency)
    const existing = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();
    if (!existing) {
      throw new StateConflictError(`Purchase intent '${intentId}' not found`);
    }

    if (existing.state === IntentStates.PAYMENT_CONFIRMED) {
      const existingLedger = db
        .select()
        .from(schema.spendLedger)
        .where(eq(schema.spendLedger.intent_id, intentId))
        .get();

      return {
        intent: existing as PurchaseIntent,
        ledgerId: existingLedger?.id,
        providerOrderId: existingLedger?.provider_order_id || undefined,
        providerPaymentId: existingLedger?.provider_payment_id || undefined,
        isMock: true,
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Repeated checkout: intent already confirmed',
      };
    }

    // Step 1: Claim intent and reserve budget atomically
    const { intent, ledgerId } = this.claimAndReserveAtomic(intentId, operatorId);

    // Step 2: Call Payment Adapter outside database transaction
    try {
      const orderResult = await this.paymentAdapter.createOrder({
        intentId: intent.id,
        amountPaise: intent.total_amount_paise,
        currency: intent.currency,
        merchantId: intent.merchant_id,
        description: `BoundPay Purchase Intent ${intent.id}`,
        fault: faultInjection,
      });

      if (!orderResult.success || !orderResult.orderId) {
        const nowIso = this.clock.nowIso();

        if (orderResult.status === 'UNKNOWN') {
          // Ambiguous failure (e.g. timeout): transition to UNKNOWN, keep reservation durable!
          db.update(schema.purchaseIntents)
            .set({
              state: IntentStates.UNKNOWN,
              failure_reason: orderResult.errorMessage || 'Unknown adapter response',
              updated_at: nowIso,
            })
            .where(eq(schema.purchaseIntents.id, intentId))
            .run();

          appendAuditEvent({
            eventType: 'ORDER_UNKNOWN',
            intentId,
            operatorId,
            amountPaise: intent.total_amount_paise,
            stateBefore: IntentStates.EXECUTING,
            stateAfter: IntentStates.UNKNOWN,
            payload: { error: orderResult.errorMessage, rawResponse: orderResult.rawResponse },
            clock: this.clock,
          });

          return {
            intent: { ...intent, state: IntentStates.UNKNOWN, updated_at: nowIso },
            ledgerId,
            isMock: true,
            success: false,
            status: IntentStates.UNKNOWN,
            message: orderResult.errorMessage || 'Order creation outcome uncertain; reservation held',
          };
        }

        // Definite rejection: mark intent BLOCKED, release reservation
        db.update(schema.purchaseIntents)
          .set({
            state: IntentStates.BLOCKED,
            failure_reason: orderResult.errorMessage || 'Payment provider rejected order',
            updated_at: nowIso,
          })
          .where(eq(schema.purchaseIntents.id, intentId))
          .run();

        db.update(schema.spendLedger)
          .set({ status: 'RELEASED' })
          .where(eq(schema.spendLedger.id, ledgerId))
          .run();

        appendAuditEvent({
          eventType: 'ORDER_REJECTED',
          intentId,
          operatorId,
          amountPaise: intent.total_amount_paise,
          stateBefore: IntentStates.EXECUTING,
          stateAfter: IntentStates.BLOCKED,
          payload: { error: orderResult.errorMessage, rawResponse: orderResult.rawResponse },
          clock: this.clock,
        });

        return {
          intent: { ...intent, state: IntentStates.BLOCKED, updated_at: nowIso },
          ledgerId,
          isMock: true,
          success: false,
          status: IntentStates.BLOCKED,
          message: orderResult.errorMessage || 'Order rejected by payment provider',
        };
      }

      // Order created successfully
      const providerOrderId = orderResult.orderId;
      const orderCreatedTimeIso = this.clock.nowIso();

      db.update(schema.purchaseIntents)
        .set({ state: IntentStates.ORDER_CREATED, updated_at: orderCreatedTimeIso })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      db.update(schema.spendLedger)
        .set({ provider_order_id: providerOrderId })
        .where(eq(schema.spendLedger.id, ledgerId))
        .run();

      appendAuditEvent({
        eventType: 'ORDER_CREATED',
        intentId,
        operatorId,
        amountPaise: intent.total_amount_paise,
        stateBefore: IntentStates.EXECUTING,
        stateAfter: IntentStates.ORDER_CREATED,
        payload: { providerOrderId, rawResponse: orderResult.rawResponse },
        clock: this.clock,
      });

      // Step 3: Capture / Confirm Payment
      const captureResult = await this.paymentAdapter.confirmCapture({
        orderId: providerOrderId,
        amountPaise: intent.total_amount_paise,
        currency: intent.currency,
        fault: faultInjection,
      });

      const confirmTimeIso = this.clock.nowIso();

      if (!captureResult.success || captureResult.status !== 'CAPTURED') {
        if (captureResult.status === 'PENDING') {
          appendAuditEvent({
            eventType: 'PAYMENT_PENDING',
            intentId,
            operatorId,
            amountPaise: intent.total_amount_paise,
            stateBefore: IntentStates.ORDER_CREATED,
            stateAfter: IntentStates.ORDER_CREATED,
            payload: { providerOrderId, reason: captureResult.errorMessage },
            clock: this.clock,
          });

          return {
            intent: { ...intent, state: IntentStates.ORDER_CREATED, updated_at: confirmTimeIso },
            ledgerId,
            providerOrderId,
            isMock: true,
            success: false,
            status: IntentStates.ORDER_CREATED,
            message: captureResult.errorMessage || 'Payment pending authorization',
          };
        }

        // Timeout or indeterminate capture -> UNKNOWN, reservation preserved
        db.update(schema.purchaseIntents)
          .set({
            state: IntentStates.UNKNOWN,
            failure_reason: captureResult.errorMessage || 'Capture outcome uncertain',
            updated_at: confirmTimeIso,
          })
          .where(eq(schema.purchaseIntents.id, intentId))
          .run();

        appendAuditEvent({
          eventType: 'PAYMENT_UNKNOWN',
          intentId,
          operatorId,
          amountPaise: intent.total_amount_paise,
          stateBefore: IntentStates.ORDER_CREATED,
          stateAfter: IntentStates.UNKNOWN,
          payload: { providerOrderId, error: captureResult.errorMessage },
          clock: this.clock,
        });

        return {
          intent: { ...intent, state: IntentStates.UNKNOWN, updated_at: confirmTimeIso },
          ledgerId,
          providerOrderId,
          isMock: true,
          success: false,
          status: IntentStates.UNKNOWN,
          message: captureResult.errorMessage || 'Payment confirmation timed out; reservation held',
        };
      }

      // Step 4: Capture Confirmed -> Convert Reservation to Confirmed Spend exactly once!
      const providerPaymentId = captureResult.paymentId || `mock_pay_${crypto.randomBytes(8).toString('hex')}`;

      db.update(schema.spendLedger)
        .set({
          status: 'CONFIRMED',
          confirmation_timestamp: confirmTimeIso,
          provider_payment_id: providerPaymentId,
        })
        .where(eq(schema.spendLedger.id, ledgerId))
        .run();

      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.PAYMENT_CONFIRMED,
          updated_at: confirmTimeIso,
        })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      appendAuditEvent({
        eventType: 'PAYMENT_CONFIRMED',
        intentId,
        operatorId,
        amountPaise: intent.total_amount_paise,
        stateBefore: IntentStates.ORDER_CREATED,
        stateAfter: IntentStates.PAYMENT_CONFIRMED,
        payload: {
          providerOrderId,
          providerPaymentId,
          ledgerId,
          isDuplicate: captureResult.isDuplicate,
          amountPaise: intent.total_amount_paise,
          confirmationTimestamp: confirmTimeIso,
        },
        clock: this.clock,
      });

      return {
        intent: {
          ...intent,
          state: IntentStates.PAYMENT_CONFIRMED,
          updated_at: confirmTimeIso,
        },
        ledgerId,
        providerOrderId,
        providerPaymentId,
        isMock: true,
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Payment confirmed successfully [MOCK_PAYMENT]',
      };
    } catch (err: any) {
      // Unhandled network exception during payment adapter call: mark UNKNOWN, preserve reservation!
      const errorTimeIso = this.clock.nowIso();
      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.UNKNOWN,
          failure_reason: err.message,
          updated_at: errorTimeIso,
        })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      appendAuditEvent({
        eventType: 'EXECUTION_EXCEPTION',
        intentId,
        operatorId,
        amountPaise: intent.total_amount_paise,
        stateBefore: IntentStates.EXECUTING,
        stateAfter: IntentStates.UNKNOWN,
        payload: { error: err.message },
        clock: this.clock,
      });

      return {
        intent: { ...intent, state: IntentStates.UNKNOWN, updated_at: errorTimeIso },
        ledgerId,
        isMock: true,
        success: false,
        status: IntentStates.UNKNOWN,
        message: `Adapter exception: ${err.message}; reservation held`,
      };
    }
  }
}

export const defaultExecutionService = new ExecutionService();
