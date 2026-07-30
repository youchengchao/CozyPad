import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AuthenticationMethod,
  ConnectionProfile,
  ConnectionProfileDraft,
} from '@cozypad/contracts';

export type ProfileCredential =
  | { authMethod: 'password'; password: string }
  | { authMethod: 'privateKey'; privateKey: string; passphrase?: string };

export interface ProfileCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

export interface ProfileStorePort {
  list(): ConnectionProfile[];
  get(profileId: string): ConnectionProfile | undefined;
  save(draft: ConnectionProfileDraft): Promise<ConnectionProfile>;
  remove(profileId: string): Promise<void>;
  getCredential(profileId: string): ProfileCredential | null;
}

interface StoredProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod?: AuthenticationMethod;
  encryptedPassword?: string;
  encryptedPrivateKey?: string;
  encryptedKeyPassphrase?: string;
}

/**
 * Profile 持久化：metadata 存 JSON，SSH credentials 經 Electron safeStorage 加密。
 * 「不記住」的 credential 只留在記憶體，app 關閉即消失；內容永不回傳 renderer。
 */
export class ProfileStore implements ProfileStorePort {
  private profiles: StoredProfile[] = [];
  private readonly transientCredentials = new Map<string, ProfileCredential>();

  constructor(
    private readonly filePath: string,
    private readonly crypto: ProfileCrypto,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.profiles = Array.isArray(parsed) ? (parsed as StoredProfile[]) : [];
    } catch {
      this.profiles = [];
    }
  }

  list(): ConnectionProfile[] {
    return this.profiles.map((profile) => this.toPublic(profile));
  }

  get(profileId: string): ConnectionProfile | undefined {
    const found = this.profiles.find((profile) => profile.id === profileId);
    return found ? this.toPublic(found) : undefined;
  }

  async save(draft: ConnectionProfileDraft): Promise<ConnectionProfile> {
    const id = draft.id ?? randomUUID();
    const existing = this.profiles.find((profile) => profile.id === id);
    const authMethod = draft.authMethod;
    const existingAuthMethod = existing?.authMethod ?? 'password';
    const targetChanged =
      existing !== undefined &&
      (existing.host !== draft.host ||
        existing.port !== draft.port ||
        existing.username !== draft.username);
    const canReuseExisting = existingAuthMethod === authMethod && !targetChanged;
    const existingTransient = canReuseExisting
      ? this.transientCredentials.get(id)
      : undefined;
    if (existing !== undefined && !canReuseExisting) {
      this.transientCredentials.delete(id);
    }
    let encryptedPassword = canReuseExisting ? existing?.encryptedPassword : undefined;
    let encryptedPrivateKey = canReuseExisting
      ? existing?.encryptedPrivateKey
      : undefined;
    let encryptedKeyPassphrase = canReuseExisting
      ? existing?.encryptedKeyPassphrase
      : undefined;

    const requireCrypto = (): void => {
      if (!this.crypto.isAvailable()) {
        throw new Error('OS secure storage unavailable — refusing to persist SSH credentials');
      }
    };

    if (authMethod === 'password') {
      encryptedPrivateKey = undefined;
      encryptedKeyPassphrase = undefined;
      if (draft.password !== undefined && draft.password !== '') {
        if (draft.rememberCredential) {
          requireCrypto();
          encryptedPassword = this.crypto.encrypt(draft.password);
          this.transientCredentials.delete(id);
        } else {
          encryptedPassword = undefined;
          this.transientCredentials.set(id, { authMethod, password: draft.password });
        }
      } else if (
        draft.rememberCredential &&
        existingTransient?.authMethod === authMethod
      ) {
        requireCrypto();
        encryptedPassword = this.crypto.encrypt(existingTransient.password);
        this.transientCredentials.delete(id);
      } else if (!draft.rememberCredential && existingTransient === undefined) {
        encryptedPassword = undefined;
      }
    } else {
      encryptedPassword = undefined;
      if (draft.privateKey !== undefined && draft.privateKey.trim() !== '') {
        const credential: ProfileCredential = {
          authMethod,
          privateKey: draft.privateKey,
          ...(draft.passphrase === undefined || draft.passphrase === ''
            ? {}
            : { passphrase: draft.passphrase }),
        };
        if (draft.rememberCredential) {
          requireCrypto();
          encryptedPrivateKey = this.crypto.encrypt(credential.privateKey);
          encryptedKeyPassphrase =
            credential.passphrase === undefined
              ? undefined
              : this.crypto.encrypt(credential.passphrase);
          this.transientCredentials.delete(id);
        } else {
          encryptedPrivateKey = undefined;
          encryptedKeyPassphrase = undefined;
          this.transientCredentials.set(id, credential);
        }
      } else if (
        draft.rememberCredential &&
        existingTransient?.authMethod === authMethod
      ) {
        requireCrypto();
        encryptedPrivateKey = this.crypto.encrypt(existingTransient.privateKey);
        encryptedKeyPassphrase =
          existingTransient.passphrase === undefined
            ? undefined
            : this.crypto.encrypt(existingTransient.passphrase);
        this.transientCredentials.delete(id);
      } else if (!draft.rememberCredential && existingTransient === undefined) {
        encryptedPrivateKey = undefined;
        encryptedKeyPassphrase = undefined;
      }
    }

    const stored: StoredProfile = {
      id,
      name: draft.name,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      authMethod,
      ...(encryptedPassword === undefined ? {} : { encryptedPassword }),
      ...(encryptedPrivateKey === undefined ? {} : { encryptedPrivateKey }),
      ...(encryptedKeyPassphrase === undefined ? {} : { encryptedKeyPassphrase }),
    };
    this.profiles = [...this.profiles.filter((profile) => profile.id !== id), stored];
    await this.persist();
    return this.toPublic(stored);
  }

  async remove(profileId: string): Promise<void> {
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    this.transientCredentials.delete(profileId);
    await this.persist();
  }

  getCredential(profileId: string): ProfileCredential | null {
    const transient = this.transientCredentials.get(profileId);
    if (transient !== undefined) return transient;
    const stored = this.profiles.find((profile) => profile.id === profileId);
    if (!stored) return null;
    const authMethod = stored.authMethod ?? 'password';
    try {
      if (authMethod === 'password') {
        return stored.encryptedPassword === undefined
          ? null
          : { authMethod, password: this.crypto.decrypt(stored.encryptedPassword) };
      }
      return stored.encryptedPrivateKey === undefined
        ? null
        : {
            authMethod,
            privateKey: this.crypto.decrypt(stored.encryptedPrivateKey),
            ...(stored.encryptedKeyPassphrase === undefined
              ? {}
              : {
                  passphrase: this.crypto.decrypt(stored.encryptedKeyPassphrase),
                }),
          };
    } catch {
      return null;
    }
  }

  private toPublic(profile: StoredProfile): ConnectionProfile {
    return {
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod ?? 'password',
      hasPassword:
        profile.encryptedPassword !== undefined ||
        this.transientCredentials.get(profile.id)?.authMethod === 'password',
      hasPrivateKey:
        profile.encryptedPrivateKey !== undefined ||
        this.transientCredentials.get(profile.id)?.authMethod === 'privateKey',
      credentialPersisted:
        (profile.authMethod ?? 'password') === 'password'
          ? profile.encryptedPassword !== undefined
          : profile.encryptedPrivateKey !== undefined,
    };
  }

  /** 先寫暫存檔再 rename：寫入中途當機不會留下半截的設定檔。 */
  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.profiles, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }
}

