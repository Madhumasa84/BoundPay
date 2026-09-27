import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { connect, EndorseError, hash, signers } from '@hyperledger/fabric-gateway';

const home = path.resolve(process.env.DRUNIX_TEST_NETWORK_HOME || '/tmp/drunix-v1.0.0/drunix-network/test-network');
const channelName = process.env.DRUNIX_CHANNEL || 'boundpay';
const chaincodeName = process.env.DRUNIX_CHAINCODE || 'boundpay-shared-authority';
const commitDeadlineMs = 120_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runId = process.env.DRUNIX_DEMO_RUN_ID || crypto.randomUUID();
const mandateId = `bp-demo-${runId}`;
const passportId = `pass-demo-${runId}`;
const keyId = `key-demo-${runId}`;
let mockDispatchCalls = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function firstFile(directory) {
  const entries = await fs.readdir(directory);
  const name = entries.sort()[0];
  if (!name) throw new Error(`No identity file is available in ${directory}`);
  return path.join(directory, name);
}

async function makeClient(org, user) {
  const orgDomain = `org${org}.example.com`;
  const cryptoHome = path.join(home, 'organizations', 'peerOrganizations', orgDomain);
  const userHome = path.join(cryptoHome, 'users', `${user}@${orgDomain}`, 'msp');
  const [certificate, keyPath, tlsRootCert] = await Promise.all([
    fs.readFile(await firstFile(path.join(userHome, 'signcerts'))),
    firstFile(path.join(userHome, 'keystore')),
    fs.readFile(path.join(cryptoHome, 'peers', `peer0.${orgDomain}`, 'tls', 'ca.crt')),
  ]);
  const privateKey = crypto.createPrivateKey(await fs.readFile(keyPath));
  const endpoint = `localhost:${org === 1 ? 7051 : 9051}`;
  const hostAlias = `peer0.${orgDomain}`;
  const client = new grpc.Client(endpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': hostAlias,
  });
  const gateway = connect({
    client,
    identity: { mspId: `Org${org}MSP`, credentials: certificate },
    signer: signers.newPrivateKeySigner(privateKey),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 20_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 60_000 }),
    submitOptions: () => ({ deadline: Date.now() + 30_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + commitDeadlineMs }),
  });
  const contract = gateway.getNetwork(channelName).getContract(chaincodeName);
  return {
    org,
    user,
    client,
    gateway,
    contract,
    async close() { gateway.close(); client.close(); },
  };
}

function parseResult(bytes) {
  if (!bytes || bytes.length === 0) return null;
  return JSON.parse(decoder.decode(bytes));
}

async function submit(client, name, args = [], transientData) {
  const startedAt = performance.now();
  const tx = await client.contract.submitAsync(name, {
    arguments: args,
    ...(transientData ? { transientData } : {}),
  });
  const transactionId = tx.getTransactionId();
  const value = parseResult(tx.getResult());
  const submittedAt = performance.now();
  const status = await tx.getStatus({ deadline: Date.now() + commitDeadlineMs });
  if (!status.successful) {
    const error = new Error(`${name} committed invalid: ${String(status.code)} (${transactionId})`);
    error.confirmedInvalid = true;
    error.transactionId = transactionId;
    error.validationCode = String(status.code);
    throw error;
  }
  return {
    value,
    transactionId: status.transactionId || transactionId,
    validationCode: 'VALID',
    clientRequestToCommitMs: Math.round((performance.now() - startedAt) * 100) / 100,
    submitAcceptedToCommitMs: Math.round((performance.now() - submittedAt) * 100) / 100,
  };
}

async function evaluate(client, name, args = []) {
  return parseResult(await client.contract.evaluate(name, { arguments: args }));
}

