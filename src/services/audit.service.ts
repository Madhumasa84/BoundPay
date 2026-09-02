import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../infrastructure/db';
import { Clock, defaultClock } from '../infrastructure/clock/clock';

export interface CreateAuditEventParams {
  eventType: string;
  intentId?: string | null;
  operatorId?: string | null;
  policyVersion?: number | null;
  amountPaise?: number | null;
  stateBefore?: string | null;
  stateAfter?: string | null;
  payload: Record<string, unknown>;
  clock?: Clock;
}

export function appendAuditEvent(params: CreateAuditEventParams): number {
  const { db } = getDb();
  const clock = params.clock || defaultClock;
  const timestamp = clock.nowIso();

  const inserted = db
    .insert(schema.auditEvents)
    .values({
      timestamp,
      event_type: params.eventType,
      intent_id: params.intentId || null,
      operator_id: params.operatorId || null,
      policy_version: params.policyVersion || null,
      amount_paise: params.amountPaise || null,
      state_before: params.stateBefore || null,
      state_after: params.stateAfter || null,
      payload_json: JSON.stringify(params.payload),
    })
    .returning({ id: schema.auditEvents.id })
    .get();

  return inserted.id;
}

export function getAuditEvents(limit = 100, offset = 0) {
  const { db } = getDb();
  return db
    .select()
    .from(schema.auditEvents)
    .orderBy(desc(schema.auditEvents.id))
    .limit(limit)
    .offset(offset)
    .all();
}

export function exportAllAuditEvents() {
  const { db } = getDb();
  const events = db
    .select()
    .from(schema.auditEvents)
    .orderBy(schema.auditEvents.id)
    .all();

  return {
    exported_at: new Date().toISOString(),
    total_events: events.length,
    events: events.map((e) => ({
      ...e,
      payload: JSON.parse(e.payload_json),
    })),
  };
}
