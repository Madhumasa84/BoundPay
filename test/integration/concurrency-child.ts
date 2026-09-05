/** Actual OS-child-process execution harness with an independent SQLite connection. */
import { ExecutionService } from '@/services/execution.service';
import { MockPaymentAdapter } from '@/infrastructure/payment/mock-adapter';
import { TestClock } from '@/infrastructure/clock/clock';
import { closeDefaultDb } from '@/infrastructure/db';

const intentId = process.env.CHILD_INTENT_ID || '';
const operatorId = process.env.CHILD_OPERATOR_ID || '';

process.send?.({ type: 'ready' });
process.once('message', async (message) => {
  if (message !== 'start') return;
  try {
    closeDefaultDb();
    const service = new ExecutionService(new MockPaymentAdapter(), new TestClock('2026-09-03T12:00:00.000Z'));
    const result = await service.executeIntent(intentId, operatorId);
    closeDefaultDb();
    process.send?.({ type: 'result', outcome: 'SUCCESS', status: result.status });
  } catch (error) {
    try { closeDefaultDb(); } catch {}
    const name = error instanceof Error ? error.name : 'Error';
    const outcome = name === 'BudgetExceededError' ? 'BUDGET_EXCEEDED'
      : name === 'StateConflictError' ? 'STATE_CONFLICT'
      : name === 'QuoteRevalidationError' ? 'QUOTE_REVALIDATION'
      : 'ERROR';
    process.send?.({ type: 'result', outcome });
  } finally {
    process.disconnect?.();
  }
});
