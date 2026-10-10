import http from 'node:http';
import { authenticated, readServiceJson, serviceResponse, serviceToken } from '../src/infrastructure/http/local-service';
import { DrunixGatewayClient } from '../src/infrastructure/shared-authority/drunix-gateway';
import { getDrunixSettings } from '../src/infrastructure/shared-authority/config';
import { HttpMockPaymentAdapter } from '../src/infrastructure/payment/http-mock-adapter';
import { RazorpayTestAdapter } from '../src/infrastructure/payment/razorpay-test-adapter';
import { verifySharedOutcome } from '../src/services/independent-verifier.service';

const token = serviceToken(process.env.SHARED_AUTHORITY_VERIFIER_TOKEN, 'SHARED_AUTHORITY_VERIFIER_TOKEN');
getDrunixSettings('verifier');
const mode = process.env.PAYMENT_ADAPTER_MODE;
if (mode !== 'MOCK' && mode !== 'RAZORPAY_TEST') throw new Error('Verifier requires an explicit PAYMENT_ADAPTER_MODE');
const provider = mode === 'MOCK'
  ? new HttpMockPaymentAdapter(process.env.MOCK_PROVIDER_URL, process.env.MOCK_PROVIDER_READ_TOKEN)
  : new RazorpayTestAdapter({ keyId: process.env.RAZORPAY_KEY_ID || '', keySecret: process.env.RAZORPAY_KEY_SECRET || '' });
const port = Number(process.env.SHARED_AUTHORITY_VERIFIER_PORT || 3221);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SHARED_AUTHORITY_VERIFIER_PORT');
const server = http.createServer(async (req, res) => {
  if (!authenticated(req, token)) return serviceResponse(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET' && req.url === '/health') return serviceResponse(res, 200, { role: 'independent-verifier', providerMode: mode });
  if (req.method !== 'POST' || req.url !== '/verify') return serviceResponse(res, 404, { error: 'Not found' });
  let client: DrunixGatewayClient | undefined;
  try {
    const body = await readServiceJson(req);
    client = new DrunixGatewayClient('verifier');
    serviceResponse(res, 200, await verifySharedOutcome(body, client, provider));
  } catch {
    // Keep provider credentials, proofs, and internal error text out of responses/logs.
    serviceResponse(res, 200, { confirmed: false, message: 'Independent verification unavailable or rejected; reservation remains held' });
  } finally { client?.close(); }
});
server.requestTimeout = 20000;
server.listen(port, '127.0.0.1', () => console.log(`Independent verifier listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
