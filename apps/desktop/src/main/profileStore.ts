import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, ConnectionProfileDraft } from '@cozypad/contracts';

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
  getPassword(profileId: string): string | null;
}

interface StoredProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  encryptedPassword?: string;
}

/**
 * Profile 持久化：metadata 存 JSON，密碼經 OS keychain（Electron safeStorage）加密。
 * 「不記住」的密碼只留在記憶體，app 關閉即消失。密碼永不回傳 renderer。
 */
export class ProfileStore implements ProfileStorePort {
  private profiles: StoredProfile[] = [];
  private readonly transientPasswords = new Map<string, string>();

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
    let encryptedPassword = existing?.encryptedPassword;

    if (draft.password !== undefined && draft.password !== '') {
      if (draft.rememberPassword) {
        if (!this.crypto.isAvailable()) {
          throw new Error('OS secure storage unavailable — refusing to persist password');
        }
        encryptedPassword = this.crypto.encrypt(draft.password);
        this.transientPasswords.delete(id);
      } else {
        encryptedPassword = undefined;
        this.transientPasswords.set(id, draft.password);
      }
    } else if (!draft.rememberPassword && existing?.encryptedPassword !== undefined) {
      encryptedPassword = undefined;
    }

    const stored: StoredProfile = {
      id,
      name: draft.name,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      ...(encryptedPassword === undefined ? {} : { encryptedPassword }),
    };
    this.profiles = [...this.profiles.filter((profile) => profile.id !== id), stored];
    await this.persist();
    return this.toPublic(stored);
  }

  async remove(profileId: string): Promise<void> {
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    this.transientPasswords.delete(profileId);
    await this.persist();
  }

  getPassword(profileId: string): string | null {
    const transient = this.transientPasswords.get(profileId);
    if (transient !== undefined) return transient;
    const stored = this.profiles.find((profile) => profile.id === profileId);
    if (!stored?.encryptedPassword) return null;
    try {
      return this.crypto.decrypt(stored.encryptedPassword);
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
      hasPassword:
        profile.encryptedPassword !== undefined ||
        this.transientPasswords.has(profile.id),
    };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.profiles, null, 2), 'utf8');
  }
}

/** mock 模式（COZYPAD_MOCK=1）用的純記憶體實作。 */
export class MemoryProfileStore implements ProfileStorePort {
  private profiles: ConnectionProfile[];
  private readonly passwords = new Map<string, string>();

  constructor(seed: ConnectionProfile[] = []) {
    this.profiles = seed.map((profile) => ({ ...profile, hasPassword: true }));
  }

  list(): ConnectionProfile[] {
    return [...this.profiles];
  }

  get(profileId: string): ConnectionProfile | undefined {
    return this.profiles.find((profile) => profile.id === profileId);
  }

  save(draft: ConnectionProfileDraft): Promise<ConnectionProfile> {
    const id = draft.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
    if (draft.password) this.passwords.set(id, draft.password);
    const profile: ConnectionProfile = {
      id,
      name: draft.name,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      hasPassword: this.passwords.has(id),
    };
    this.profiles = [...this.profiles.filter((entry) => entry.id !== id), profile];
    return Promise.resolve(profile);
  }

  remove(profileId: string): Promise<void> {
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    this.passwords.delete(profileId);
    return Promise.resolve();
  }

  getPassword(profileId: string): string | null {
    return this.passwords.get(profileId) ?? null;
  }
}
