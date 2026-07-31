import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import type { ProfileCrypto } from '../src/main/profileStore';

const PROFILE = {
  id: 'p1',
  name: 'box',
  host: '10.0.0.5',
  port: 22,
  username: 'y',
  authMethod: 'password' as const,
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
  return new KnownHostsStore(path.join(dir, 'known_hosts.json'), fakeCrypto());
}

function fakeCrypto(available = true): ProfileCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `test-v1:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (encrypted) => {
      if (!encrypted.startsWith('test-v1:')) throw new Error('bad ciphertext');
      return Buffer.from(encrypted.slice('test-v1:'.length), 'base64').toString('utf8');
    },
  };
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
  it('uses the OpenSSH SHA256 fingerprint representation', () => {
    expect(fingerprintSha256(ed25519KeyBlob())).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
  });

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

  it('silently migrates the former padded fingerprint representation', async () => {
    const store = tempStore();
    const key = ed25519KeyBlob();
    const current = fingerprintSha256(key);
    const legacy = `${current.replace('SHA256:', '')}=`;
    await store.set('10.0.0.5', 22, legacy);
    const prompts: HostKeyPromptEvent[] = [];
    const gate = new HostKeyGate(store, (event) => prompts.push(event));

    await expect(gate.verify(PROFILE, key)).resolves.toBe(true);
    expect(prompts).toHaveLength(0);
    expect(store.get('10.0.0.5', 22)).toBe(current);
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
    const first = new KnownHostsStore(file, fakeCrypto());
    await first.set('h', 2222, 'FP');

    const second = new KnownHostsStore(file, fakeCrypto());
    await second.load();
    expect(second.get('h', 2222)).toBe('FP');
  });

  it('encrypts host, port and fingerprint at rest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-hosts-'));
    const file = path.join(dir, 'known_hosts.json');
    const store = new KnownHostsStore(file, fakeCrypto());
    await store.set('private.example', 2222, 'SHA256:private-fingerprint');

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('private.example');
    expect(raw).not.toContain('2222');
    expect(raw).not.toContain('private-fingerprint');
    expect(JSON.parse(raw)).toMatchObject({
      format: 'cozypad-known-hosts',
      version: 2,
    });
  });

  it('migrates legacy plaintext host trust to the encrypted store format', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-hosts-'));
    const file = path.join(dir, 'known_hosts.json');
    writeFileSync(
      file,
      JSON.stringify({ 'legacy.example:22': 'SHA256:legacy-fingerprint' }),
      'utf8',
    );
    const store = new KnownHostsStore(file, fakeCrypto());
    await store.load();

    expect(store.get('legacy.example', 22)).toBe('SHA256:legacy-fingerprint');
    const migrated = readFileSync(file, 'utf8');
    expect(migrated).not.toContain('legacy.example');
    expect(JSON.parse(migrated)).toMatchObject({
      format: 'cozypad-known-hosts',
      version: 2,
    });
  });

  it('fails closed without overwriting host trust when crypto is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-hosts-'));
    const file = path.join(dir, 'known_hosts.json');
    const legacy = JSON.stringify({
      'legacy.example:22': 'SHA256:legacy-fingerprint',
    });
    writeFileSync(file, legacy, 'utf8');
    const store = new KnownHostsStore(file, fakeCrypto(false));

    await expect(store.load()).rejects.toThrow('secure storage unavailable');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
  });
});
