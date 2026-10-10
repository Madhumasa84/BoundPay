import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDrunixSettings } from '@/infrastructure/shared-authority/config';

afterEach(() => vi.unstubAllEnvs());

describe('Drunix role credential separation', () => {
  for (const role of ['participant', 'verifier'] as const) {
    it(`${role} loads only its own key and certificate`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-role-'));
      const file = path.join(directory, 'fixture.pem');
      fs.writeFileSync(file, '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----');
      try {
        for (const [key, value] of Object.entries({ DRUNIX_MANDATE_ID: 'mandate', DRUNIX_CHANNEL: 'channel', DRUNIX_CHAINCODE: 'contract', DRUNIX_MSP_ID: role === 'participant' ? 'Org1MSP' : '', DRUNIX_VERIFIER_MSP_ID: role === 'verifier' ? 'VerifierMSP' : '', DRUNIX_GATEWAY_ENDPOINT: 'localhost:7051', DRUNIX_PEER_HOST_ALIAS: 'peer0.org1.example.com', DRUNIX_PARTICIPANT_IDENTITIES_JSON: '[{"mspId":"Org1MSP","clientId":"participant"}]', DRUNIX_VERIFIER_IDENTITIES_JSON: '[{"mspId":"VerifierMSP","clientId":"verifier"}]', DRUNIX_TLS_ROOT_CERT_FILE: file, DRUNIX_CLIENT_CERT_FILE: role === 'participant' ? file : '', DRUNIX_CLIENT_PRIVATE_KEY_FILE: role === 'participant' ? file : '', DRUNIX_VERIFIER_CLIENT_CERT_FILE: role === 'verifier' ? file : '', DRUNIX_VERIFIER_CLIENT_PRIVATE_KEY_FILE: role === 'verifier' ? file : '' })) vi.stubEnv(key, value);
        expect(getDrunixSettings(role).mspId).toBe(role === 'participant' ? 'Org1MSP' : 'VerifierMSP');
        expect(() => getDrunixSettings(role === 'participant' ? 'verifier' : 'participant')).toThrow();
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
