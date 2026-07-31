import type {
  ConnectionProfile,
  ConnectionState,
  ConnectionStateChanged,
  PlatformBridge,
  RemoteSettings,
  TelemetrySnapshot,
  TmuxStatus,
  TerminalClosedEvent,
  TerminalOutputEvent,
} from '@cozypad/contracts';
import { base64ToBytes, bytesToBase64 } from '@cozypad/contracts';
import {
  MockPtyEngine,
  MockRemoteFs,
  MockTelemetryGenerator,
} from '@cozypad/test-fixtures';

const MOCK_PROFILE: ConnectionProfile = {
  id: 'mock-local',
  name: 'Mock Host (browser)',
  host: 'mock.local',
  port: 22,
  username: 'cozy',
  authMethod: 'password',
  hasPassword: true,
  credentialPersisted: false,
};

const MOCK_TMUX_STATUS: TmuxStatus = {
  installed: true,
  version: '3.5a',
  path: '/usr/bin/tmux',
  userLevel: false,
  satisfiesTarget: true,
  targetVersion: '3.5a',
  canInstall: true,
  missingTools: [],
  extraBuilds: [],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MockBridgeExtras {
  /** 模擬非預期斷線，供重連機制的 UI 驗證用。 */
  simulateDrop(): void;
}

/** 純瀏覽器模式的 PlatformBridge：讓 UI 開發完全不需要 Electron 或真實主機。 */
export function createMockBridge(): PlatformBridge & MockBridgeExtras {
  const stateListeners = new Set<(event: ConnectionStateChanged) => void>();
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  const closedListeners = new Set<(event: TerminalClosedEvent) => void>();
  const telemetryListeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  const terminals = new Map<string, MockPtyEngine>();
  const remoteFs = new MockRemoteFs();
  const telemetry = new MockTelemetryGenerator();
  let profiles: ConnectionProfile[] = [MOCK_PROFILE];
  const passwords = new Map<string, string>([[MOCK_PROFILE.id, 'mock']]);
  const privateKeys = new Map<string, string>();
  let connectedProfileId: string | null = null;
  let nextTerminalId = 1;
  let nextProfileId = 1;
  let remoteSettings: RemoteSettings = { tmuxMouseMode: true, tmuxSocket: 'default' };
  let fallbackClipboard = '';

  const emitState = (
    profileId: string,
    state: ConnectionState,
    error?: string,
  ): void => {
    const event: ConnectionStateChanged = {
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    };
    stateListeners.forEach((listener) => listener(event));
  };

  const closeAllTerminals = (): void => {
    for (const engine of terminals.values()) engine.close();
    terminals.clear();
  };

  return {
    kind: 'mock',

    getAppInfo: () => Promise.resolve({ mockData: true }),

    listProfiles: () => Promise.resolve([...profiles]),

    saveProfile(draft) {
      const id = draft.id ?? `mock-p${nextProfileId++}`;
      if (draft.authMethod === 'privateKey') {
        passwords.delete(id);
        if (draft.privateKey) privateKeys.set(id, draft.privateKey);
      } else {
        privateKeys.delete(id);
        if (draft.password) passwords.set(id, draft.password);
      }
      const profile: ConnectionProfile = {
        id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        username: draft.username,
        authMethod: draft.authMethod,
        hasPassword: passwords.has(id),
        hasPrivateKey: privateKeys.has(id),
        credentialPersisted:
          draft.rememberCredential &&
          (passwords.has(id) || privateKeys.has(id)),
      };
      profiles = [...profiles.filter((entry) => entry.id !== id), profile];
      return Promise.resolve(profile);
    },

    deleteProfile({ profileId }) {
      profiles = profiles.filter((profile) => profile.id !== profileId);
      passwords.delete(profileId);
      privateKeys.delete(profileId);
      return Promise.resolve();
    },

    async connect({ profileId }) {
      emitState(profileId, 'connecting');
      await delay(300);
      connectedProfileId = profileId;
      emitState(profileId, 'connected');
      telemetry.start(profileId, (snapshot) =>
        telemetryListeners.forEach((listener) => listener(snapshot)),
      );
    },

    async disconnect({ profileId }) {
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    simulateDrop() {
      if (connectedProfileId === null) return;
      const profileId = connectedProfileId;
      connectedProfileId = null;
      telemetry.stop();
      closeAllTerminals();
      emitState(profileId, 'disconnected');
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async openTerminal(request) {
      if (connectedProfileId === null) throw new Error('mock bridge: not connected');
      const terminalId = `mock-term-${nextTerminalId++}`;
      const engine = new MockPtyEngine(
        {
          onData: (data) => {
            const event: TerminalOutputEvent = {
              terminalId,
              dataBase64: bytesToBase64(data),
            };
            outputListeners.forEach((listener) => listener(event));
          },
          onClose: (info) => {
            terminals.delete(terminalId);
            const event: TerminalClosedEvent = {
              terminalId,
              exitCode: info.exitCode,
            };
            closedListeners.forEach((listener) => listener(event));
          },
        },
        { cols: request.cols, rows: request.rows },
      );
      terminals.set(terminalId, engine);
      setTimeout(() => engine.start(), 30);
      return { terminalId };
    },

    writeTerminal(input) {
      terminals.get(input.terminalId)?.write(base64ToBytes(input.dataBase64));
    },

    resizeTerminal(request) {
      terminals.get(request.terminalId)?.resize(request.cols, request.rows);
      return Promise.resolve();
    },

    closeTerminal(request) {
      terminals.get(request.terminalId)?.close();
      return Promise.resolve();
    },

    onTerminalOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },

    onTerminalClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },

    onTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },

    fsList: (request) => remoteFs.list(request.path),
    fsRead: async (request) => ({
      content: await remoteFs.readText(request.path, request.maxBytes, request.offset),
    }),
    fsReadBytes: async (request) => ({ dataBase64: await remoteFs.readBytes(request.path) }),
    fsWrite: (request) => remoteFs.write(request.path, request.contentBase64),
    fsCreate: (request) => remoteFs.create(request.directory, request.name, request.kind),
    fsRename: (request) => remoteFs.rename(request.path, request.newName),
    fsDuplicate: async (request) => ({ path: await remoteFs.duplicate(request.path) }),
    fsCopy: async (request) => ({
      path: await remoteFs.copyTo(request.sourcePath, request.destinationDirectory),
    }),
    fsMove: async (request) => ({
      path: await remoteFs.moveTo(request.sourcePath, request.destinationDirectory),
    }),
    fsDelete: (request) => remoteFs.remove(request.path),

    onHostKeyPrompt() {
      return () => undefined;
    },
    respondHostKey: () => Promise.resolve(),

    getBackgroundMode: () => Promise.resolve({ supported: false, enabled: false }),
    setBackgroundMode: () => Promise.resolve(),

    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return fallbackClipboard;
      }
    },
    async writeClipboard(text) {
      fallbackClipboard = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 瀏覽器權限不足時只保留內部緩衝
      }
    },

    getTmuxStatus: () => Promise.resolve({ ...MOCK_TMUX_STATUS }),
    installTmux: () =>
      Promise.resolve({ ok: true, status: { ...MOCK_TMUX_STATUS }, log: '' }),
    cleanupRemote: () => Promise.resolve('mock'),
    onTmuxStatus() {
      return () => undefined;
    },
    onTmuxInstallProgress() {
      return () => undefined;
    },
    onTmuxInstallLog() {
      return () => undefined;
    },

    getRemoteSettings: () => Promise.resolve({ ...remoteSettings }),
    setRemoteSettings: (patch) => {
      remoteSettings = { ...remoteSettings, ...patch };
      return Promise.resolve({ ...remoteSettings });
    },
  };
}
