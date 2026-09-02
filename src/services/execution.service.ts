import crypto from 'crypto';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import { IntentStates, assertValidTransition } from '../domain/state-machine';
import { PurchaseIntent } from '../domain/intent';
import { PaymentAdapter, PaymentFaultType } from '../infrastructure/payment/adapter.interface';
import { MockPaymentAdapter } from '../infrastructure/payment/mock-adapter';
import { RazorpayTestAdapter } from '../infrastructure/payment/razorpay-test-adapter';
import { Clock, defaultClock } from '../infrastructure/clock/clock';
import { getKolkataDayRange } from './policy.service';
import { appendAuditEvent } from './audit.service';

export interface ExecutionResult {
  intent: PurchaseIntent;
  ledgerId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  keyId?: string;
  isMock: boolean;
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
    private customAdapter?: PaymentAdapter,
    private clock: Clock = defaultClock
  ) {}

  /**
   * Retrieves the appropriate payment adapter for the given intent's payment mode.
   * Enforces isolation: never switches an intent's adapter midway through execution.
   */
  getAdapterForMode(mode: 'MOCK' | 'RAZORPAY_TEST'): PaymentAdapter {
    if (this.customAdapter) {
      return this.customAdapter;
    }
    if (mode === 'RAZORPAY_TEST') {
      const keyId = process.env.RAZORPAY_KEY_ID || '';
      const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
      return new RazorpayTestAdapter({ keyId, keySecret, webhookSecret });
    }
    return new MockPaymentAdapter();
  }

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
          eventType: 'QUOTE_EXPIRED',
          intentId,
          operatorId,
          amountPaise: intentRow.total_amount_paise,
          stateBefore: intentRow.state,
          stateAfter: IntentStates.EXPIRED,
          payload: { quoteExpiry: intentRow.quote_expiry, attemptedAt: nowIso },
          clock: this.clock,
        });

        throw new QuoteRevalidationError('Quote validity window has expired. Re-proposal required.');
      }

      // 3. Revalidate Product Version
      const currentProduct = db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, intentRow.product_id))
        .get();

      if (!currentProduct || !currentProduct.is_active || currentProduct.version !== intentRow.product_version) {
        db.update(schema.purchaseIntents)
          .set({
            state: IntentStates.EXPIRED,
            failure_reason: 'Catalog product was updated or deactivated prior to execution',
            updated_at: nowIso,
          })
          .where(eq(schema.purchaseIntents.id, intentId))
          .run();

        appendAuditEvent({
          eventType: 'PRODUCT_VERSION_MISMATCH',
          intentId,
          operatorId,
          amountPaise: intentRow.total_amount_paise,
          stateBefore: intentRow.state,
          stateAfter: IntentStates.EXPIRED,
          payload: { intentProductVersion: intentRow.product_version, currentProductVersion: currentProduct?.version },
          clock: this.clock,
        });

        throw new QuoteRevalidationError('Catalog product price or attributes modified after proposal; new proposal and authorization required');
      }

      // 4. Revalidate Policy Version
      const latestPolicy = db
        .select()
        .from(schema.policies)
        .orderBy(schema.policies.version)
        .all()
        .pop();

      if (!latestPolicy || nowIso >= latestPolicy.expires_at || latestPolicy.version !== intentRow.policy_version) {
        db.update(schema.purchaseIntents)
          .set({
            state: IntentStates.EXPIRED,
            failure_reason: 'Standing spending policy was updated or revoked prior to execution',
            updated_at: nowIso,
          })
          .where(eq(schema.purchaseIntents.id, intentId))
          .run();

        appendAuditEvent({
          eventType: 'POLICY_VERSION_MISMATCH',
          intentId,
          operatorId,
          amountPaise: intentRow.total_amount_paise,
          stateBefore: intentRow.state,
          stateAfter: IntentStates.EXPIRED,
          payload: { intentPolicyVersion: intentRow.policy_version, currentPolicyVersion: latestPolicy?.version },
          clock: this.clock,
        });

        throw new QuoteRevalidationError('Spending policy modified after proposal; new proposal and authorization required');
      }

      // 5. Revalidate Approval Binding if state was APPROVED
      if (intentRow.state === IntentStates.APPROVED) {
        const approval = db
          .select()
          .from(schema.intentApprovals)
          .where(
            and(
              eq(schema.intentApprovals.intent_id, intentId),
              eq(schema.intentApprovals.status, 'APPROVED')
            )
          )
          .get();

        if (!approval || approval.canonical_hash !== intentRow.canonical_request_hash) {
          throw new QuoteRevalidationError(
            'Exact intent approval signature does not match canonical intent hash. Execution aborted.'
          );
        }
      }

      // 6. Check Daily Budget Invariant
      const confirmedTodayRows = db
        .select()
        .from(schema.spendLedger)
        .where(
          and(
            eq(schema.spendLedger.status, 'CONFIRMED'),
            gte(schema.spendLedger.confirmation_timestamp, startIso),
            lte(schema.spendLedger.confirmation_timestamp, endIso),
            eq(schema.spendLedger.payment_adapter_mode, intentRow.payment_adapter_mode)
          )
        )
        .all();

      const confirmedTodayPaise = confirmedTodayRows.reduce((sum, r) => sum + r.amount_paise, 0);

      const activeReservationRows = db
        .select()
        .from(schema.spendLedger)
        .where(
          and(
            eq(schema.spendLedger.status, 'RESERVED'),
            eq(schema.spendLedger.payment_adapter_mode, intentRow.payment_adapter_mode)
          )
        )
        .all();

      const activeReservationsPaise = activeReservationRows.reduce((sum, r) => sum + r.amount_paise, 0);

      const projectedTotalPaise = confirmedTodayPaise + activeReservationsPaise + intentRow.total_amount_paise;

      if (projectedTotalPaise > latestPolicy.daily_budget_paise) {
        throw new BudgetExceededError(
          `Execution exceeds daily budget. Projected: ${projectedTotalPaise} paise, Daily Budget: ${latestPolicy.daily_budget_paise} paise`
        );
      }

      // 7. Atomic Write: Create Spend Ledger Reservation and Transition Intent to EXECUTING
      assertValidTransition(intentRow.state, IntentStates.EXECUTING);

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

      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.EXECUTING,
          updated_at: nowIso,
        })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      appendAuditEvent({
        eventType: 'INTENT_EXECUTING',
        intentId,
        operatorId,
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
   * Executes or dispatches the purchase flow:
   * 1. Atomic claim & reservation
   * 2. Call Payment Adapter outside DB transaction to create order
   * 3. In MOCK mode: immediately attempts mock capture
   * 4. In RAZORPAY_TEST mode: transitions to ORDER_CREATED and yields order details for client checkout
   */
  async executeIntent(
    intentId: string,
    operatorId: string,
    faultInjection: PaymentFaultType = 'NONE'
  ): Promise<ExecutionResult> {
    const { db } = getDb();

    // Check if intent is already confirmed (repeated checkout attempt idempotency)
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
        providerOrderId: existing.provider_order_id || existingLedger?.provider_order_id || undefined,
        providerPaymentId: existing.provider_payment_id || existingLedger?.provider_payment_id || undefined,
        isMock: existing.payment_adapter_mode === 'MOCK',
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Repeated checkout: intent already confirmed',
      };
    }

    // If intent already in ORDER_CREATED in RAZORPAY_TEST mode, return existing order
    if (existing.state === IntentStates.ORDER_CREATED && existing.payment_adapter_mode === 'RAZORPAY_TEST') {
      const adapter = this.getAdapterForMode('RAZORPAY_TEST');
      const keyId = adapter instanceof RazorpayTestAdapter ? adapter.getPublicClientKeyId() : undefined;
      return {
        intent: existing as PurchaseIntent,
        providerOrderId: existing.provider_order_id || undefined,
        keyId,
        isMock: false,
        success: true,
        status: IntentStates.ORDER_CREATED,
        message: 'Order already created; awaiting standard checkout completion',
      };
    }

    // Step 1: Claim intent and reserve budget atomically
    const { intent, ledgerId } = this.claimAndReserveAtomic(intentId, operatorId);
    const adapter = this.getAdapterForMode(intent.payment_adapter_mode);

    // Step 2: Call Payment Adapter outside database transaction
    try {
      const orderResult = await adapter.createOrder({
        intentId: intent.id,
        amountPaise: intent.total_amount_paise,
        currency: intent.currency,
        merchantId: intent.merchant_id,
        description: `BoundPay Purchase Intent ${intent.id}`,
        receipt: intent.receipt || `rcpt_${intent.id.replace(/-/g, '').substring(0, 16)}`,
        fault: faultInjection,
      });

      if (!orderResult.success || !orderResult.orderId) {
        const nowIso = this.clock.nowIso();

        if (orderResult.status === 'UNKNOWN') {
          // Ambiguous failure (e.g. timeout): transition to UNKNOWN, keep reservation durable!
          db.update(schema.purchaseIntents)
            .set({
              state: IntentStates.UNKNOWN,
              failure_reason: orderResult.errorMessage || 'Unknown adapter response during order creation',
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
            isMock: orderResult.isMock,
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
          isMock: orderResult.isMock,
          success: false,
          status: IntentStates.BLOCKED,
          message: orderResult.errorMessage || 'Order rejected by payment provider',
        };
      }

      // Order created successfully
      const providerOrderId = orderResult.orderId;
      const orderCreatedTimeIso = this.clock.nowIso();

      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.ORDER_CREATED,
          provider_order_id: providerOrderId,
          updated_at: orderCreatedTimeIso,
        })
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

      // If Razorpay Test mode: stop here and let client complete standard checkout
      if (intent.payment_adapter_mode === 'RAZORPAY_TEST') {
        // Check for any unmatched webhook events that arrived prior to order saving
        this.reconcileUnmatchedWebhooksForOrder(providerOrderId);

        const freshIntent = db
          .select()
          .from(schema.purchaseIntents)
          .where(eq(schema.purchaseIntents.id, intentId))
          .get() as PurchaseIntent;

        return {
          intent: freshIntent,
          ledgerId,
          providerOrderId,
          keyId: orderResult.keyId,
          isMock: false,
          success: true,
          status: freshIntent.state,
          message: 'Razorpay order created; awaiting standard checkout completion',
        };
      }

      // In MOCK mode: proceed directly to mock capture
      const captureResult = await adapter.confirmCapture({
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

      // Convert Reservation to Confirmed Spend exactly once
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
          provider_payment_id: providerPaymentId,
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
        payload: { providerOrderId, providerPaymentId, captureResult: captureResult.rawResponse },
        clock: this.clock,
      });

      return {
        intent: {
          ...intent,
          state: IntentStates.PAYMENT_CONFIRMED,
          provider_order_id: providerOrderId,
          provider_payment_id: providerPaymentId,
          updated_at: confirmTimeIso,
        },
        ledgerId,
        providerOrderId,
        providerPaymentId,
        isMock: true,
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Payment confirmed successfully',
      };
    } catch (err: any) {
      // Process error outside DB tx
      return {
        intent: { ...intent, state: IntentStates.UNKNOWN, updated_at: this.clock.nowIso() },
        ledgerId,
        isMock: intent.payment_adapter_mode === 'MOCK',
        success: false,
        status: IntentStates.UNKNOWN,
        message: `Execution error: ${err.message}`,
      };
    }
  }

  /**
   * Verifies Razorpay Standard Checkout callback and finalizes payment.
   */
  async confirmPaymentCapture(
    intentId: string,
    operatorId: string,
    params: { paymentId: string; signature: string; orderId: string }
  ): Promise<ExecutionResult> {
    const { db } = getDb();
    const intent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();

    if (!intent) {
      throw new StateConflictError(`Purchase intent '${intentId}' not found`);
    }

    if (intent.owner_id !== operatorId) {
      throw new StateConflictError('Unauthorized: operator does not own this intent');
    }

    // Idempotency: if already confirmed, return existing success
    if (intent.state === IntentStates.PAYMENT_CONFIRMED) {
      return {
        intent: intent as PurchaseIntent,
        providerOrderId: intent.provider_order_id || params.orderId,
        providerPaymentId: intent.provider_payment_id || params.paymentId,
        isMock: intent.payment_adapter_mode === 'MOCK',
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Payment already confirmed',
      };
    }

    if (intent.state !== IntentStates.ORDER_CREATED && intent.state !== IntentStates.UNKNOWN) {
      throw new StateConflictError(
        `Intent is in state '${intent.state}', cannot confirm payment (expected ORDER_CREATED)`
      );
    }

    // Check that client-supplied orderId matches server-persisted order ID
    if (intent.provider_order_id && intent.provider_order_id !== params.orderId) {
      throw new StateConflictError(
        `Order ID mismatch: intent has '${intent.provider_order_id}' but received '${params.orderId}'`
      );
    }

    const adapter = this.getAdapterForMode(intent.payment_adapter_mode as 'MOCK' | 'RAZORPAY_TEST');

    const captureResult = await adapter.confirmCapture({
      orderId: intent.provider_order_id || params.orderId,
      paymentId: params.paymentId,
      signature: params.signature,
      amountPaise: intent.total_amount_paise,
      currency: intent.currency,
    });

    const nowIso = this.clock.nowIso();

    if (!captureResult.success || captureResult.status !== 'CAPTURED') {
      if (captureResult.status === 'PENDING') {
        return {
          intent: intent as PurchaseIntent,
          providerOrderId: intent.provider_order_id || params.orderId,
          isMock: captureResult.isMock,
          success: false,
          status: IntentStates.ORDER_CREATED,
          message: captureResult.errorMessage || 'Payment pending authorization',
        };
      }

      // Verification failure: do not mark confirmed
      appendAuditEvent({
        eventType: 'PAYMENT_VERIFICATION_FAILED',
        intentId,
        operatorId,
        amountPaise: intent.total_amount_paise,
        stateBefore: intent.state,
        stateAfter: intent.state,
        payload: { error: captureResult.errorMessage, params },
        clock: this.clock,
      });

      return {
        intent: intent as PurchaseIntent,
        providerOrderId: intent.provider_order_id || params.orderId,
        isMock: captureResult.isMock,
        success: false,
        status: intent.state,
        message: captureResult.errorMessage || 'Payment signature verification or capture check failed',
      };
    }

    // Verified & Captured! Finalize confirmation atomically in SQLite
    const ledger = db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.intent_id, intentId))
      .get();

    if (ledger) {
      db.update(schema.spendLedger)
        .set({
          status: 'CONFIRMED',
          confirmation_timestamp: nowIso,
          provider_order_id: params.orderId,
          provider_payment_id: params.paymentId,
        })
        .where(eq(schema.spendLedger.id, ledger.id))
        .run();
    }

    db.update(schema.purchaseIntents)
      .set({
        state: IntentStates.PAYMENT_CONFIRMED,
        provider_order_id: params.orderId,
        provider_payment_id: params.paymentId,
        updated_at: nowIso,
      })
      .where(eq(schema.purchaseIntents.id, intentId))
      .run();

    appendAuditEvent({
      eventType: 'PAYMENT_CONFIRMED',
      intentId,
      operatorId,
      amountPaise: intent.total_amount_paise,
      stateBefore: intent.state,
      stateAfter: IntentStates.PAYMENT_CONFIRMED,
      payload: {
        providerOrderId: params.orderId,
        providerPaymentId: params.paymentId,
        verifiedVia: 'CHECKOUT_CALLBACK',
      },
      clock: this.clock,
    });

    const updated = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get()!;

    return {
      intent: updated as PurchaseIntent,
      providerOrderId: params.orderId,
      providerPaymentId: params.paymentId,
      isMock: captureResult.isMock,
      success: true,
      status: IntentStates.PAYMENT_CONFIRMED,
      message: 'Payment verified and confirmed via Razorpay checkout callback',
    };
  }

  /**
   * Refreshes payment status from provider for an order.
   * Useful when browser callback was missed or delayed. Never creates a new order.
   */
  async refreshPaymentStatus(intentId: string, operatorId: string): Promise<ExecutionResult> {
    const { db } = getDb();
    const intent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();

    if (!intent) {
      throw new StateConflictError(`Purchase intent '${intentId}' not found`);
    }

    if (intent.owner_id !== operatorId) {
      throw new StateConflictError('Unauthorized: operator does not own this intent');
    }

    if (intent.state === IntentStates.PAYMENT_CONFIRMED) {
      return {
        intent: intent as PurchaseIntent,
        providerOrderId: intent.provider_order_id || undefined,
        providerPaymentId: intent.provider_payment_id || undefined,
        isMock: intent.payment_adapter_mode === 'MOCK',
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Payment already confirmed',
      };
    }

    if (!intent.provider_order_id) {
      return {
        intent: intent as PurchaseIntent,
        isMock: intent.payment_adapter_mode === 'MOCK',
        success: false,
        status: intent.state,
        message: 'No provider order ID found on intent to refresh',
      };
    }

    const adapter = this.getAdapterForMode(intent.payment_adapter_mode as 'MOCK' | 'RAZORPAY_TEST');
    const statusResult = await adapter.getOrderStatus(intent.provider_order_id);
    const nowIso = this.clock.nowIso();

    if (statusResult.status === 'CAPTURED') {
      const paymentId = statusResult.paymentId || `prov_pay_${Date.now()}`;

      const ledger = db
        .select()
        .from(schema.spendLedger)
        .where(eq(schema.spendLedger.intent_id, intentId))
        .get();

      if (ledger) {
        db.update(schema.spendLedger)
          .set({
            status: 'CONFIRMED',
            confirmation_timestamp: nowIso,
            provider_payment_id: paymentId,
          })
          .where(eq(schema.spendLedger.id, ledger.id))
          .run();
      }

      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.PAYMENT_CONFIRMED,
          provider_payment_id: paymentId,
          updated_at: nowIso,
        })
        .where(eq(schema.purchaseIntents.id, intentId))
        .run();

      appendAuditEvent({
        eventType: 'PAYMENT_CONFIRMED',
        intentId,
        operatorId,
        amountPaise: intent.total_amount_paise,
        stateBefore: intent.state,
        stateAfter: IntentStates.PAYMENT_CONFIRMED,
        payload: {
          providerOrderId: intent.provider_order_id,
          providerPaymentId: paymentId,
          verifiedVia: 'STATUS_REFRESH',
        },
        clock: this.clock,
      });

      const updated = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get()!;

      return {
        intent: updated as PurchaseIntent,
        providerOrderId: intent.provider_order_id,
        providerPaymentId: paymentId,
        isMock: statusResult.isMock,
        success: true,
        status: IntentStates.PAYMENT_CONFIRMED,
        message: 'Payment verified and confirmed via provider status refresh',
      };
    }

    return {
      intent: intent as PurchaseIntent,
      providerOrderId: intent.provider_order_id,
      isMock: statusResult.isMock,
      success: false,
      status: intent.state,
      message: `Provider order status is currently '${statusResult.status}'`,
    };
  }

  /**
   * Reconciles uncertain intents by checking provider by receipt.
   */
  async reconcileUncertainIntent(intentId: string, operatorId: string): Promise<ExecutionResult> {
    const { db } = getDb();
    const intent = db.select().from(schema.purchaseIntents).where(eq(schema.purchaseIntents.id, intentId)).get();

    if (!intent) {
      throw new StateConflictError(`Purchase intent '${intentId}' not found`);
    }

    if (intent.owner_id !== operatorId) {
      throw new StateConflictError('Unauthorized');
    }

    const adapter = this.getAdapterForMode(intent.payment_adapter_mode as 'MOCK' | 'RAZORPAY_TEST');

    if (adapter.reconcileOrderByReceipt && intent.receipt) {
      const reconciled = await adapter.reconcileOrderByReceipt(intent.receipt);
      if (reconciled && reconciled.status === 'CAPTURED') {
        return this.refreshPaymentStatus(intentId, operatorId);
      }
    }

    return {
      intent: intent as PurchaseIntent,
      isMock: intent.payment_adapter_mode === 'MOCK',
      success: false,
      status: intent.state,
      message: 'Reconciliation checked: no matching captured order found on provider',
    };
  }

  /**
   * Reconciles any unmatched webhook events that were received before order was saved.
   */
  private reconcileUnmatchedWebhooksForOrder(orderId: string): void {
    const { db } = getDb();
    const unmatched = db
      .select()
      .from(schema.webhookEvents)
      .where(
        and(
          eq(schema.webhookEvents.order_id, orderId),
          eq(schema.webhookEvents.status, 'UNMATCHED')
        )
      )
      .all();

    for (const evt of unmatched) {
      try {
        const intent = db
          .select()
          .from(schema.purchaseIntents)
          .where(eq(schema.purchaseIntents.provider_order_id, orderId))
          .get();

        if (intent && intent.state !== IntentStates.PAYMENT_CONFIRMED) {
          const nowIso = this.clock.nowIso();
          const paymentId = evt.payment_id || `pay_${Date.now()}`;

          const ledger = db
            .select()
            .from(schema.spendLedger)
            .where(eq(schema.spendLedger.intent_id, intent.id))
            .get();

          if (ledger) {
            db.update(schema.spendLedger)
              .set({
                status: 'CONFIRMED',
                confirmation_timestamp: nowIso,
                provider_payment_id: paymentId,
              })
              .where(eq(schema.spendLedger.id, ledger.id))
              .run();
          }

          db.update(schema.purchaseIntents)
            .set({
              state: IntentStates.PAYMENT_CONFIRMED,
              provider_payment_id: paymentId,
              updated_at: nowIso,
            })
            .where(eq(schema.purchaseIntents.id, intent.id))
            .run();

          db.update(schema.webhookEvents)
            .set({ status: 'PROCESSED', processed_at: nowIso })
            .where(eq(schema.webhookEvents.id, evt.id))
            .run();

          appendAuditEvent({
            eventType: 'PAYMENT_CONFIRMED',
            intentId: intent.id,
            operatorId: intent.owner_id,
            amountPaise: intent.total_amount_paise,
            stateBefore: intent.state,
            stateAfter: IntentStates.PAYMENT_CONFIRMED,
            payload: { providerOrderId: orderId, providerPaymentId: paymentId, reconciledFromWebhook: evt.id },
            clock: this.clock,
          });
        }
      } catch {}
    }
  }

  /**
   * Dedicated Webhook processor for Razorpay events.
   */
  async handleRazorpayWebhook(
    rawBody: string,
    signature: string,
    eventIdHeader?: string
  ): Promise<{ status: string; processed: boolean; reason?: string }> {
    const adapter = this.getAdapterForMode('RAZORPAY_TEST');

    if (!adapter.verifyWebhookSignature || !adapter.verifyWebhookSignature(rawBody, signature)) {
      return { status: 'INVALID_SIGNATURE', processed: false, reason: 'HMAC signature verification failed' };
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 'MALFORMED_JSON', processed: false, reason: 'Invalid JSON body' };
    }

    const { db } = getDb();
    const eventId = eventIdHeader || payload.id || `evt_${crypto.randomUUID()}`;
    const eventType = payload.event || 'unknown';

    // Deduplicate event by (provider, event_id)
    const existingEvent = db
      .select()
      .from(schema.webhookEvents)
      .where(
        and(
          eq(schema.webhookEvents.provider, 'RAZORPAY'),
          eq(schema.webhookEvents.event_id, eventId)
        )
      )
      .get();

    if (existingEvent) {
      return { status: 'ALREADY_PROCESSED', processed: true, reason: 'Duplicate event ID ignored' };
    }

    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const orderId = paymentEntity?.order_id || orderEntity?.id || null;
    const paymentId = paymentEntity?.id || null;
    const nowIso = this.clock.nowIso();

    const webhookRecordId = crypto.randomUUID();

    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      if (!orderId) {
        db.insert(schema.webhookEvents).values({
          id: webhookRecordId,
          provider: 'RAZORPAY',
          event_id: eventId,
          event_type: eventType,
          intent_id: null,
          order_id: null,
          payment_id: paymentId,
          payload_json: rawBody,
          status: 'IGNORED',
          received_at: nowIso,
          processed_at: nowIso,
        }).run();

        return { status: 'IGNORED', processed: false, reason: 'No order ID in payment event' };
      }

      // Look up intent by provider_order_id
      const intent = db
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.provider_order_id, orderId))
        .get();

      if (!intent) {
        // Webhook arrived before order response was persisted! Retain as UNMATCHED!
        db.insert(schema.webhookEvents).values({
          id: webhookRecordId,
          provider: 'RAZORPAY',
          event_id: eventId,
          event_type: eventType,
          intent_id: null,
          order_id: orderId,
          payment_id: paymentId,
          payload_json: rawBody,
          status: 'UNMATCHED',
          received_at: nowIso,
          processed_at: null,
        }).run();

        return { status: 'RETAINED_UNMATCHED', processed: true, reason: 'Order not yet persisted; retained for reconciliation' };
      }

      // Verify amount and currency match intent
      if (paymentEntity) {
        if (paymentEntity.amount !== intent.total_amount_paise || paymentEntity.currency !== intent.currency) {
          db.insert(schema.webhookEvents).values({
            id: webhookRecordId,
            provider: 'RAZORPAY',
            event_id: eventId,
            event_type: eventType,
            intent_id: intent.id,
            order_id: orderId,
            payment_id: paymentId,
            payload_json: rawBody,
            status: 'IGNORED',
            received_at: nowIso,
            processed_at: nowIso,
          }).run();

          return { status: 'MISMATCHED_AMOUNT', processed: false, reason: 'Payment amount or currency does not match intent' };
        }
      }

      // If intent already confirmed, mark webhook PROCESSED (idempotent no-op)
      if (intent.state === IntentStates.PAYMENT_CONFIRMED) {
        db.insert(schema.webhookEvents).values({
          id: webhookRecordId,
          provider: 'RAZORPAY',
          event_id: eventId,
          event_type: eventType,
          intent_id: intent.id,
          order_id: orderId,
          payment_id: paymentId,
          payload_json: rawBody,
          status: 'PROCESSED',
          received_at: nowIso,
          processed_at: nowIso,
        }).run();

        return { status: 'ALREADY_CONFIRMED', processed: true };
      }

      // Confirm payment from webhook
      const ledger = db
        .select()
        .from(schema.spendLedger)
        .where(eq(schema.spendLedger.intent_id, intent.id))
        .get();

      if (ledger) {
        db.update(schema.spendLedger)
          .set({
            status: 'CONFIRMED',
            confirmation_timestamp: nowIso,
            provider_payment_id: paymentId,
          })
          .where(eq(schema.spendLedger.id, ledger.id))
          .run();
      }

      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.PAYMENT_CONFIRMED,
          provider_payment_id: paymentId,
          updated_at: nowIso,
        })
        .where(eq(schema.purchaseIntents.id, intent.id))
        .run();

      db.insert(schema.webhookEvents).values({
        id: webhookRecordId,
        provider: 'RAZORPAY',
        event_id: eventId,
        event_type: eventType,
        intent_id: intent.id,
        order_id: orderId,
        payment_id: paymentId,
        payload_json: rawBody,
        status: 'PROCESSED',
        received_at: nowIso,
        processed_at: nowIso,
      }).run();

      appendAuditEvent({
        eventType: 'PAYMENT_CONFIRMED',
        intentId: intent.id,
        operatorId: intent.owner_id,
        amountPaise: intent.total_amount_paise,
        stateBefore: intent.state,
        stateAfter: IntentStates.PAYMENT_CONFIRMED,
        payload: {
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          verifiedVia: 'WEBHOOK',
          eventId,
        },
        clock: this.clock,
      });

      return { status: 'CONFIRMED_FROM_WEBHOOK', processed: true };
    }

    // Other events (e.g. payment.failed)
    db.insert(schema.webhookEvents).values({
      id: webhookRecordId,
      provider: 'RAZORPAY',
      event_id: eventId,
      event_type: eventType,
      intent_id: null,
      order_id: orderId,
      payment_id: paymentId,
      payload_json: rawBody,
      status: 'PROCESSED',
      received_at: nowIso,
      processed_at: nowIso,
    }).run();

    return { status: 'EVENT_LOGGED', processed: true };
  }

  /**
   * Recovers stale EXECUTING intents after a process restart without auto-retrying orders.
   */
  recoverStaleExecutingIntents(maxAgeSeconds = 300): number {
    const { db } = getDb();
    const thresholdIso = new Date(this.clock.now().getTime() - maxAgeSeconds * 1000).toISOString();

    const staleIntents = db
      .select()
      .from(schema.purchaseIntents)
      .where(
        and(
          eq(schema.purchaseIntents.state, IntentStates.EXECUTING),
          lte(schema.purchaseIntents.updated_at, thresholdIso)
        )
      )
      .all();

    for (const intent of staleIntents) {
      db.update(schema.purchaseIntents)
        .set({
          state: IntentStates.UNKNOWN,
          failure_reason: 'Process crash or timeout during execution dispatch; reservation preserved for audit',
          updated_at: this.clock.nowIso(),
        })
        .where(eq(schema.purchaseIntents.id, intent.id))
        .run();

      appendAuditEvent({
        eventType: 'CRASH_RECOVERY_UNKNOWN',
        intentId: intent.id,
        operatorId: intent.owner_id,
        amountPaise: intent.total_amount_paise,
        stateBefore: IntentStates.EXECUTING,
        stateAfter: IntentStates.UNKNOWN,
        payload: { recoveredAt: this.clock.nowIso(), lastUpdated: intent.updated_at },
        clock: this.clock,
      });
    }

    return staleIntents.length;
  }
}

export const defaultExecutionService = new ExecutionService();