async function waitForState(client, name, args, predicate, description) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await evaluate(client, name, args);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${description} was not visible on the queried peer within 15 seconds`);
}

async function expectRejected(client, name, args, transientData) {
  try {
    const result = await submit(client, name, args, transientData);
    throw new Error(`${name} unexpectedly committed VALID as ${result.transactionId}`);
  } catch (error) {
    if (error.confirmedInvalid || error instanceof EndorseError) return String(error.message).slice(0, 240);
    throw error;
  }
}

function canonicalJcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Demo commitments accept safe integer numbers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJcs(value[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported commitment value');
}

function makeCommitment(kind, payload, salt = crypto.randomBytes(32)) {
  const prefix = encoder.encode(`boundpay:commit:v1:${kind}\0`);
  const digest = crypto.createHash('sha256').update(Buffer.concat([prefix, salt, encoder.encode(canonicalJcs(payload))])).digest('hex');
  return { digest, salt };
}

function makePassport(ownerId, agentId, paymentAdapterMode = 'MOCK') {
  const now = new Date();
  const payload = {
    schemaVersion: 1,
    passportId,
    issuer: 'boundpay-drunix-demo',
    audience: 'boundpay-demo-agents',
    operatorId: ownerId,
    ownerId,
    agentId,
    agentDisplayName: 'Drunix demo agent',
    currency: 'INR',
    paymentAdapterMode,
    allowedMerchantIds: ['demo_store'],
    allowedCategories: ['books'],
    maximumAmountPerTransactionPaise: 300_000,
    cumulativeBudgetPaise: 500_000,
    approvalRequiredAbovePaise: 300_000,
    validFrom: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    maximumUsageCount: 10,
    policyVersion: 1,
    revocationNonce: crypto.randomBytes(32).toString('hex'),
    issuedAt: now.toISOString(),
    keyId,
  };
  return payload;
}

function signPassport(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: keyId, typ: 'boundpay-authority-passport+jwt' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  const token = `${signingInput}.${signature}`;
  const canonicalPayload = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
  return { token, digest: crypto.createHash('sha256').update(canonicalPayload).digest('hex') };
}

function makePurchase(clientIdentity, reservationId, requestId, paymentAttemptId, amountPaise, productId) {
  const payload = {
    schemaVersion: 1,
    requestId,
    paymentAttemptId,
    passportId,
    agentId: 'demo-agent',
    amountPaise,
    currency: 'INR',
    paymentAdapterMode: 'MOCK',
    isSubscription: false,
    merchantId: 'demo_store',
    category: 'books',
    productId,
    quantity: 1,
    unitPricePaise: amountPaise,
  };
  const commitment = makeCommitment('purchase-scope', payload);
  const proof = encoder.encode(JSON.stringify({ salt: commitment.salt.toString('base64url'), payload }));
  return {
    args: [mandateId, reservationId, requestId, paymentAttemptId, passportId, clientIdentity.digest, String(amountPaise), 'INR', clientIdentity.scopeCommitment, commitment.digest],
    proof,
    commitment: commitment.digest,
  };
}

function makeReserveRequest(identity, requestLabel, amountPaise, productId) {
  const requestId = `req-${requestLabel}`;
  const reservationId = `res-${requestLabel}`;
  const paymentAttemptId = `pay-${requestLabel}`;
  const purchase = makePurchase(identity, reservationId, requestId, paymentAttemptId, amountPaise, productId);
  const transientData = {
    'boundpay.passport.v1': encoder.encode(identity.token),
    'boundpay.purchase-proof.v1': purchase.proof,
  };
  return { requestLabel, requestId, reservationId, paymentAttemptId, amountPaise, purchase, transientData };
}

async function reserve(client, identity, requestLabel, amountPaise, productId) {
  const request = makeReserveRequest(identity, requestLabel, amountPaise, productId);
  const result = await submit(client, 'Reserve', request.purchase.args, request.transientData);
  return { ...result, ...request, executor: client };
}

async function readWorkerRequest() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function participantWorker() {
  const org = Number(process.env.DRUNIX_DEMO_WORKER_ORG);
  assert(org === 1 || org === 2, 'Worker must use an explicit Org1 or Org2 identity');
  const input = await readWorkerRequest();
  const client = await makeClient(org, 'User1');
  try {
    const identity = await evaluate(client, 'GetCallerIdentity');
    assert(identity.mspId === `Org${org}MSP`, 'Worker certificate does not match its configured organization');
    const transientData = {
      'boundpay.passport.v1': encoder.encode(input.passport.token),
      'boundpay.purchase-proof.v1': Buffer.from(input.purchaseProof, 'base64url'),
    };
    const result = await submit(client, 'Reserve', input.args, transientData);
    process.stdout.write(JSON.stringify({ accepted: true, transactionId: result.transactionId, reservationId: result.value.reservationId, identity, clientRequestToCommitMs: result.clientRequestToCommitMs, submitAcceptedToCommitMs: result.submitAcceptedToCommitMs }));
  } catch (error) {
    if (error instanceof EndorseError || error.confirmedInvalid) {
      process.stdout.write(JSON.stringify({ accepted: false, reason: String(error.message).slice(0, 240) }));
      return;
    }
    throw error;
  } finally {
    client.close();
  }
}

async function inspectMandate(id) {
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id || ''), 'Supply a safe mandate ID after --inspect-mandate');
  const reviewer = await makeClient(1, 'Admin');
  const participant = await makeClient(2, 'User1');
  try {
    const [reviewerMandate, reviewerReservations, participantMandate] = await Promise.all([
      evaluate(reviewer, 'QueryMandate', [id]),
      evaluate(reviewer, 'QueryReservations', [id]),
      evaluate(participant, 'QueryMandate', [id]),
    ]);
    console.log(JSON.stringify({
      label: 'Authorized readback from Drunix; outcome records are verifier attestations, not bank settlement proof',
      channel: channelName,
      mandateId: id,
      reviewer: { mspId: 'Org1MSP', role: 'named verifier', status: reviewerMandate.status, settledPaise: reviewerMandate.settledPaise, reservedPaise: reviewerMandate.reservedPaise },
      participant: { mspId: 'Org2MSP', status: participantMandate.status, settledPaise: participantMandate.settledPaise, reservedPaise: participantMandate.reservedPaise },
      reservations: reviewerReservations.map((entry) => ({ reservationId: entry.reservationId, participantMsp: entry.participantMsp, amountPaise: entry.amountPaise, status: entry.status, reserveTransactionId: entry.reserveTransactionId, dispatchTransactionId: entry.dispatchTransactionId, outcomeTransactionId: entry.outcomeTransactionId, evidenceCommitment: entry.evidenceCommitment })),
    }, null, 2));
  } finally {
    await Promise.all([reviewer.close(), participant.close()]);
  }
}

function runParticipantProcess(org, request, identity) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--participant-worker'], {
    cwd: process.cwd(),
    env: { ...process.env, DRUNIX_DEMO_RUN_ID: runId, DRUNIX_DEMO_WORKER_ORG: String(org) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    passport: { token: identity.token },
    args: request.purchase.args,
    purchaseProof: Buffer.from(request.purchase.proof).toString('base64url'),
  }));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`Independent Org${org} participant process exited ${code}: ${stderr.slice(0, 500)}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Independent Org${org} participant process returned invalid output: ${stderr.slice(0, 500)}`)); }
    });
  });
}

function successEvidence(paymentAttemptId, providerMode = 'MOCK') {
  return makeCommitment('payment-outcome', {
    schemaVersion: 1,
    evidenceType: 'PROVIDER_CAPTURED',
    providerMode,
    paymentAttemptId,
    orderReferenceDigest: crypto.createHash('sha256').update(`demo-order:${paymentAttemptId}`).digest('hex'),
  }).digest;
}

function failureEvidence(paymentAttemptId) {
  return makeCommitment('payment-outcome', {
    schemaVersion: 1,
    evidenceType: 'PROVIDER_DEFINITIVE_FAILURE',
    providerMode: 'MOCK',
    paymentAttemptId,
    orderReferenceDigest: null,
  }).digest;
}

function preDispatchCancellationEvidence(paymentAttemptId) {
  return makeCommitment('payment-outcome', {
    schemaVersion: 1,
    evidenceType: 'PRE_DISPATCH_CANCELLED',
    providerMode: 'MOCK',
    paymentAttemptId,
    orderReferenceDigest: null,
  }).digest;
}

async function main() {
  const owner = await makeClient(1, 'User1');
  const other = await makeClient(2, 'User1');
  const verifier = await makeClient(1, 'Admin');
  try {
    const [ownerId, otherId, verifierId] = await Promise.all([
      evaluate(owner, 'GetCallerIdentity'), evaluate(other, 'GetCallerIdentity'), evaluate(verifier, 'GetCallerIdentity'),
    ]);
    assert(ownerId.mspId === 'Org1MSP' && otherId.mspId === 'Org2MSP', 'Demo participant certificates must belong to separate MSPs');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const passport = makePassport('demo-owner', 'demo-agent');
    const signedPassport = signPassport(passport, privateKey);
    const scopeTerms = { schemaVersion: 1, policyVersion: 1, allowedMerchantIds: ['demo_store'], allowedCategories: ['books'] };
    const scope = makeCommitment('passport-scope', scopeTerms);
    const passportTransient = {
      'boundpay.passport.v1': encoder.encode(signedPassport.token),
      'boundpay.scope.v1': encoder.encode(JSON.stringify({ salt: scope.salt.toString('base64url'), payload: scopeTerms })),
    };
    const passportIdentity = { token: signedPassport.token, digest: signedPassport.digest, scopeCommitment: scope.digest };

    const register = await submit(owner, 'RegisterPassportIssuerKey', [keyId, publicKeyPem]);
    const issue = await submit(owner, 'IssueMandate', [
      mandateId, passportId, signedPassport.digest, 'INR', '500000', '300000', '10', scope.digest,
      JSON.stringify([ownerId, otherId]), JSON.stringify([verifierId]),
    ], passportTransient);
    const issued = await evaluate(owner, 'QueryMandate', [mandateId]);
    assert(issued.status === 'ACTIVE' && issued.passportDigest === signedPassport.digest, 'Mandate issue did not commit the signed Passport binding');
    const issuedByOtherParticipant = await evaluate(other, 'QueryMandate', [mandateId]);
    assert(issuedByOtherParticipant.ownerMsp === ownerId.mspId && issuedByOtherParticipant.ownerIdentity === ownerId.clientId, 'Second organization has not observed the issuer identity and committed mandate state');
    const duplicatePassportMandate = await expectRejected(owner, 'IssueMandate', [
      `second-${runId}`, passportId, signedPassport.digest, 'INR', '500000', '300000', '10', scope.digest,
      JSON.stringify([ownerId, otherId]), JSON.stringify([verifierId]),
    ], passportTransient);

    const unauthorizedIssue = await expectRejected(other, 'IssueMandate', [
      `bad-${runId}`, passportId, signedPassport.digest, 'INR', '500000', '300000', '10', scope.digest,
      JSON.stringify([ownerId, otherId]), JSON.stringify([verifierId]),
    ], passportTransient);
    const unauthorizedPurchase = makePurchase(passportIdentity, `res-admin-${runId}`, `req-admin-${runId}`, `pay-admin-${runId}`, 50_000, 'sku-book-admin');
    const unauthorizedSpend = await expectRejected(verifier, 'Reserve', unauthorizedPurchase.args, {
      'boundpay.passport.v1': encoder.encode(passportIdentity.token),
      'boundpay.purchase-proof.v1': unauthorizedPurchase.proof,
    });

    const raceRequests = [
      { org: 1, client: owner, request: makeReserveRequest(passportIdentity, `race-a-${runId}`, 300_000, 'sku-book-a') },
      { org: 2, client: other, request: makeReserveRequest(passportIdentity, `race-b-${runId}`, 300_000, 'sku-book-b') },
    ];
    const race = await Promise.all(raceRequests.map(async (candidate) => {
      const outcome = await runParticipantProcess(candidate.org, candidate.request, passportIdentity);
      return outcome.accepted
        ? { accepted: true, reservation: { ...candidate.request, ...outcome, executor: candidate.client } }
        : { accepted: false, reason: outcome.reason };
    }));
    const accepted = race.filter((item) => item.accepted);
    assert(accepted.length === 1, `Expected one of two ₹3,000 concurrent reservations to commit against ₹5,000; got ${accepted.length}; rejected: ${race.filter((item) => !item.accepted).map((item) => item.reason).join(' | ')}`);
    const winner = accepted[0].reservation;
    const ledgerAfterRace = await evaluate(owner, 'QueryReservations', [mandateId]);
    assert(ledgerAfterRace.length === 1 && ledgerAfterRace[0].status === 'RESERVED', 'The race left more than one committed reservation');
    assert(issued.aggregateCapPaise >= ledgerAfterRace.reduce((total, item) => total + item.amountPaise, 0), 'Committed reservations exceeded the shared allowance');

    const duplicate = await submit(winner.executor, 'Reserve', winner.purchase.args, winner.transientData);
    const afterDuplicate = await evaluate(owner, 'QueryReservations', [mandateId]);
    assert(duplicate.value.reservationId === winner.reservationId && afterDuplicate.length === 1, 'Same-content retry created an additional reservation');

    const changed = makePurchase(passportIdentity, winner.reservationId, winner.requestId, winner.paymentAttemptId, 300_001, 'sku-book-a');
    await expectRejected(winner.executor, 'Reserve', changed.args, {
      'boundpay.passport.v1': encoder.encode(passportIdentity.token),
      'boundpay.purchase-proof.v1': changed.proof,
    });

    const unauthorizedRevoke = await expectRejected(other, 'RevokeFutureAuthority', [mandateId]);
    const dispatch = await submit(winner.executor, 'BeginDispatch', [mandateId, winner.reservationId]);
    const dispatchState = await evaluate(winner.executor, 'QueryReservation', [mandateId, winner.reservationId]);
    assert(dispatchState.status === 'DISPATCHING' && dispatchState.dispatchTransactionId === dispatch.transactionId, 'Dispatch claim was not confirmed by queried ledger state');
    // This callback is deliberately a local MOCK-only counter; no provider or payment rail is called.
    mockDispatchCalls++;
    const unauthorizedOutcome = await expectRejected(other, 'CommitOutcome', [mandateId, winner.reservationId, successEvidence(winner.paymentAttemptId)]);
    const stillDispatching = await evaluate(winner.executor, 'QueryReservation', [mandateId, winner.reservationId]);
    assert(stillDispatching.status === 'DISPATCHING', 'An unauthorized identity changed the reservation outcome');
    const settled = await submit(verifier, 'CommitOutcome', [mandateId, winner.reservationId, successEvidence(winner.paymentAttemptId)]);
    const settledState = await evaluate(owner, 'QueryMandate', [mandateId]);
    assert(settledState.settledPaise === 300_000 && settledState.reservedPaise === 0, 'Verified success was not committed to shared totals');

    // The exact INR 2,000 remainder can be held, while any further positive
    // request is denied. Release this never-dispatched hold before recovery cases.
    const exactRemainder = await reserve(other, passportIdentity, `remainder-${runId}`, 200_000, 'sku-book-remainder');
    const overLimit = makePurchase(passportIdentity, `res-over-${runId}`, `req-over-${runId}`, `pay-over-${runId}`, 1, 'sku-book-over');
    const overLimitReason = await expectRejected(owner, 'Reserve', overLimit.args, {
      'boundpay.passport.v1': encoder.encode(passportIdentity.token),
      'boundpay.purchase-proof.v1': overLimit.proof,
    });
    const releasedRemainder = await submit(other, 'ReleaseDefinitiveFailure', [mandateId, exactRemainder.reservationId, preDispatchCancellationEvidence(exactRemainder.paymentAttemptId)]);
    const remainderState = await evaluate(owner, 'QueryReservation', [mandateId, exactRemainder.reservationId]);
    assert(remainderState.status === 'RELEASED', 'A never-dispatched exact-remainder hold was not released');

    const secondParticipant = winner.executor === owner ? other : owner;
    const uncertain = await reserve(secondParticipant, passportIdentity, `unknown-${runId}`, 100_000, 'sku-book-reconcile');
    await submit(secondParticipant, 'BeginDispatch', [mandateId, uncertain.reservationId]);
    const markedUnknown = await submit(secondParticipant, 'MarkUnknown', [mandateId, uncertain.reservationId]);
    const unknownState = await evaluate(secondParticipant, 'QueryReservation', [mandateId, uncertain.reservationId]);
    assert(unknownState.status === 'UNKNOWN', 'Unknown provider outcome was not retained on Drunix');
    const reconcilingParticipant = secondParticipant === owner ? other : owner;
    const unauthorizedUnknownRetry = await expectRejected(reconcilingParticipant, 'MarkUnknown', [mandateId, uncertain.reservationId]);
    const reconciled = await submit(verifier, 'CommitOutcome', [mandateId, uncertain.reservationId, successEvidence(uncertain.paymentAttemptId)]);
    const reconciledState = await evaluate(owner, 'QueryReservation', [mandateId, uncertain.reservationId]);
    assert(reconciledState.status === 'SETTLED', 'Verifier reconciliation did not resolve UNKNOWN successfully');

    const pendingRelease = await reserve(other, passportIdentity, `pre-revoke-${runId}`, 50_000, 'sku-book-failure');
    const revoke = await submit(owner, 'RevokeFutureAuthority', [mandateId]);
    const revoked = await evaluate(owner, 'QueryMandate', [mandateId]);
    assert(revoked.status === 'REVOKED', 'Revocation is not visible as committed state');
    const oldReservationRetry = await submit(other, 'Reserve', pendingRelease.purchase.args, pendingRelease.transientData);
    const newAfterRevoke = makePurchase(passportIdentity, `res-after-${runId}`, `req-after-${runId}`, `pay-after-${runId}`, 50_000, 'sku-book-after-revoke');
    await expectRejected(owner, 'Reserve', newAfterRevoke.args, {
      'boundpay.passport.v1': encoder.encode(passportIdentity.token),
      'boundpay.purchase-proof.v1': newAfterRevoke.proof,
    });
    const released = await submit(other, 'ReleaseDefinitiveFailure', [mandateId, pendingRelease.reservationId, failureEvidence(pendingRelease.paymentAttemptId)]);
    const releaseState = await evaluate(other, 'QueryReservation', [mandateId, pendingRelease.reservationId]);
    assert(releaseState.status === 'RELEASED', 'Definitive failure did not release the existing pre-revocation reservation');
    assert(mockDispatchCalls === 1, `Expected exactly one MOCK dispatch after a verified claim; got ${mockDispatchCalls}`);
    const finalMandate = await waitForState(owner, 'QueryMandate', [mandateId], (value) => value.status === 'REVOKED' && value.settledPaise === 400_000 && value.reservedPaise === 0, 'Final mandate totals');
    const reviewerMandate = await waitForState(verifier, 'QueryMandate', [mandateId], (value) => value.status === 'REVOKED' && value.settledPaise === 400_000 && value.reservedPaise === 0, 'Reviewer mandate totals');
    const reviewerReservations = await waitForState(verifier, 'QueryReservations', [mandateId], (value) => value.length >= 4 && value.some((item) => item.reservationId === winner.reservationId && item.outcomeTransactionId === settled.transactionId) && value.some((item) => item.reservationId === pendingRelease.reservationId && item.status === 'RELEASED'), 'Reviewer reservation evidence');

    console.log(JSON.stringify({
      network: 'DRUNIX v1.0.0 local test network',
      reservationRacers: 'two separate Node processes using Org1MSP and Org2MSP certificates',
      channel: channelName,
      chaincode: chaincodeName,
      identities: { owner: ownerId, participantA: ownerId, participantB: otherId, verifier: verifierId },
      mandateId,
      passportId,
      transactions: {
        registerIssuerKey: register.transactionId,
        issueMandate: issue.transactionId,
        raceAccepted: winner.transactionId,
        dispatchClaim: dispatch.transactionId,
        outcomeCommit: settled.transactionId,
        unknownMark: markedUnknown.transactionId,
        unknownResolution: reconciled.transactionId,
        revoke: revoke.transactionId,
        existingReservationRetry: oldReservationRetry.transactionId,
        failureRelease: released.transactionId,
        exactRemainder: exactRemainder.transactionId,
        preDispatchCancellation: releasedRemainder.transactionId,
      },
      timingsMs: {
        definition: 'Client wall-clock timing from before Gateway submitAsync to VALID commit status; submitAcceptedToCommit begins after submitAsync returns. Local sample network only.',
        issue: { clientRequestToCommitMs: issue.clientRequestToCommitMs, submitAcceptedToCommitMs: issue.submitAcceptedToCommitMs },
        raceWinner: { clientRequestToCommitMs: winner.clientRequestToCommitMs, submitAcceptedToCommitMs: winner.submitAcceptedToCommitMs },
        duplicateReserve: { clientRequestToCommitMs: duplicate.clientRequestToCommitMs, submitAcceptedToCommitMs: duplicate.submitAcceptedToCommitMs },
        laterReserves: [uncertain, pendingRelease].map((result) => ({ clientRequestToCommitMs: result.clientRequestToCommitMs, submitAcceptedToCommitMs: result.submitAcceptedToCommitMs })),
        dispatchClaim: { clientRequestToCommitMs: dispatch.clientRequestToCommitMs, submitAcceptedToCommitMs: dispatch.submitAcceptedToCommitMs },
        outcome: { clientRequestToCommitMs: settled.clientRequestToCommitMs, submitAcceptedToCommitMs: settled.submitAcceptedToCommitMs },
      },
      checks: {
        exactlyOneConcurrentReservation: accepted.length === 1,
        exactRemainderReservedAndOverLimitRejected: Boolean(exactRemainder.transactionId) && Boolean(overLimitReason) && remainderState.status === 'RELEASED',
        duplicateReservationIdempotent: afterDuplicate.length === 1,
        changedContentReuseRejected: true,
        onePassportCannotCreateASecondSharedAllowance: Boolean(duplicatePassportMandate),
        unauthorizedIssueRejected: Boolean(unauthorizedIssue),
        unauthorizedSpendRejected: Boolean(unauthorizedSpend),
        unauthorizedRevokeRejected: Boolean(unauthorizedRevoke),
        unauthorizedOutcomeRejected: Boolean(unauthorizedOutcome),
        unauthorizedUnknownUpdateRejected: Boolean(unauthorizedUnknownRetry),
        dispatchOnlyAfterCommittedClaim: mockDispatchCalls === 1,
        timeoutRemainsReservedUntilReconciliation: unknownState.status === 'UNKNOWN' && reconciledState.status === 'SETTLED',
        revocationBlocksNewReservations: revoked.status === 'REVOKED' && releaseState.status === 'RELEASED',
        authorizedReviewerReadback: reviewerMandate.status === 'REVOKED' && reviewerReservations.length >= 4,
      },
      paymentLabel: 'MOCK ONLY — the script makes no provider or bank payment call',
      finalTotals: { settledPaise: finalMandate.settledPaise, reservedPaise: finalMandate.reservedPaise, availablePaise: finalMandate.aggregateCapPaise - finalMandate.settledPaise - finalMandate.reservedPaise },
    }, null, 2));
  } finally {
    await Promise.all([owner.close(), other.close(), verifier.close()]);
  }
}

if (process.argv.includes('--participant-worker')) {
  participantWorker().catch((error) => {
    console.error(`Drunix participant worker failed: ${error.message}`);
    process.exitCode = 1;
  });
} else if (process.argv.includes('--inspect-mandate')) {
  inspectMandate(process.argv[process.argv.indexOf('--inspect-mandate') + 1]).catch((error) => {
    console.error(`Drunix reviewer readback failed: ${error.message}`);
    process.exitCode = 1;
  });
} else main().catch((error) => {
  console.error(`Drunix shared-authority demo failed: ${error.message}`);
  process.exitCode = 1;
});
