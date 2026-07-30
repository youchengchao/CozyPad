import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, HostKeyPromptEvent } from '@cozypad/contracts';
import type { ProfileCrypto } from './profileStore';

const KNOWN_HOSTS_FORMAT = 'cozypad-known-hosts';
const KNOWN_HOSTS_VERSION = 2;

interface EncryptedKnownHostsStore {
  format: typeof KNOWN_HOSTS_FORMAT;
  version: typeof KNOWN_HOSTS_VERSION;
  encryptedPayload: string;
}

export function fingerprintSha256(key: Uint8Array): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

function normalizeSha256Fingerprint(fingerprint: string): string {
  return fingerprint.replace(/^SHA256:/u, '').replace(/=+$/u, '');
}

/** host key blob 開頭是 length-prefixed 演算法名稱（如 ssh-ed25519）。 */
export function parseKeyType(key: Uint8Array): string {
  try {
    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const length = view.getUint32(0);
    if (length < 1 || length > 64 || 4 + length > key.length) return 'unknown';
    return new TextDecoder().decode(key.slice(4, 4 + length));
  } catch {
    return 'unknown';
  }
}

export class KnownHostsStore {
  private entries: Record<string, string> = {};

  constructor(
    private readonly filePath: string,
    private readonly crypto: ProfileCrypto,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = {};
        return;
      }
      throw new Error('Unable to read the Desktop known-hosts store');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Desktop known-hosts store is corrupt');
    }

    if (isStringRecord(parsed)) {
      // v1 stored host, port and fingerprint as plaintext.
      this.entries = parsed;
      await this.persist();
      return;
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Unsupported Desktop known-hosts store format');
    }
    const envelope = parsed as Partial<EncryptedKnownHostsStore>;
    if (
      envelope.format !== KNOWN_HOSTS_FORMAT ||
      envelope.version !== KNOWN_HOSTS_VERSION ||
      typeof envelope.encryptedPayload !== 'string'
    ) {
      throw new Error('Unsupported Desktop known-hosts store format or version');
    }

    this.requireCrypto();
    try {
      const decrypted: unknown = JSON.parse(
        this.crypto.decrypt(envelope.encryptedPayload),
      );
      if (!isStringRecord(decrypted)) throw new Error('invalid entries');
      this.entries = decrypted;
    } catch {
      this.entries = {};
      throw new Error('Unable to decrypt the Desktop known-hosts store');
    }
  }

  get(host: string, port: number): string | undefined {
    return this.entries[`${host}:${port}`];
  }

  async set(host: string, port: number, fingerprint: string): Promise<void> {
    this.requireCrypto();
    this.entries[`${host}:${port}`] = fingerprint;
    await this.persist();
  }

  private requireCrypto(): void {
    if (!this.crypto.isAvailable()) {
      throw new Error(
        'OS secure storage unavailable — refusing to persist Desktop host trust',
      );
    }
  }

  private async persist(): Promise<void> {
    this.requireCrypto();
    const envelope: EncryptedKnownHostsStore = {
      format: KNOWN_HOSTS_FORMAT,
      version: KNOWN_HOSTS_VERSION,
      encryptedPayload: this.crypto.encrypt(JSON.stringify(this.entries)),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 原子寫入：中途當機不會讓 known hosts 變成半截檔而失去信任記錄。
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(envelope, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/**
 * 首次連線 → 顯示 fingerprint 請使用者信任；fingerprint 變更 → 警告（可能是重灌或中間人）。
 * 信任後寫入 known hosts；拒絕則中止連線（SPEC.md 6.1、SPEC_V3 13）。
 */
export class HostKeyGate {
  private readonly pending = new Map<string, (accept: boolean) => void>();
  private static readonly PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

  constructor(
    private readonly store: KnownHostsStore,
    private readonly prompt: (event: HostKeyPromptEvent) => void,
  ) {}

  async verify(profile: ConnectionProfile, key: Uint8Array): Promise<boolean> {
    const fingerprint = fingerprintSha256(key);
    const known = this.store.get(profile.host, profile.port);
    if (
      known !== undefined &&
      normalizeSha256Fingerprint(known) === normalizeSha256Fingerprint(fingerprint)
    ) {
      // Silently migrate the former padded/raw representation.
      if (known !== fingerprint) {
        await this.store.set(profile.host, profile.port, fingerprint);
      }
      return true;
    }

    const requestId = randomUUID();
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, HostKeyGate.PROMPT_TIMEOUT_MS);
      this.pending.set(requestId, (accept) => {
        clearTimeout(timer);
        resolve(accept);
      });
      this.prompt({
        requestId,
        profileId: profile.id,
        host: profile.host,
        port: profile.port,
        keyType: parseKeyType(key),
        fingerprintSha256: fingerprint,
        status: known === undefined ? 'new' : 'changed',
        ...(known === undefined ? {} : { previousFingerprint: known }),
      });
    });

    if (accepted) await this.store.set(profile.host, profile.port, fingerprint);
    return accepted;
  }

  resolve(requestId: string, accept: boolean): void {
    const resolver = this.pending.get(requestId);
    this.pending.delete(requestId);
    resolver?.(accept);
  }
}
