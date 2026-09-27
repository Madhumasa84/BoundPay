import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers } from '@hyperledger/fabric-gateway';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const networkHome = path.resolve(process.env.DRUNIX_TEST_NETWORK_HOME || '/tmp/drunix-v1.0.0/drunix-network/test-network');
const channel = process.env.DRUNIX_CHANNEL || 'boundpay';
const chaincode = process.env.DRUNIX_CHAINCODE || 'boundpay-shared-authority';
const runId = crypto.randomUUID();
const mandateId = `bp-app-demo-${runId}`;
const demoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'boundpay-drunix-services-'));
const seedDb = path.join(demoDir, 'seed.sqlite');
const dbA = path.join(demoDir, 'service-org1.sqlite');
const dbB = path.join(demoDir, 'service-org2.sqlite');
const children = [];
const logs = new Map();
const generatedAuthorityKeyPaths = [];
const reviewSeconds = Number(process.env.DRUNIX_DEMO_REVIEW_SECONDS || 0);
const ambiguousFault = process.env.DRUNIX_DEMO_AMBIGUOUS_FAULT || 'SIMULATE_TIMEOUT';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stage(message) {
  console.error(`[REAL LOCAL DRUNIX / MOCK PAYMENT] ${message}`);
}

async function firstFile(directory) {
  const entries = (await fsp.readdir(directory)).sort();
  if (!entries[0]) throw new Error(`Required Drunix identity file missing under ${directory}`);
  return path.join(directory, entries[0]);
}

async function networkIdentity(org, user) {
  const domain = `org${org}.example.com`;
  const cryptoHome = path.join(networkHome, 'organizations', 'peerOrganizations', domain);
  const userHome = path.join(cryptoHome, 'users', `${user}@${domain}`, 'msp');
  const [certificate, keyPath, tlsRoot] = await Promise.all([
    fsp.readFile(await firstFile(path.join(userHome, 'signcerts'))),
    firstFile(path.join(userHome, 'keystore')),
    fsp.readFile(path.join(cryptoHome, 'peers', `peer0.${domain}`, 'tls', 'ca.crt')),
  ]);
  return {
    org,
    domain,
    mspId: `Org${org}MSP`,
    certificate,
    privateKey: crypto.createPrivateKey(await fsp.readFile(keyPath)),
    tlsRoot,
    endpoint: `localhost:${org === 1 ? 7051 : 9051}`,
    hostAlias: `peer0.${domain}`,
  };
}

async function callerIdentity(identity) {
  const client = new grpc.Client(identity.endpoint, grpc.credentials.createSsl(identity.tlsRoot), {
    'grpc.ssl_target_name_override': identity.hostAlias,
  });
  const gateway = connect({
    client,
    identity: { mspId: identity.mspId, credentials: identity.certificate },
    signer: signers.newPrivateKeySigner(identity.privateKey),
    hash: hash.sha256,
  });
  try {
    const contract = gateway.getNetwork(channel).getContract(chaincode);
    return JSON.parse(Buffer.from(await contract.evaluate('GetCallerIdentity')).toString('utf8'));
  } finally {
    gateway.close();
    client.close();
  }
}

function launch(label, port, env) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(executable, ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  logs.set(label, '');
  const append = (chunk) => {
    const current = logs.get(label) || '';
    logs.set(label, `${current}${chunk.toString('utf8')}`.slice(-6000));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) append(`\nprocess exit ${code} (${signal || 'no signal'})`);
  });
  return { label, port, child, env };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
  });
}

