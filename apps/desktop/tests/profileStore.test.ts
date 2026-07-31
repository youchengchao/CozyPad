import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileStore } from '../src/main/profileStore';
import type { ProfileCrypto } from '../src/main/profileStore';

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

function tempStore(available = true): ProfileStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
  return new ProfileStore(path.join(dir, 'profiles.json'), fakeCrypto(available));
}

const DRAFT = {
  name: 'Lab box',
  host: '10.0.0.5',
  port: 22,
  username: 'ycchao',
  authMethod: 'password' as const,
};

describe('ProfileStore', () => {
  it('saves and lists profiles without exposing passwords', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });
    expect(saved.hasPassword).toBe(true);
    expect(saved.credentialPersisted).toBe(true);
    expect(JSON.stringify(store.list())).not.toContain('s3cret');
  });

  it('round-trips a remembered password through the crypto layer', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });
    expect(store.getCredential(saved.id)).toEqual({
      authMethod: 'password',
      password: 's3cret',
    });
  });

  it('persists across reload, keeping the encrypted password', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const first = new ProfileStore(file, fakeCrypto());
    const saved = await first.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });

    const second = new ProfileStore(file, fakeCrypto());
    await second.load();
    expect(second.get(saved.id)?.hasPassword).toBe(true);
    expect(second.getCredential(saved.id)).toEqual({
      authMethod: 'password',
      password: 's3cret',
    });
  });

  it('encrypts all profile metadata and credentials at rest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const store = new ProfileStore(file, fakeCrypto());
    await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });

    const raw = readFileSync(file, 'utf8');
    for (const sensitiveValue of [
      DRAFT.name,
      DRAFT.host,
      DRAFT.username,
      's3cret',
    ]) {
      expect(raw).not.toContain(sensitiveValue);
    }
    expect(JSON.parse(raw)).toMatchObject({
      format: 'cozypad-profile-store',
      version: 2,
    });
  });

  it('migrates legacy plaintext metadata to the encrypted store format', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const crypto = fakeCrypto();
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'legacy-profile',
          ...DRAFT,
          authMethod: undefined,
          encryptedPassword: crypto.encrypt('legacy-password'),
        },
      ]),
      'utf8',
    );
    const store = new ProfileStore(file, crypto);
    await store.load();

    expect(store.get('legacy-profile')).toMatchObject({
      authMethod: 'password',
      hasPassword: true,
      hasPrivateKey: false,
    });
    expect(store.getCredential('legacy-profile')).toEqual({
      authMethod: 'password',
      password: 'legacy-password',
    });
    const migrated = readFileSync(file, 'utf8');
    expect(migrated).not.toContain('legacy-profile');
    expect(migrated).not.toContain(DRAFT.host);
    expect(JSON.parse(migrated)).toMatchObject({
      format: 'cozypad-profile-store',
      version: 2,
    });
  });

  it('keeps non-remembered passwords in memory only', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const first = new ProfileStore(file, fakeCrypto());
    const saved = await first.save({
      ...DRAFT,
      password: 'temp-pw',
      rememberCredential: false,
    });
    expect(first.getCredential(saved.id)).toEqual({
      authMethod: 'password',
      password: 'temp-pw',
    });
    expect(saved.credentialPersisted).toBe(false);

    const renamed = await first.save({
      ...DRAFT,
      id: saved.id,
      name: 'Renamed transient box',
      rememberCredential: false,
    });
    expect(renamed.credentialPersisted).toBe(false);
    expect(first.getCredential(saved.id)).toEqual({
      authMethod: 'password',
      password: 'temp-pw',
    });

    const second = new ProfileStore(file, fakeCrypto());
    await second.load();
    expect(second.getCredential(saved.id)).toBeNull();
    expect(second.get(saved.id)?.hasPassword).toBe(false);
  });

  it('refuses to persist a password when OS crypto is unavailable', async () => {
    const store = tempStore(false);
    await expect(
      store.save({ ...DRAFT, password: 's3cret', rememberCredential: true }),
    ).rejects.toThrow('secure storage unavailable');
  });

  it('refuses to persist metadata when OS crypto is unavailable', async () => {
    const store = tempStore(false);
    await expect(
      store.save({ ...DRAFT, rememberCredential: false }),
    ).rejects.toThrow('secure storage unavailable');
  });

  it('leaves a legacy store untouched when secure migration is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const legacy = JSON.stringify([{ id: 'legacy-profile', ...DRAFT }]);
    writeFileSync(file, legacy, 'utf8');

    const store = new ProfileStore(file, fakeCrypto(false));
    await expect(store.load()).rejects.toThrow('secure storage unavailable');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
  });

  it('removes profiles and their passwords', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });
    await store.remove(saved.id);
    expect(store.list()).toHaveLength(0);
    expect(store.getCredential(saved.id)).toBeNull();
  });

  it('writes atomically so a crash cannot leave a half-written file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const store = new ProfileStore(file, fakeCrypto());
    await store.save({ ...DRAFT, rememberCredential: false });

    // 寫入完成後不得留下暫存檔，且內容必須是完整可解析的 JSON。
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toMatchObject({
      format: 'cozypad-profile-store',
      version: 2,
    });
  });

  it('fails closed without overwriting a corrupt profiles file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const corrupt = '{ this is not json';
    writeFileSync(file, corrupt, 'utf8');
    const store = new ProfileStore(file, fakeCrypto());
    await expect(store.load()).rejects.toThrow('profile store is corrupt');
    expect(store.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(corrupt);
  });

  it('fails closed when encrypted profile data cannot be decrypted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'cozypad-profile-store',
        version: 2,
        encryptedPayload: 'not-valid-ciphertext',
      }),
      'utf8',
    );
    const store = new ProfileStore(file, fakeCrypto());

    await expect(store.load()).rejects.toThrow('Unable to decrypt');
    expect(store.list()).toEqual([]);
  });

  it('updates an existing profile without losing the stored password', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });
    const updated = await store.save({
      ...DRAFT,
      id: saved.id,
      name: 'Renamed box',
      rememberCredential: true,
    });
    expect(updated.name).toBe('Renamed box');
    expect(store.getCredential(saved.id)).toEqual({
      authMethod: 'password',
      password: 's3cret',
    });
  });

  it('does not reuse a remembered password after the SSH target changes', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: true,
    });
    const updated = await store.save({
      ...DRAFT,
      id: saved.id,
      host: 'attacker.example',
      rememberCredential: true,
    });

    expect(updated.hasPassword).toBe(false);
    expect(store.getCredential(saved.id)).toBeNull();
  });

  it('round-trips a remembered private key and passphrase without exposing either', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cozypad-profiles-'));
    const file = path.join(dir, 'profiles.json');
    const first = new ProfileStore(file, fakeCrypto());
    const privateKey = 'test-private-key-material';
    const passphrase = 'test-passphrase';
    const saved = await first.save({
      ...DRAFT,
      authMethod: 'privateKey',
      privateKey,
      passphrase,
      rememberCredential: true,
    });

    expect(saved).toMatchObject({
      authMethod: 'privateKey',
      hasPassword: false,
      hasPrivateKey: true,
    });
    expect(JSON.stringify(first.list())).not.toContain(privateKey);
    expect(JSON.stringify(first.list())).not.toContain(passphrase);

    const second = new ProfileStore(file, fakeCrypto());
    await second.load();
    expect(second.getCredential(saved.id)).toEqual({
      authMethod: 'privateKey',
      privateKey,
      passphrase,
    });
  });

  it('clears credentials from the previous authentication mode', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      password: 's3cret',
      rememberCredential: false,
    });
    const switched = await store.save({
      ...DRAFT,
      id: saved.id,
      authMethod: 'privateKey',
      privateKey: 'test-private-key-material',
      rememberCredential: false,
    });

    expect(switched.hasPassword).toBe(false);
    expect(store.getCredential(saved.id)).toEqual({
      authMethod: 'privateKey',
      privateKey: 'test-private-key-material',
    });
  });

  it('does not reuse a transient private key after the SSH target changes', async () => {
    const store = tempStore();
    const saved = await store.save({
      ...DRAFT,
      authMethod: 'privateKey',
      privateKey: 'test-private-key-material',
      rememberCredential: false,
    });
    const updated = await store.save({
      ...DRAFT,
      id: saved.id,
      username: 'different-user',
      authMethod: 'privateKey',
      rememberCredential: false,
    });

    expect(updated.hasPrivateKey).toBe(false);
    expect(store.getCredential(saved.id)).toBeNull();
  });
});
