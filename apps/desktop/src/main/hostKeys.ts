import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, HostKeyPromptEvent } from '@cozypad/contracts';

export function fingerprintSha256(key: Uint8Array): string {
  return createHash('sha256').update(key).digest('base64');
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
    await fs.writeFile(this.filePath, JSON.stringify(this.entries, null, 2), 'utf8');
  }
}

/**
 * 首次連線 → 顯示 fingerprint 請使用者信任；fingerprint 變更 → 警告（可能是重灌或中間人）。
 * 信任後寫入 known hosts；拒絕則中止連線（SPEC.md 6.1、SPEC_V3 13）。
 */
export class HostKeyGate {
  private readonly pending = new Map<string, (accept: boolean) => void>();

  constructor(
    private readonly store: KnownHostsStore,
    private readonly prompt: (event: HostKeyPromptEvent) => void,
  ) {}

  async verify(profile: ConnectionProfile, key: Uint8Array): Promise<boolean> {
    const fingerprint = fingerprintSha256(key);
    const known = this.store.get(profile.host, profile.port);
    if (known === fingerprint) return true;

    const requestId = randomUUID();
    const accepted = await new Promise<boolean>((resolve) => {
      this.pending.set(requestId, resolve);
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
