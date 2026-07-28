import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore } from '../src/main/profileStore';
import type { ProfileCrypto } from '../src/main/profileStore';

function fakeCrypto(available = true): ProfileCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc(${plain})`,
    decrypt: (encrypted) => {
      const match = /^enc\((.*)\)$/.exec(encrypted);
      if (!match) throw new Error('bad ciphertext');
      return match[1]!;
    },
  };
}

function tempStore(available = true): ProfileStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
  return new ProfileStore(path.join(dir, 'profiles.json'), fakeCrypto(available));
}

const DRAFT = {
  name: 'Lab box',
  host: '10.0.0.5',
  port: 22,
  username: 'ycchao',
};

describe('ProfileStore', () => {
  it('saves and lists profiles without exposing passwords', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberPassword: true,
    });
    expect(saved.hasPassword).toBe(true);
    expect(JSON.stringify(store.list())).not.toContain('s3cret');
  });

  it('round-trips a remembered password through the crypto layer', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberPassword: true,
    });
    expect(store.getPassword(saved.id)).toBe('s3cret');
  });

  it('persists across reload, keeping the encrypted password', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const first = new ProfileStore(file, fakeCrypto());
    const saved = await first.save({
      ...DRAFT,
      password: 's3cret',
      rememberPassword: true,
    });

    const second = new ProfileStore(file, fakeCrypto());
    await second.load();
    expect(second.get(saved.id)?.hasPassword).toBe(true);
    expect(second.getPassword(saved.id)).toBe('s3cret');
  });

  it('keeps non-remembered passwords in memory only', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const first = new ProfileStore(file, fakeCrypto());
    const saved = await first.save({
      ...DRAFT,
      password: 'temp-pw',
      rememberPassword: false,
    });
    expect(first.getPassword(saved.id)).toBe('temp-pw');

    const second = new ProfileStore(file, fakeCrypto());
    await second.load();
    expect(second.getPassword(saved.id)).toBeNull();
    expect(second.get(saved.id)?.hasPassword).toBe(false);
  });

  it('refuses to persist a password when OS crypto is unavailable', async () => {
    const store = tempStore(false);
    await expect(
      store.save({ ...DRAFT, password: 's3cret', rememberPassword: true }),
    ).rejects.toThrow('secure storage unavailable');
  });

  it('removes profiles and their passwords', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberPassword: true,
    });
    await store.remove(saved.id);
    expect(store.list()).toHaveLength(0);
    expect(store.getPassword(saved.id)).toBeNull();
  });

  it('updates an existing profile without losing the stored password', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberPassword: true,
    });
    const updated = await store.save({
      ...DRAFT,
      id: saved.id,
      name: 'Renamed box',
      rememberPassword: true,
    });
    expect(updated.name).toBe('Renamed box');
    expect(store.getPassword(saved.id)).toBe('s3cret');
  });
});
