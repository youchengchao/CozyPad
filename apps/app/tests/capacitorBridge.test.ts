import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySnapshot } from '@cozypad/contracts';
import { createCapacitorBridge } from '../src/platform/capacitorBridge';

type SshPlugin = Parameters<typeof createCapacitorBridge>[0];
type SecureStorePlugin = Parameters<typeof createCapacitorBridge>[1];
type DownloadPlugin = Parameters<typeof createCapacitorBridge>[2];

const cpuOutput = [
  'cpu 100 0 20 800 0 0 0 0',
  'cpu0 50 0 10 400 0 0 0 0',
  '__DASHBOARD_CPU_SPLIT__',
  'cpu 120 0 25 855 0 0 0 0',
  'cpu0 60 0 12 428 0 0 0 0',
].join('\n');

function createNativePlugins(): {
  download: DownloadPlugin;
  ssh: SshPlugin;
  store: SecureStorePlugin;
  saveFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
  nativeCredentials: Map<string, Record<string, unknown>>;
} {
  const values = new Map<string, string>();
  const nativeCredentials = new Map<string, Record<string, unknown>>();
  const exec = vi.fn(async ({ command }: { command: string }) => {
    if (command.includes('/proc/stat')) return { output: cpuOutput };
    if (command.includes('free -m')) return { output: '100,200' };
    return { output: '' };
  });
  const connect = vi.fn(async () => undefined);
  const saveFile = vi.fn(
    async ({ fileName }: { fileName: string }) => ({
      fileName,
      cancelled: false,
      location: 'Downloads/CozyPad',
    }),
  );

  const ssh = {
    connect,
    configureCredential: vi.fn(
      async (options: {
        profileId: string;
        host: string;
        port: number;
        username: string;
        authMethod: 'password' | 'privateKey';
        rememberCredential: boolean;
        password?: string;
        privateKey?: string;
        passphrase?: string;
      }) => {
        const supplied =
          options.authMethod === 'password'
            ? options.password !== undefined
            : options.privateKey !== undefined;
        if (supplied) {
          nativeCredentials.set(options.profileId, { ...options });
        } else {
          const existing = nativeCredentials.get(options.profileId);
          const matches =
            existing?.authMethod === options.authMethod &&
            existing.host === options.host &&
            existing.port === options.port &&
            existing.username === options.username;
          if (!matches) {
            nativeCredentials.delete(options.profileId);
          } else if (options.rememberCredential && existing !== undefined) {
            nativeCredentials.set(options.profileId, {
              ...existing,
              rememberCredential: true,
            });
          } else if (existing?.rememberCredential === true) {
            nativeCredentials.delete(options.profileId);
          }
        }
        const current = nativeCredentials.get(options.profileId);
        return {
          hasCredential: current !== undefined,
          credentialPersisted: current?.rememberCredential === true,
        };
      },
    ),
    hasCredential: vi.fn(
      async (options: {
        profileId: string;
        host: string;
        port: number;
        username: string;
        authMethod: 'password' | 'privateKey';
      }) => {
        const existing = nativeCredentials.get(options.profileId);
        return {
          hasCredential:
            existing?.authMethod === options.authMethod &&
            existing.host === options.host &&
            existing.port === options.port &&
            existing.username === options.username,
          credentialPersisted: existing?.rememberCredential === true,
        };
      },
    ),
    deleteCredential: vi.fn(async ({ profileId }: { profileId: string }) => {
      nativeCredentials.delete(profileId);
    }),
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

  const download = { saveFile } satisfies DownloadPlugin;

  return {
    download,
    ssh,
    store,
    saveFile,
    exec,
    connect,
    values,
    nativeCredentials,
  };
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
    const { download, ssh, store, exec } = createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store, download);
    const profile = await bridge.saveProfile({
      name: 'Mobile host',
      host: 'example.test',
      port: 22,
      username: 'cozy',
      authMethod: 'password',
      password: 'test-only',
      rememberCredential: true,
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

  it('keeps a remembered private key native-only after the initial save', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    const { download, ssh, store, connect, values, nativeCredentials } =
      createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store, download);
    const privateKey = 'test-private-key-material';
    const passphrase = 'test-passphrase';

    const passwordProfile = await bridge.saveProfile({
      name: 'Key host',
      host: 'key.example.test',
      port: 22,
      username: 'cozy',
      authMethod: 'password',
      password: 'test-password',
      rememberCredential: true,
    });
    const profile = await bridge.saveProfile({
      id: passwordProfile.id,
      name: 'Key host',
      host: 'key.example.test',
      port: 22,
      username: 'cozy',
      authMethod: 'privateKey',
      privateKey,
      passphrase,
      rememberCredential: true,
    });
    await bridge.connect({ profileId: profile.id });

    expect(ssh.configureCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authMethod: 'privateKey',
        privateKey,
        passphrase,
      }),
    );
    expect(connect).toHaveBeenCalledWith({
      profileId: profile.id,
      host: 'key.example.test',
      port: 22,
      username: 'cozy',
      authMethod: 'privateKey',
    });
    expect(JSON.stringify(connect.mock.calls)).not.toContain(privateKey);
    expect(JSON.stringify(connect.mock.calls)).not.toContain(passphrase);
    expect(JSON.stringify(await bridge.listProfiles())).not.toContain(privateKey);
    expect(JSON.stringify(await bridge.listProfiles())).not.toContain(passphrase);
    expect(JSON.stringify([...values.entries()])).not.toContain(privateKey);
    expect(JSON.stringify([...values.entries()])).not.toContain(passphrase);
    expect(nativeCredentials.get(profile.id)).toMatchObject({ privateKey, passphrase });
    expect(profile).toMatchObject({
      authMethod: 'privateKey',
      hasPassword: false,
      hasPrivateKey: true,
      credentialPersisted: true,
    });
  });

  it('preserves a transient credential when profile metadata is edited', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    const { download, ssh, store, nativeCredentials } = createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store, download);
    const saved = await bridge.saveProfile({
      name: 'Transient host',
      host: 'transient.example.test',
      port: 22,
      username: 'cozy',
      authMethod: 'password',
      password: 'test-only',
      rememberCredential: false,
    });
    const updated = await bridge.saveProfile({
      id: saved.id,
      name: 'Renamed transient host',
      host: saved.host,
      port: saved.port,
      username: saved.username,
      authMethod: 'password',
      rememberCredential: false,
    });

    expect(updated).toMatchObject({
      hasPassword: true,
      credentialPersisted: false,
    });
    expect(nativeCredentials.get(saved.id)).toMatchObject({
      password: 'test-only',
      rememberCredential: false,
    });
  });

  it('forwards the exact filename, bytes and MIME type to the native downloader', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    const { download, ssh, store, saveFile } = createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store, download);

    await expect(
      bridge.saveDownload?.({
        fileName: 'model.safetensors',
        dataBase64: 'AAECAw==',
        mimeType: 'application/octet-stream',
      }),
    ).resolves.toEqual({
      fileName: 'model.safetensors',
      cancelled: false,
      location: 'Downloads/CozyPad',
    });
    expect(saveFile).toHaveBeenCalledWith({
      fileName: 'model.safetensors',
      dataBase64: 'AAECAw==',
      mimeType: 'application/octet-stream',
    });
  });

  it('keeps the bridge usable when an older mobile shell has no download plugin', () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });
    const { ssh, store } = createNativePlugins();
    const bridge = createCapacitorBridge(ssh, store);

    expect(bridge.kind).toBe('capacitor');
    expect(bridge.saveDownload).toBeUndefined();
  });
});
