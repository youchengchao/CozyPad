import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, HostKeyPromptEvent } from '@cozypad/contracts';

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

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.entries =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      this.entries = {};
    }
  }

  get(host: string, port: number): string | undefined {
    return this.entries[`${host}:${port}`];
  }

  async set(host: string, port: number, fingerprint: string): Promise<void> {
    this.entries[`${host}:${port}`] = fingerprint;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 原子寫入：中途當機不會讓 known hosts 變成半截檔而失去信任記錄。
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.entries, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }
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
