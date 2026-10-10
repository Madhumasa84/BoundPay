import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/prepare-drunix-local-network.sh');
const commit = '3fb2b135a5b2adf7e1071d9b1624052a1bbb1772';
const peer = 'npcioss/drunix-peer@sha256:dac28b37f9bd724d34edb7f1c20ca5b987667efa3270809f2ed1507fcf5f754f';
const vscc = 'npcioss/drunix-vscc@sha256:9156b22fb4c9a02747d30515ec7e04183f246fea02df8edfc1d0821c496f6664';
const keydb = 'eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac';
const directories: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundpay-prepare-test-'));
  directories.push(root);
  const network = path.join(root, 'drunix-network/test-network');
  const files = {
    yugabyte: path.join(network, 'scripts/yugabyte/compose.yaml'),
    base: path.join(network, 'compose/compose-test-net.yaml'),
    docker: path.join(network, 'compose/docker/docker-compose-test-net.yaml'),
    peer: path.join(network, 'compose/docker/peercfg/core.yaml'),
  };
  for (const file of Object.values(files)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.yugabyte, [
    ...Array(2).fill('    image: yugabytedb/yugabyte:2025.2.0.0-b131\n    command: ["bin/yugabyted", "start", "--background=false"]'),
    ...Array(2).fill('    image: eqalpha/keydb'),
  ].join('\n') + '\n');
  fs.writeFileSync(files.base, [
    ...Array(4).fill('    image: npcioss/drunix-peer:1.0.0'),
    '    image: npcioss/drunix-orderer:1.0.0',
    ...Array(2).fill('    image: npcioss/drunix-vscc:1.0.0'),
  ].join('\n') + '\n');
  fs.writeFileSync(files.docker, [
    ...Array(4).fill('    image: npcioss/drunix-peer:1.0.0'),
    ...Array(2).fill('    image: npcioss/drunix-vscc:1.0.0'),
  ].join('\n') + '\n');
  fs.writeFileSync(files.peer, '    builder: $(DOCKER_NS)/drunix-ccenv:$(TWO_DIGIT_VERSION)\n        runtime: $(DOCKER_NS)/drunix-baseos:$(TWO_DIGIT_VERSION)\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Replace only the external git lookup; exercise the real preparation script and files.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$BOUNDPAY_TEST_GIT_COMMIT"\n', { mode: 0o755 });
  const run = (revision = commit) => spawnSync('sh', [script, root], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOUNDPAY_TEST_GIT_COMMIT: revision },
  });
  return { files, run };
}

afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Drunix local network preparation', () => {
  it('actually installs both local Yugabyte clock overrides', () => {
    const { files, run } = fixture();
    expect(run().status).toBe(0);
    const content = fs.readFileSync(files.yugabyte, 'utf8');
    expect(content.match(/--master_flags=max_clock_skew_usec=1500000/g)).toHaveLength(2);
    expect(content.match(/--tserver_flags=max_clock_skew_usec=1500000/g)).toHaveLength(2);
  });

  it('pins the Docker overlay that overrides the base compose images', () => {
    const { files, run } = fixture();
    expect(run().status).toBe(0);
    const content = fs.readFileSync(files.docker, 'utf8');
    expect(content.split(peer)).toHaveLength(5);
    expect(content.split(vscc)).toHaveLength(3);
    expect(content).not.toContain(':1.0.0');
  });

  it('is safe to run twice without duplicating a digest', () => {
    const { files, run } = fixture();
    expect(run().status).toBe(0);
    const first = Object.values(files).map((file) => fs.readFileSync(file, 'utf8'));
    expect(run().status).toBe(0);
    expect(Object.values(files).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(first);
    expect(first[0].split(keydb)).toHaveLength(3);
  });

  it('refuses an unexpected image digest instead of appending a second digest', () => {
    const { files, run } = fixture();
    const original = fs.readFileSync(files.yugabyte, 'utf8').replaceAll('eqalpha/keydb', 'eqalpha/keydb@sha256:unexpected');
    fs.writeFileSync(files.yugabyte, original);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Applied');
    expect(fs.readFileSync(files.yugabyte, 'utf8')).not.toContain('@sha256:unexpected@sha256:');
  });

  it('refuses an unsupported Drunix revision before changing files', () => {
    const { files, run } = fixture();
    const before = fs.readFileSync(files.yugabyte, 'utf8');
    expect(run('unsupported-revision').status).toBe(1);
    expect(fs.readFileSync(files.yugabyte, 'utf8')).toBe(before);
  });
});
