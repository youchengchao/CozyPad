import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySnapshot } from '@cozypad/contracts';
import { createCapacitorBridge } from '../src/platform/capacitorBridge';

type SshPlugin = Parameters<typeof createCapacitorBridge>[0];
type SecureStorePlugin = Parameters<typeof createCapacitorBridge>[1];

const cpuOutput = [
  'cpu 100 0 20 800 0 0 0 0',
  'cpu0 50 0 10 400 0 0 0 0',
  '__DASHBOARD_CPU_SPLIT__',
  'cpu 120 0 25 855 0 0 0 0',
  'cpu0 60 0 12 428 0 0 0 0',
].join('\n');

function createNativePlugins(): {
  ssh: SshPlugin;
  store: SecureStorePlugin;
  exec: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, string>();
  const exec = vi.fn(async ({ command }: { command: string }) => {
    if (command.includes('/proc/stat')) return { output: cpuOutput };
    if (command.includes('free -m')) return { output: '100,200' };
    return { output: '' };
  });

  const ssh = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    exec,
    openTerminal: vi.fn(async () => ({ terminalId: 'mobile-test' })),
    writeTerminal: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    closeTerminal: vi.fn(async () => undefined),
    respondHostKey: vi.fn(async () => undefined),
    getBackgroundMode: vi.fn(async () => ({ supported: true, enabled: false })),
    setBackgroundMode: vi.fn(async () => undefined),
    isConnected: vi.fn(async () => ({ connected: true })),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  } satisfies SshPlugin;

  const store = {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      values.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      values.delete(key);
    }),
  } satisfies SecureStorePlugin;

  return { ssh, store, exec };
}

describe('createCapacitorBridge telemetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts polling when the listener subscribed before the SSH connection', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    const { ssh, store, exec } = createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store);
    const profile = await bridge.saveProfile({
      name: 'Mobile host',
      host: 'example.test',
      port: 22,
      username: 'cozy',
      password: 'test-only',
      rememberPassword: true,
    });

    let unsubscribe = (): void => undefined;
    const firstSnapshot = new Promise<TelemetrySnapshot>((resolve) => {
      unsubscribe = bridge.onTelemetry(resolve);
    });

    await bridge.connect({ profileId: profile.id });
    const snapshot = await firstSnapshot;

    expect(snapshot.profileId).toBe(profile.id);
    expect(snapshot.cpu?.cores).toHaveLength(1);
    expect(snapshot.memory).toEqual({ usedMb: 100, totalMb: 200 });
    expect(snapshot.gpus).toEqual([]);
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ command: expect.any(String) }));

    unsubscribe();
    await bridge.disconnect({ profileId: profile.id });
  });
});