/** mock 模式（COZYPAD_MOCK=1）用的純記憶體實作。 */
export class MemoryProfileStore implements ProfileStorePort {
  private profiles: ConnectionProfile[];
  private readonly credentials = new Map<string, ProfileCredential>();

  constructor(seed: ConnectionProfile[] = []) {
    this.profiles = seed.map((profile) => ({
      ...profile,
      authMethod: profile.authMethod ?? 'password',
      hasPassword: (profile.authMethod ?? 'password') === 'password',
      hasPrivateKey: (profile.authMethod ?? 'password') === 'privateKey',
      credentialPersisted: false,
    }));
  }

  list(): ConnectionProfile[] {
    return [...this.profiles];
  }

  get(profileId: string): ConnectionProfile | undefined {
    return this.profiles.find((profile) => profile.id === profileId);
  }

  save(draft: ConnectionProfileDraft): Promise<ConnectionProfile> {
    const id = draft.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
    const existing = this.profiles.find((profile) => profile.id === id);
    const targetChanged =
      existing !== undefined &&
      (existing.host !== draft.host ||
        existing.port !== draft.port ||
        existing.username !== draft.username);
    if (
      existing !== undefined &&
      (existing.authMethod !== draft.authMethod || targetChanged)
    ) {
      this.credentials.delete(id);
    }
    if (draft.authMethod === 'privateKey') {
      if (draft.privateKey) {
        this.credentials.set(id, {
          authMethod: draft.authMethod,
          privateKey: draft.privateKey,
          ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
        });
      }
    } else if (draft.password) {
      this.credentials.set(id, { authMethod: draft.authMethod, password: draft.password });
    }
    const credential = this.credentials.get(id);
    const profile: ConnectionProfile = {
      id,
      name: draft.name,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      authMethod: draft.authMethod,
      hasPassword: credential?.authMethod === 'password',
      hasPrivateKey: credential?.authMethod === 'privateKey',
      credentialPersisted: false,
    };
    this.profiles = [...this.profiles.filter((entry) => entry.id !== id), profile];
    return Promise.resolve(profile);
  }

  remove(profileId: string): Promise<void> {
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    this.credentials.delete(profileId);
    return Promise.resolve();
  }

  getCredential(profileId: string): ProfileCredential | null {
    return this.credentials.get(profileId) ?? null;
  }
}
