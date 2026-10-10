import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpMockPaymentAdapter } from '../../src/infrastructure/payment/http-mock-adapter';

const token = 'dispatch-test-'.padEnd(64, 'd');
const readToken = 'read-test-'.padEnd(64, 'r');
const directories: string[] = [];
const children: ChildProcess[] = [];

async function start(databasePath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/mock-provider-server.ts'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', MOCK_PROVIDER_PORT: '0', MOCK_PROVIDER_DATABASE_PATH: databasePath,
      MOCK_PROVIDER_TOKEN: token, MOCK_PROVIDER_READ_TOKEN: readToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Provider startup timed out: ${output}`)), 15000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Provider exited ${code}: ${output}`)); });
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (data) => {
      output += data.toString();
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { child, url, adapter: new HttpMockPaymentAdapter(url, token), reader: new HttpMockPaymentAdapter(url, readToken) };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('independent durable mock provider process', () => {
  it('preserves captured evidence and idempotency across a real process restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-provider-'));
    directories.push(directory);
    const database = path.join(directory, 'provider.sqlite');
    const first = await start(database);
    const params = { intentId: 'purchase-1', receipt: 'rcpt_purchase1', amountPaise: 10000, currency: 'INR', merchantId: 'demo_store', description: 'Test' };
    const order = await first.adapter.createOrder(params);
    expect(order.success).toBe(true);
    const capture = await first.adapter.confirmCapture({ orderId: order.orderId!, amountPaise: 10000, currency: 'INR' });
    expect(capture.success).toBe(true);
    await stop(first.child);
    const second = await start(database);
    const recovered = await second.reader.reconcileOrderByReceipt(params.receipt);
    expect(recovered).toMatchObject({ status: 'CAPTURED', orderId: order.orderId, paymentId: capture.paymentId, amountPaise: 10000, rawResponse: { intent_id: params.intentId } });
    expect(await second.adapter.createOrder(params)).toMatchObject({ orderId: order.orderId });
    expect(await second.adapter.confirmCapture({ orderId: order.orderId!, amountPaise: 10000, currency: 'INR', fault: 'SIMULATE_REJECTION' })).toMatchObject({ status: 'CAPTURED', isDuplicate: true, paymentId: capture.paymentId });
    expect(await second.adapter.createOrder({ ...params, amountPaise: 1 })).toMatchObject({ success: false, status: 'UNKNOWN' });
    expect(await second.adapter.confirmCapture({ orderId: order.orderId!, amountPaise: 1, currency: 'INR' })).toMatchObject({ success: false, status: 'UNKNOWN' });
    const metrics = await fetch(`${second.url}/metrics`, { headers: { authorization: `Bearer ${readToken}` } }).then((res) => res.json());
    expect(metrics.calls.filter((call: { method: string }) => call.method === 'createOrder')).toHaveLength(3);
  }, 30000);

  it('rejects unauthenticated calls and prevents verifier read credentials from creating or capturing payments', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-provider-'));
    directories.push(directory);
    const service = await start(path.join(directory, 'provider.sqlite'));
    expect((await fetch(`${service.url}/health`)).status).toBe(401);
    for (const route of ['/orders', '/capture']) {
      expect((await fetch(`${service.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${readToken}` }, body: '{}' })).status).toBe(403);
    }
    expect((await fetch(`${service.url}/orders`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ amountPaise: -1 }) })).status).toBe(400);
    const metrics = await fetch(`${service.url}/metrics`, { headers: { authorization: `Bearer ${readToken}` } }).then((res) => res.json());
    expect(metrics.calls).toEqual([]);
  }, 20000);

  it('retains response-loss evidence and terminal rejection after restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-provider-'));
    directories.push(directory);
    const database = path.join(directory, 'provider.sqlite');
    const first = await start(database);
    const params = { intentId: 'lost-1', receipt: 'lost-receipt', amountPaise: 10000, currency: 'INR', merchantId: 'demo_store', description: 'Test' };
    const lost = await first.adapter.createOrder({ ...params, fault: 'SIMULATE_RESPONSE_LOSS' });
    const declined = await first.adapter.createOrder({ ...params, intentId: 'failed-1', receipt: 'failed-receipt', fault: 'SIMULATE_REJECTION' });
    await stop(first.child);
    const second = await start(database);
    expect(await second.reader.reconcileOrderByReceipt(params.receipt)).toMatchObject({ orderId: lost.orderId, status: 'CREATED' });
    expect(await second.reader.reconcileOrderByReceipt('failed-receipt')).toMatchObject({ orderId: declined.orderId, status: 'FAILED' });
    expect(await second.adapter.confirmCapture({ orderId: declined.orderId!, amountPaise: 10000, currency: 'INR' })).toMatchObject({ success: false, status: 'FAILED' });
  }, 30000);
});
