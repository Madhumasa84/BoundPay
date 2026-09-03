/**
 * Worker thread script for cross-connection SQLite concurrency tests.
 * Each worker independently opens its own database connection, waits for
 * a SharedArrayBuffer barrier signal, then executes the given intent.
 *
 * This file must NOT be discovered by vitest (it has no describe/it blocks).
 */

import { workerData, parentPort } from 'worker_threads';
import {
  createSqliteConnection as _csc,
  createDrizzleClient as _cdc,
  closeDefaultDb,
} from '@/infrastructure/db';
import { ExecutionService } from '@/services/execution.service';
import { MockPaymentAdapter } from '@/infrastructure/payment/mock-adapter';
import { TestClock } from '@/infrastructure/clock/clock';

(async () => {
  const { dbPath, intentId, operatorId, barrier } = workerData as {
    dbPath: string;
    intentId: string;
    operatorId: string;
    barrier: SharedArrayBuffer;
  };

  process.env.DATABASE_PATH = dbPath;

  try {
    // Signal that this worker is initialised and ready to start
    parentPort!.postMessage({ type: 'ready' });

    // Wait for the start barrier
    const bv = new Int32Array(barrier);
    Atomics.wait(bv, 0, 0, 15000);

    // Each worker uses the default singleton — but closeDefaultDb() first
    // so that getDb() opens a fresh connection to the per-test dbPath.
    closeDefaultDb();

    const clockInst = new TestClock('2026-09-03T12:00:00.000Z');
    const svc = new ExecutionService(new MockPaymentAdapter(), clockInst);
    const result = await svc.executeIntent(intentId, operatorId);
    closeDefaultDb();

    parentPort!.postMessage({
      type: 'result',
      outcome: 'SUCCESS',
      message: result.message,
      ledgerId: result.ledgerId,
      status: result.status,
    });
  } catch (err: unknown) {
    try { closeDefaultDb(); } catch { /**/ }
    if (err instanceof Error) {
      let outcome = 'ERROR';
      if (err.name === 'BudgetExceededError') outcome = 'BUDGET_EXCEEDED';
      else if (err.name === 'StateConflictError') outcome = 'STATE_CONFLICT';
      else if (err.name === 'QuoteRevalidationError') outcome = 'QUOTE_REVALIDATION';
      parentPort!.postMessage({ type: 'result', outcome, message: err.message });
    } else {
      parentPort!.postMessage({ type: 'error', message: String(err) });
    }
  }
})();
