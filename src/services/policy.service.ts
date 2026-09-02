import crypto from 'crypto';
import { desc, eq, and, gte, lte } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import { PolicyUpdateInput, PolicyUpdateSchema, SpendingPolicy, DEFAULT_POLICY } from '../domain/policy';
import { Clock, defaultClock } from '../infrastructure/clock/clock';
import { appendAuditEvent } from './audit.service';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function getKolkataDayRange(date: Date = new Date()): { startIso: string; endIso: string } {
  const istTime = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istTime.getUTCFullYear();
  const month = istTime.getUTCMonth();
  const day = istTime.getUTCDate();

  const startUtc = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endUtc = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - IST_OFFSET_MS);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
  };
}

export function getCurrentPolicy(): SpendingPolicy {
  const { db } = getDb();
  const row = db
    .select()
    .from(schema.policies)
    .orderBy(desc(schema.policies.version))
    .limit(1)
    .get();

  if (!row) {
    throw new Error('No spending policy found in database');
  }

  return {
    id: row.id,
    version: row.version,
    currency: 'INR',
    max_transaction_amount_paise: row.max_transaction_amount_paise,
    daily_budget_paise: row.daily_budget_paise,
    approval_threshold_paise: row.approval_threshold_paise,
    allowed_categories: JSON.parse(row.allowed_categories_json),
    approved_merchant_id: row.approved_merchant_id,
    allow_subscriptions: row.allow_subscriptions,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

export interface DailyBudgetUsage {
  dailyBudgetPaise: number;
  confirmedSpendTodayPaise: number;
  activeReservationsPaise: number;
  totalCommittedPaise: number;
  remainingDailyBudgetPaise: number;
  dayStartIso: string;
  dayEndIso: string;
}

export function getDailyBudgetUsage(
  paymentAdapterMode: string = 'MOCK',
  clock: Clock = defaultClock,
  policy?: SpendingPolicy
): DailyBudgetUsage {
  const { db } = getDb();
  const activePolicy = policy || getCurrentPolicy();
  const { startIso, endIso } = getKolkataDayRange(clock.now());

  // 1. Confirmed spend in current Asia/Kolkata day
  const confirmedRows = db
    .select({ amount: schema.spendLedger.amount_paise })
    .from(schema.spendLedger)
    .where(
      and(
        eq(schema.spendLedger.status, 'CONFIRMED'),
        eq(schema.spendLedger.payment_adapter_mode, paymentAdapterMode),
        gte(schema.spendLedger.confirmation_timestamp, startIso),
        lte(schema.spendLedger.confirmation_timestamp, endIso)
      )
    )
    .all();

  const confirmedSpendTodayPaise = confirmedRows.reduce((sum, r) => sum + r.amount, 0);

  // 2. Active reservations regardless of creation day
  const reservedRows = db
    .select({ amount: schema.spendLedger.amount_paise })
    .from(schema.spendLedger)
    .where(
      and(
        eq(schema.spendLedger.status, 'RESERVED'),
        eq(schema.spendLedger.payment_adapter_mode, paymentAdapterMode)
      )
    )
    .all();

  const activeReservationsPaise = reservedRows.reduce((sum, r) => sum + r.amount, 0);
  const totalCommittedPaise = confirmedSpendTodayPaise + activeReservationsPaise;
  const remainingDailyBudgetPaise = Math.max(0, activePolicy.daily_budget_paise - totalCommittedPaise);

  return {
    dailyBudgetPaise: activePolicy.daily_budget_paise,
    confirmedSpendTodayPaise,
    activeReservationsPaise,
    totalCommittedPaise,
    remainingDailyBudgetPaise,
    dayStartIso: startIso,
    dayEndIso: endIso,
  };
}

export function updatePolicy(
  input: PolicyUpdateInput,
  operatorId: string,
  clock: Clock = defaultClock
): SpendingPolicy {
  const validated = PolicyUpdateSchema.parse(input);
  const current = getCurrentPolicy();
  const { db } = getDb();

  // Validate that daily budget reduction does not violate committed spend
  // Accounting is isolated by adapter mode, but a single policy governs both
  // namespaces. A reduction must be safe for whichever namespace currently has
  // the larger commitment; checking MOCK alone could strand Razorpay TEST spend
  // above the newly published budget.
  const mockUsage = getDailyBudgetUsage('MOCK', clock, current);
  const razorpayTestUsage = getDailyBudgetUsage('RAZORPAY_TEST', clock, current);
  const highestCommittedPaise = Math.max(
    mockUsage.totalCommittedPaise,
    razorpayTestUsage.totalCommittedPaise
  );
  if (validated.daily_budget_paise < highestCommittedPaise) {
    throw new Error(
      `Cannot reduce daily budget to ${validated.daily_budget_paise} paise: an adapter mode already has ${highestCommittedPaise} paise committed`
    );
  }

  const nowIso = clock.nowIso();
  const nextVersion = current.version + 1;
  const newPolicyId = crypto.randomUUID();

  db.insert(schema.policies).values({
    id: newPolicyId,
    version: nextVersion,
    currency: 'INR',
    max_transaction_amount_paise: validated.max_transaction_amount_paise,
    daily_budget_paise: validated.daily_budget_paise,
    approval_threshold_paise: validated.approval_threshold_paise,
    allowed_categories_json: JSON.stringify(validated.allowed_categories),
    approved_merchant_id: validated.approved_merchant_id,
    allow_subscriptions: validated.allow_subscriptions,
    expires_at: validated.expires_at,
    created_at: nowIso,
  }).run();

  const updatedPolicy: SpendingPolicy = {
    id: newPolicyId,
    version: nextVersion,
    currency: 'INR',
    max_transaction_amount_paise: validated.max_transaction_amount_paise,
    daily_budget_paise: validated.daily_budget_paise,
    approval_threshold_paise: validated.approval_threshold_paise,
    allowed_categories: validated.allowed_categories,
    approved_merchant_id: validated.approved_merchant_id,
    allow_subscriptions: validated.allow_subscriptions,
    expires_at: validated.expires_at,
    created_at: nowIso,
  };

  appendAuditEvent({
    eventType: 'POLICY_UPDATED',
    operatorId,
    policyVersion: nextVersion,
    payload: {
      previousVersion: current.version,
      newVersion: nextVersion,
      newPolicy: updatedPolicy,
    },
    clock,
  });

  return updatedPolicy;
}
