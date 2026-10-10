import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { MockPaymentAdapter } from '../src/infrastructure/payment/mock-adapter';
import { authenticated, readServiceJson, serviceResponse, serviceToken } from '../src/infrastructure/http/local-service';

const dispatchToken = serviceToken(process.env.MOCK_PROVIDER_TOKEN, 'MOCK_PROVIDER_TOKEN');
const readToken = serviceToken(process.env.MOCK_PROVIDER_READ_TOKEN, 'MOCK_PROVIDER_READ_TOKEN');
if (dispatchToken === readToken) throw new Error('Provider read and dispatch credentials must be different');
const databasePath = process.env.MOCK_PROVIDER_DATABASE_PATH;
if (!databasePath) throw new Error('MOCK_PROVIDER_DATABASE_PATH is required');
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
const adapter = new MockPaymentAdapter(databasePath);
const audit = new Database(databasePath);
audit.exec('CREATE TABLE IF NOT EXISTS mock_calls (id INTEGER PRIMARY KEY, method TEXT NOT NULL, intent_id TEXT, order_id TEXT)');
const fault = z.enum(['NONE', 'SIMULATE_REJECTION', 'SIMULATE_TIMEOUT', 'SIMULATE_RESPONSE_LOSS', 'SIMULATE_PENDING', 'SIMULATE_DUPLICATE']).optional();
const createSchema = z.object({ intentId: z.string().min(1).max(128), amountPaise: z.number().int().safe().positive(), currency: z.literal('INR'), merchantId: z.string().min(1).max(128), description: z.string().max(1000), receipt: z.string().min(1).max(128), fault }).strict();
const captureSchema = z.object({ orderId: z.string().min(1).max(128), amountPaise: z.number().int().safe().positive(), currency: z.literal('INR'), paymentId: z.string().optional(), signature: z.string().optional(), fault }).strict();
const port = Number(process.env.MOCK_PROVIDER_PORT || 3220);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MOCK_PROVIDER_PORT');
const server = http.createServer(async (req, res) => {
  try {
    const canDispatch = authenticated(req, dispatchToken);
    const canRead = canDispatch || authenticated(req, readToken);
    if (!canRead) return serviceResponse(res, 401, { error: 'Unauthorized' });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return serviceResponse(res, 200, { mode: 'MOCK', durable: true });
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return serviceResponse(res, 200, { calls: audit.prepare('SELECT method, intent_id AS intentId, order_id AS orderId FROM mock_calls ORDER BY id').all() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/orders/')) return serviceResponse(res, 200, await adapter.getOrderStatus(decodeURIComponent(url.pathname.slice(8))));
    if (req.method === 'GET' && url.pathname.startsWith('/receipts/')) return serviceResponse(res, 200, await adapter.reconcileOrderByReceipt(decodeURIComponent(url.pathname.slice(10))));
    if (!canDispatch) return serviceResponse(res, 403, { error: 'Read credential cannot mutate provider state' });
    if (req.method === 'POST' && url.pathname === '/orders') {
      const input = createSchema.parse(await readServiceJson(req));
      audit.prepare('INSERT INTO mock_calls(method,intent_id) VALUES (?,?)').run('createOrder', input.intentId);
      return serviceResponse(res, 200, await adapter.createOrder(input));
    }
    if (req.method === 'POST' && url.pathname === '/capture') {
      const input = captureSchema.parse(await readServiceJson(req));
      audit.prepare('INSERT INTO mock_calls(method,order_id) VALUES (?,?)').run('confirmCapture', input.orderId);
      return serviceResponse(res, 200, await adapter.confirmCapture(input));
    }
    serviceResponse(res, 404, { error: 'Not found' });
  } catch { serviceResponse(res, 400, { error: 'Invalid provider request' }); }
});
server.requestTimeout = 20000;
server.listen(port, '127.0.0.1', () => console.log(`MOCK ONLY durable provider listening on 127.0.0.1:${(server.address() as { port: number }).port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { adapter.close(); audit.close(); }); server.closeIdleConnections(); });