async function waitForServer(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`${server.label} exited before ready:\n${logs.get(server.label)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/me`, { signal: AbortSignal.timeout(1500) });
      if ([200, 401].includes(response.status)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${server.label} did not start within 90 seconds:\n${logs.get(server.label)}`);
}

async function api(server, pathname, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
  return { data, response };
}

async function login(server) {
  const { data, response } = await api(server, '/api/auth/login', {
    method: 'POST',
    body: { username: 'operator', password: 'BoundPayPass123!' },
  });
  assert(data.success, `${server.label} operator login failed`);
  const setCookie = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = setCookie.map((value) => value.split(';', 1)[0]).find((value) => value.startsWith('boundpay_session='));
  assert(cookie, `${server.label} login did not return the operator session cookie`);
  return cookie;
}

function createDemoAuthorityKey(label) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePath = path.join(demoDir, `${label}-authority-private.pem`);
  const publicPath = path.join(demoDir, `${label}-authority-public.pem`);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicPath, publicPem, { mode: 0o600 });
  generatedAuthorityKeyPaths.push(privatePath, publicPath);
  return { keyId: `demo-${label}-${runId}`, privatePath, publicPath, publicPem };
}

function authorityEnv(authority, verificationKeysJson) {
  return {
    AUTHORITY_SIGNING_PRIVATE_KEY: '',
    AUTHORITY_SIGNING_PUBLIC_KEY: '',
    AUTHORITY_SIGNING_PRIVATE_KEY_FILE: authority.privatePath,
    AUTHORITY_SIGNING_PUBLIC_KEY_FILE: authority.publicPath,
    AUTHORITY_SIGNING_KEY_ID: authority.keyId,
    AUTHORITY_ISSUER: 'boundpay-test-authority',
    AUTHORITY_AUDIENCE: 'boundpay-agent',
    AUTHORITY_VERIFICATION_KEYS_JSON: verificationKeysJson,
  };
}

function appEnv({ identity, verifier, participantsJson, verifierJson, databasePath, authority, verificationKeysJson }) {
  return {
    NODE_ENV: 'production',
    PLAYWRIGHT_TEST: 'true',
    AUTHORITY_TEST_MODE: 'true',
    ...authorityEnv(authority, verificationKeysJson),
    AGENT_MODE: 'fixture',
    PAYMENT_ADAPTER_MODE: 'MOCK',
    PAYMENT_MODE: 'mock',
    DATABASE_PATH: databasePath,
    SHARED_AUTHORITY_MODE: 'DRUNIX',
    SHARED_AUTHORITY_LOCAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    DRUNIX_MANDATE_ID: mandateId,
    DRUNIX_CHANNEL: channel,
    DRUNIX_CHAINCODE: chaincode,
    DRUNIX_MSP_ID: identity.mspId,
    DRUNIX_VERIFIER_MSP_ID: verifier.mspId,
    DRUNIX_GATEWAY_ENDPOINT: identity.endpoint,
    DRUNIX_PEER_HOST_ALIAS: identity.hostAlias,
    DRUNIX_PARTICIPANT_IDENTITIES_JSON: participantsJson,
    DRUNIX_VERIFIER_IDENTITIES_JSON: verifierJson,
    DRUNIX_TLS_ROOT_CERT_FILE: path.join(networkHome, 'organizations', 'peerOrganizations', identity.domain, 'peers', `peer0.${identity.domain}`, 'tls', 'ca.crt'),
    DRUNIX_CLIENT_CERT_FILE: path.join(networkHome, 'organizations', 'peerOrganizations', identity.domain, 'users', `${identity.user}@${identity.domain}`, 'msp', 'signcerts', identity.certFile),
    DRUNIX_CLIENT_PRIVATE_KEY_FILE: identity.keyPath,
    DRUNIX_VERIFIER_CLIENT_CERT_FILE: path.join(networkHome, 'organizations', 'peerOrganizations', verifier.domain, 'users', `${verifier.user}@${verifier.domain}`, 'msp', 'signcerts', verifier.certFile),
    DRUNIX_VERIFIER_CLIENT_PRIVATE_KEY_FILE: verifier.keyPath,
    DRUNIX_COMMIT_TIMEOUT_MS: '120000',
  };
}

async function enrichNetworkIdentity(org, user, material) {
  const domain = `org${org}.example.com`;
  const home = path.join(networkHome, 'organizations', 'peerOrganizations', domain, 'users', `${user}@${domain}`, 'msp');
  return {
    ...material,
    user,
    domain,
    certFile: path.basename(await firstFile(path.join(home, 'signcerts'))),
    keyPath: await firstFile(path.join(home, 'keystore')),
  };
}

function runSeed(authority, verificationKeysJson) {
  const seedEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_PATH: seedDb,
    CONFIRM_RESET: 'true',
    AUTHORITY_TEST_MODE: 'true',
    ...authorityEnv(authority, verificationKeysJson),
    PAYMENT_ADAPTER_MODE: 'MOCK',
    PAYMENT_MODE: 'mock',
  };
  const result = spawnSync('pnpm', ['exec', 'tsx', 'src/infrastructure/db/reset.ts'], {
    cwd: root,
    env: seedEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`Could not create isolated demo database:\n${result.stdout}\n${result.stderr}`);
  fs.copyFileSync(seedDb, dbA);
  fs.copyFileSync(seedDb, dbB);
}

try {
  assert(Number.isSafeInteger(reviewSeconds) && reviewSeconds >= 0 && reviewSeconds <= 300, 'DRUNIX_DEMO_REVIEW_SECONDS must be an integer from 0 to 300');
  assert(['SIMULATE_TIMEOUT', 'SIMULATE_RESPONSE_LOSS'].includes(ambiguousFault), 'DRUNIX_DEMO_AMBIGUOUS_FAULT must be SIMULATE_TIMEOUT or SIMULATE_RESPONSE_LOSS');
  assert(fs.existsSync(path.join(root, '.next', 'BUILD_ID')), 'Build the app first with `pnpm run build`');
  assert(fs.existsSync(path.join(networkHome, 'organizations')), 'Drunix test-network cryptographic material was not found');
  const authorityA = createDemoAuthorityKey('org1');
  const authorityB = createDemoAuthorityKey('org2');
  const verificationKeysJson = JSON.stringify({ [authorityA.keyId]: authorityA.publicPem, [authorityB.keyId]: authorityB.publicPem });
  assert(authorityA.publicPem !== authorityB.publicPem, 'Demo services must use different authority signing keys');
  runSeed(authorityA, verificationKeysJson);

  const org1Base = await networkIdentity(1, 'User1');
  const org2Base = await networkIdentity(2, 'User1');
  const verifierBase = await networkIdentity(1, 'Admin');
  const ownerId = await callerIdentity(org1Base);
  const participantBId = await callerIdentity(org2Base);
  const verifierId = await callerIdentity(verifierBase);
  const org1 = await enrichNetworkIdentity(1, 'User1', org1Base);
  const org2 = await enrichNetworkIdentity(2, 'User1', org2Base);
  const verifier = await enrichNetworkIdentity(1, 'Admin', verifierBase);
  const participantsJson = JSON.stringify([ownerId, participantBId]);
  const verifierJson = JSON.stringify([verifierId]);

  const envA = appEnv({ identity: org1, verifier, participantsJson, verifierJson, databasePath: dbA, authority: authorityA, verificationKeysJson });
  const envB = appEnv({ identity: org2, verifier, participantsJson, verifierJson, databasePath: dbB, authority: authorityB, verificationKeysJson });
  const serviceA = launch('BoundPay Org1 service', 3211, envA);
  const serviceB = launch('BoundPay Org2 service', 3212, envB);
  await Promise.all([waitForServer(serviceA), waitForServer(serviceB)]);

  const [cookieA, cookieB] = await Promise.all([login(serviceA), login(serviceB)]);
  const [{ data: passportResponse }] = await Promise.all([api(serviceA, '/api/passports', { cookie: cookieA })]);
  const passport = passportResponse.passports.map((item) => item.passport).find((item) => item.agentId === 'officebot' && item.paymentAdapterMode === 'MOCK');
  assert(passport, 'Seeded signed MOCK Authority Passport was not found');

  const issued = await api(serviceA, '/api/shared-authority/mandate', {
    cookie: cookieA,
    method: 'POST',
    body: { passportId: passport.passportId, aggregateCapPaise: 500_000, perTransactionCapPaise: 300_000, maximumUsageCount: 10 },
  });
  assert(issued.data.mandate?.status === 'ACTIVE' && issued.data.validationCode === 'VALID', `BoundPay did not verify a committed active mandate: ${JSON.stringify(issued.data)}`);
  stage(`Owner issued a shared INR 5,000 mandate; ledger commit ${issued.data.transactionId} is VALID.`);

  async function createApprovedIntent(server, cookie, suffix) {
    const proposed = await api(server, '/api/intents', {
      cookie,
      method: 'POST',
      body: {
        product_id: 'prod_keyboard',
        quantity: 1,
        purchase_budget_paise: 400_000,
        idempotency_key: `drunix-app-${suffix}-${runId}`,
        source_mode: 'MANUAL',
        passport_id: passport.passportId,
        agent_id: passport.agentId,
        reason: `Independent service ${suffix} local Drunix demo`,
      },
    });
    const intent = proposed.data.intent;
    assert(intent && intent.total_amount_paise === 279_900, `${suffix} intent did not use the canonical ₹2,799 catalog price`);
    assert(intent.state === 'NEEDS_APPROVAL', `${suffix} proposal should require the existing exact human approval gate`);
    const approved = await api(server, `/api/intents/${intent.id}/approve`, { cookie, method: 'POST', body: { notes: 'Human approval recorded for network race demonstration' } });
    assert(approved.data.intent.state === 'APPROVED', `${suffix} exact-quote human approval was not recorded`);
    return intent;
  }

  const [intentA, intentB] = await Promise.all([
    createApprovedIntent(serviceA, cookieA, 'org1'),
    createApprovedIntent(serviceB, cookieB, 'org2'),
  ]);
  const [executionA, executionB] = await Promise.all([
    api(serviceA, `/api/intents/${intentA.id}/execute`, { cookie: cookieA, method: 'POST', body: {} }),
    api(serviceB, `/api/intents/${intentB.id}/execute`, { cookie: cookieB, method: 'POST', body: {} }),
  ]);
  const outcomes = [executionA.data.result, executionB.data.result];
  const confirmed = outcomes.filter((result) => result.success && result.status === 'PAYMENT_CONFIRMED');
  assert(confirmed.length === 1 && outcomes.filter((result) => result.status === 'BLOCKED').length === 1, `Expected one MOCK-confirmed purchase and one blocked request against INR 5,000 shared allowance; saw ${outcomes.map((r) => r.status).join(', ')}`);
  stage('Two service processes raced INR 2,799 purchases. One MOCK payment was confirmed; the conflicting purchase was blocked.');

  // Simulate the local outbox losing the outcome acknowledgement after the
  // VALID Drunix commit. The provider result remains locally verified; retry
  // must replay the same outcome commitment and must not call the provider.
  const winnerIsA = outcomes[0].status === 'PAYMENT_CONFIRMED';
  const winnerIntent = winnerIsA ? intentA : intentB;
  const winnerService = winnerIsA ? serviceA : serviceB;
  const winnerCookie = winnerIsA ? cookieA : cookieB;
  const winnerDb = new Database(winnerIsA ? dbA : dbB);
  const simulatedLostAck = winnerDb.prepare(`UPDATE shared_authority_operations
    SET ledger_state = 'OUTCOME_UNKNOWN', outcome_transaction_id = NULL, validation_code = NULL
    WHERE intent_id = ? AND payment_state = 'SUCCEEDED'`).run(winnerIntent.id);
  winnerDb.close();
  assert(simulatedLostAck.changes === 1, 'Could not create the local lost-ack recovery fixture');
  const outcomeRetry = await api(winnerService, `/api/intents/${winnerIntent.id}/reconcile`, { cookie: winnerCookie, method: 'POST', body: {} });
  assert(outcomeRetry.data.status === 'PAYMENT_CONFIRMED' && outcomeRetry.data.message.includes('now VALID on Drunix'), 'Stored verified success was not reconciled to Drunix');
  const ledgerAfterOutcomeRetry = await api(winnerService, '/api/shared-authority', { cookie: winnerCookie });
  assert(ledgerAfterOutcomeRetry.data.mandate.settledPaise === 279_900 && ledgerAfterOutcomeRetry.data.mandate.reservedPaise === 0, 'Idempotent outcome recovery changed the settled amount or retained balance');
  const recordedWinner = ledgerAfterOutcomeRetry.data.reservations.find((entry) => entry.reservationId === `res-${crypto.createHash('sha256').update(winnerIntent.id).digest('hex').slice(0, 32)}`);
  const winnerOperation = ledgerAfterOutcomeRetry.data.paymentOperations.find((entry) => entry.intentId === winnerIntent.id);
  assert(recordedWinner?.outcomeTransactionId && winnerOperation?.outcomeTransactionId === recordedWinner.outcomeTransactionId, 'Local outcome evidence must reference the original Drunix transition, not an idempotent retry transaction');

  const timeoutIntent = await api(serviceA, '/api/intents', {
    cookie: cookieA,
    method: 'POST',
    body: {
      product_id: 'prod_book',
      quantity: 1,
      purchase_budget_paise: 100_000,
      idempotency_key: `drunix-timeout-${runId}`,
      source_mode: 'MANUAL',
      passport_id: passport.passportId,
      agent_id: passport.agentId,
      reason: `Synthetic ${ambiguousFault} and restart recovery check`,
    },
  });
  assert(timeoutIntent.data.intent.state === 'READY' && timeoutIntent.data.intent.total_amount_paise === 89_900, 'Timeout recovery purchase did not pass the existing deterministic policy');
  const timeoutResult = await api(serviceA, `/api/intents/${timeoutIntent.data.intent.id}/execute`, {
    cookie: cookieA,
    method: 'POST',
    body: { fault_injection: ambiguousFault },
  });
  assert(timeoutResult.data.result.status === 'UNKNOWN', 'Simulated ambiguous provider outcome did not become UNKNOWN');
  stage(`Synthetic ${ambiguousFault} became UNKNOWN; Drunix retained its INR 899 reservation.`);
  const timeoutReservationId = `res-${crypto.createHash('sha256').update(timeoutIntent.data.intent.id).digest('hex').slice(0, 32)}`;
  const timeoutLedgerBeforeRestart = await api(serviceA, '/api/shared-authority', { cookie: cookieA });
  const unknownReservation = timeoutLedgerBeforeRestart.data.reservations.find((entry) => entry.reservationId === timeoutReservationId);
  assert(unknownReservation?.status === 'UNKNOWN', 'Drunix did not retain the ambiguous provider reservation as UNKNOWN');

  await stopChild(serviceA.child);
  const serviceARestarted = launch('BoundPay Org1 service (restarted)', 3211, envA);
  await waitForServer(serviceARestarted);
  const cookieARestarted = await login(serviceARestarted);
  const repeatedExecution = await fetch(`http://127.0.0.1:${serviceARestarted.port}/api/intents/${timeoutIntent.data.intent.id}/execute`, {
    method: 'POST',
    headers: { cookie: cookieARestarted, 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(120_000),
  });
  const repeatedBody = await repeatedExecution.json();
  assert(repeatedExecution.status === 409 && repeatedBody.error === 'Conflict', 'Restarted service attempted to redispatch a MAY_HAVE_SENT request');
  const unresolved = await api(serviceARestarted, `/api/intents/${timeoutIntent.data.intent.id}/reconcile`, { cookie: cookieARestarted, method: 'POST', body: {} });
  assert(unresolved.data.status === 'UNKNOWN', 'Missing provider evidence was treated as definitive failure during reconciliation');
  stage('After service restart, retry was refused and reconciliation kept the unknown payment held.');

  await stopChild(serviceB.child);
  const offlineEnvB = { ...envB, DRUNIX_GATEWAY_ENDPOINT: 'localhost:1' };
  const serviceBOffline = launch('BoundPay Org2 service (ledger unavailable)', 3212, offlineEnvB);
  await waitForServer(serviceBOffline);
  const cookieBOffline = await login(serviceBOffline);
  const outageIntent = await api(serviceBOffline, '/api/intents', {
    cookie: cookieBOffline,
    method: 'POST',
    body: {
      product_id: 'prod_book',
      quantity: 1,
      purchase_budget_paise: 100_000,
      idempotency_key: `drunix-outage-${runId}`,
      source_mode: 'MANUAL',
      passport_id: passport.passportId,
      agent_id: passport.agentId,
      reason: 'Ledger outage fail-closed and retry recovery check',
    },
  });
  const outageExecution = await api(serviceBOffline, `/api/intents/${outageIntent.data.intent.id}/execute`, { cookie: cookieBOffline, method: 'POST', body: {} });
  assert(outageExecution.data.result.status === 'UNKNOWN' && outageExecution.data.result.message.includes('No payment request was sent'), 'Drunix outage did not fail closed before provider dispatch');

  await stopChild(serviceBOffline.child);
  const serviceBRestored = launch('BoundPay Org2 service (ledger restored)', 3212, envB);
  await waitForServer(serviceBRestored);
  const cookieBRestored = await login(serviceBRestored);
  const outageRecovery = await api(serviceBRestored, `/api/intents/${outageIntent.data.intent.id}/execute`, { cookie: cookieBRestored, method: 'POST', body: {} });
  assert(outageRecovery.data.result.status === 'PAYMENT_CONFIRMED' && outageRecovery.data.result.success, 'A pre-send reservation could not recover after the ledger returned');
  stage('A pre-dispatch ledger outage blocked payment; restoring the connection allowed the original no-send request to complete.');

  const [ledgerA, ledgerB] = await Promise.all([
    api(serviceARestarted, '/api/shared-authority', { cookie: cookieARestarted }),
    api(serviceBRestored, '/api/shared-authority', { cookie: cookieBRestored }),
  ]);
  const mandate = ledgerA.data.mandate;
  assert(mandate.status === 'ACTIVE' && mandate.settledPaise === 369_800 && mandate.reservedPaise === 89_900, 'Drunix totals do not equal two confirmed purchases plus one unresolved reservation');
  const reservations = ledgerA.data.reservations;
  assert(reservations.length === 3 && reservations.filter((entry) => entry.status === 'SETTLED').length === 2 && reservations.filter((entry) => entry.status === 'UNKNOWN').length === 1, 'Shared ledger should contain two settled purchases and one retained UNKNOWN reservation');
  const operations = [...ledgerA.data.paymentOperations, ...ledgerB.data.paymentOperations];
  assert(operations.filter((item) => item.paymentState === 'SUCCEEDED').length === 2, 'Expected synthetic success for the race winner and the safely retried outage intent');
  assert(operations.filter((item) => item.ledgerState === 'RESERVE_REJECTED').length === 1, 'The losing service did not record a rejected shared reservation');
  const losingIntentId = outcomes[0].status === 'BLOCKED' ? intentA.id : intentB.id;
  const losingReservationId = `res-${crypto.createHash('sha256').update(losingIntentId).digest('hex').slice(0, 32)}`;

  console.log(JSON.stringify({
    integration: 'two independent BoundPay HTTP service instances on actual Drunix local network',
    ambiguousProviderScenario: ambiguousFault,
    network: `Drunix v1.0.0 local test network; channel ${channel}; chaincode boundpay-shared-authority v1.2`,
    participantServices: [
      { instance: 'Org1 service', port: serviceA.port, msp: org1.mspId, separateDatabase: path.basename(dbA) },
      { instance: 'Org2 service', port: serviceBRestored.port, msp: org2.mspId, separateDatabase: path.basename(dbB) },
    ],
    mandate: { id: mandateId, capPaise: mandate.aggregateCapPaise, settledPaise: mandate.settledPaise, reservedPaise: mandate.reservedPaise, availablePaise: mandate.aggregateCapPaise - mandate.settledPaise - mandate.reservedPaise },
    proposals: [intentA.id, intentB.id, timeoutIntent.data.intent.id, outageIntent.data.intent.id],
    outcomes: outcomes.map((result) => ({ status: result.status, success: result.success, paymentMode: result.isMock ? 'MOCK — SYNTHETIC' : 'unexpected non-MOCK' })),
    checks: {
      distinctCertificatesAndMspIdentities: ownerId.clientId !== participantBId.clientId && ownerId.mspId !== participantBId.mspId,
      distinctApplicationSigningKeysAndSharedPublicTrust: authorityA.publicPem !== authorityB.publicPem,
      separateSqliteDatabases: dbA !== dbB,
      bothExistingHumanApprovalGatesPassed: true,
      exactlyOnePaymentDispatchedAndConfirmed: confirmed.length === 1,
      sharedLimitNotExceeded: mandate.settledPaise + mandate.reservedPaise <= mandate.aggregateCapPaise,
      winningOutcomeHasValidLedgerCommit: reservations.some((entry) => entry.status === 'SETTLED' && Boolean(entry.outcomeTransactionId)),
      storedOutcomeCommitCanBeReconciledAfterLostLocalAcknowledgement: outcomeRetry.data.status === 'PAYMENT_CONFIRMED' && ledgerAfterOutcomeRetry.data.mandate.settledPaise === 279_900,
      outcomeReadbackUsesOriginalTransitionTransactionId: winnerOperation.outcomeTransactionId === recordedWinner.outcomeTransactionId,
      loserHasNoSharedReservation: !reservations.some((entry) => entry.reservationId === losingReservationId),
      ambiguousProviderOutcomeRetainsUnknownReservation: unknownReservation.status === 'UNKNOWN' && mandate.reservedPaise === timeoutIntent.data.intent.total_amount_paise,
      restartAndMissingProviderEvidenceDoNotRedispatchOrRelease: repeatedExecution.status === 409 && unresolved.data.status === 'UNKNOWN' && reservations.some((entry) => entry.reservationId === timeoutReservationId && entry.status === 'UNKNOWN'),
      ledgerOutageFailsClosedWithoutPayment: outageExecution.data.result.status === 'UNKNOWN' && outageExecution.data.result.message.includes('No payment request was sent'),
      preSendReservationRecoversAfterLedgerReturns: outageRecovery.data.result.status === 'PAYMENT_CONFIRMED' && reservations.some((entry) => entry.reservationId === `res-${crypto.createHash('sha256').update(outageIntent.data.intent.id).digest('hex').slice(0, 32)}` && entry.status === 'SETTLED'),
      noExternalProviderOrBankCall: true,
    },
    transactions: {
      issueMandate: issued.data.transactionId,
      reserve: reservations.find((entry) => entry.status === 'SETTLED').reserveTransactionId,
      dispatchClaim: reservations.find((entry) => entry.status === 'SETTLED').dispatchTransactionId,
      outcome: reservations.find((entry) => entry.status === 'SETTLED').outcomeTransactionId,
      unknownReserve: unknownReservation.reserveTransactionId,
      unknownDispatchClaim: unknownReservation.dispatchTransactionId,
    },
    trustLimit: 'The sample verifier certificate is available to both test services; verifier governance is not independent in this demo.',
    label: 'MOCK ONLY — in-process synthetic payment adapter; no provider or bank call',
    retainedDemoDataDirectory: demoDir,
  }, null, 2));
  if (reviewSeconds > 0) {
    console.error(`Review the local Org1 and Org2 dashboards at http://127.0.0.1:3211/shared-authority and http://127.0.0.1:3212/shared-authority for ${reviewSeconds} seconds; both processes will then stop.`);
    await new Promise((resolve) => setTimeout(resolve, reviewSeconds * 1000));
  }
} catch (error) {
  console.error(`BoundPay two-service Drunix demo failed: ${error instanceof Error ? error.message : String(error)}`);
  for (const [label, output] of logs) if (output) console.error(`--- ${label} ---\n${output}`);
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stopChild));
  for (const keyPath of generatedAuthorityKeyPaths) {
    try { fs.unlinkSync(keyPath); } catch {}
  }
}
