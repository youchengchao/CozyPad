import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostKeyPromptEvent } from '@cozypad/contracts';
import {
  HostKeyGate,
  KnownHostsStore,
  fingerprintSha256,
  parseKeyType,
} from '../src/main/hostKeys';

const PROFILE = {
  id: 'p1',
  name: 'box',
  host: '10.0.0.5',
  port: 22,
  username: 'y',
};

function ed25519KeyBlob(): Uint8Array {
  const type = new TextEncoder().encode('ssh-ed25519');
  const blob = new Uint8Array(4 + type.length + 32);
  new DataView(blob.buffer).setUint32(0, type.length);
  blob.set(type, 4);
  blob.set(new Uint8Array(32).fill(7), 4 + type.length);
  return blob;
}

function tempStore(): KnownHostsStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-hosts-'));
  return new KnownHostsStore(path.join(dir, 'known_hosts.json'));
}

describe('parseKeyType', () => {
  it('extracts the algorithm name from the key blob', () => {
    expect(parseKeyType(ed25519KeyBlob())).toBe('ssh-ed25519');
  });

  it('falls back to unknown on malformed blobs', () => {
    expect(parseKeyType(new Uint8Array([0, 0]))).toBe('unknown');
  });
});

describe('HostKeyGate', () => {
  it('prompts as "new" on first contact and stores the key after acceptance', async () => {
    const store = tempStore();
    const prompts: HostKeyPromptEvent[] = [];
    const gate = new HostKeyGate(store, (event) => prompts.push(event));

    const key = ed25519KeyBlob();
    const verifyPromise = gate.verify(PROFILE, key);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      host: '10.0.0.5',
      port: 22,
      keyType: 'ssh-ed25519',
      status: 'new',
    });

    gate.resolve(prompts[0]!.requestId, true);
    await expect(verifyPromise).resolves.toBe(true);
    expect(store.get('10.0.0.5', 22)).toBe(fingerprintSha256(key));
  });

  it('accepts silently when the fingerprint matches the stored one', async () => {
    const store = tempStore();
    const key = ed25519KeyBlob();
    await store.set('10.0.0.5', 22, fingerprintSha256(key));
    const prompts: HostKeyPromptEvent[] = [];
    const gate = new HostKeyGate(store, (event) => prompts.push(event));

    await expect(gate.verify(PROFILE, key)).resolves.toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it('prompts as "changed" with the previous fingerprint when the key differs', async () => {
    const store = tempStore();
    await store.set('10.0.0.5', 22, 'OLD_FINGERPRINT');
    const prompts: HostKeyPromptEvent[] = [];
    const gate = new HostKeyGate(store, (event) => prompts.push(event));

    const verifyPromise = gate.verify(PROFILE, ed25519KeyBlob());
    expect(prompts[0]).toMatchObject({
      status: 'changed',
      previousFingerprint: 'OLD_FINGERPRINT',
    });

    gate.resolve(prompts[0]!.requestId, false);
    await expect(verifyPromise).resolves.toBe(false);
    expect(store.get('10.0.0.5', 22)).toBe('OLD_FINGERPRINT');
  });

  it('rejecting does not persist the new key', async () => {
    const store = tempStore();
    const prompts: HostKeyPromptEvent[] = [];
    const gate = new HostKeyGate(store, (event) => prompts.push(event));

    const verifyPromise = gate.verify(PROFILE, ed25519KeyBlob());
    gate.resolve(prompts[0]!.requestId, false);
    await expect(verifyPromise).resolves.toBe(false);
    expect(store.get('10.0.0.5', 22)).toBeUndefined();
  });

  it('KnownHostsStore persists across reloads', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-hosts-'));
    const file = path.join(dir, 'known_hosts.json');
    const first = new KnownHostsStore(file);
    await first.set('h', 2222, 'FP');

    const second = new KnownHostsStore(file);
    await second.load();
    expect(second.get('h', 2222)).toBe('FP');
  });
});
