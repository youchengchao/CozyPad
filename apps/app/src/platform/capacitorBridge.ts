import type {
  AppInfo,
  ConnectionProfile,
  ConnectionProfileDraft,
  ConnectionState,
  ConnectionStateChanged,
  HostKeyPromptEvent,
  PlatformBridge,
  RemoteSettings,
  RemoteSettingsPatch,
  TelemetrySnapshot,
  TerminalClosedEvent,
  TerminalOutputEvent,
  TmuxInstallLog,
  TmuxInstallProgress,
  TmuxStatus,
} from '@cozypad/contracts';
import {
  ShellRemoteFiles,
  ShellTelemetry,
  ShellTmuxProvisioner,
  TmuxRemoteSettings,
} from '@cozypad/remote-services';
import { TmuxRuntime } from '@cozypad/tmux-runtime';

/** 原生 plugin 的介面（由 apps/mobile 的 Kotlin 提供）。 */
interface SshPlugin {
  connect(options: {
    host: string;
    port: number;
    username: string;
    password?: string;
    knownFingerprint?: string;
  }): Promise<void>;
  disconnect(): Promise<void>;
  exec(options: {
    command: string;
    timeoutMs?: number;
    streamId?: string;
  }): Promise<{ output: string }>;
  openTerminal(options: { cols: number; rows: number }): Promise<{ terminalId: string }>;
  writeTerminal(options: { terminalId: string; dataBase64: string }): Promise<void>;
  resizeTerminal(options: { terminalId: string; cols: number; rows: number }): Promise<void>;
  closeTerminal(options: { terminalId: string }): Promise<void>;
  respondHostKey(options: { requestId: string; accept: boolean }): Promise<void>;
  getBackgroundMode(): Promise<{ supported: boolean; enabled: boolean }>;
  setBackgroundMode(options: { enabled: boolean; host?: string }): Promise<void>;
  isConnected(): Promise<{ connected: boolean }>;
  addListener(
    event: string,
    handler: (payload: Record<string, unknown>) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

interface SecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface CapacitorGlobal {
  Plugins?: {
    CozyPadSsh?: SshPlugin;
    CozyPadSecureStore?: SecureStorePlugin;
  };
}

export function getCapacitorPlugins(): {
  ssh: SshPlugin;
  store: SecureStorePlugin;
} | null {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  const ssh = capacitor?.Plugins?.CozyPadSsh;
  const store = capacitor?.Plugins?.CozyPadSecureStore;
  return ssh && store ? { ssh, store } : null;
}

const PROFILES_KEY = 'profiles';
const KNOWN_HOSTS_KEY = 'known_hosts';
/** 密碼與 profile metadata 分開存放，避免把所有密碼一起載入記憶體。 */
const passwordKey = (profileId: string): string => `password:${profileId}`;

interface StoredProfile extends ConnectionProfile {
  /** 只記錄有沒有密碼；密碼本身另存於加密儲存。 */
  hasPassword?: boolean;
}

/**
 * 手機端 PlatformBridge：連線由原生 plugin 持有，
 * 檔案／telemetry／tmux 佈建則沿用與桌面相同的 shell 服務層。
 */
export function createCapacitorBridge(
  ssh: SshPlugin,
  store: SecureStorePlugin,
): PlatformBridge {
  const stateListeners = new Set<(event: ConnectionStateChanged) => void>();
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  const closedListeners = new Set<(event: TerminalClosedEvent) => void>();
  const telemetryListeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  const hostKeyListeners = new Set<(event: HostKeyPromptEvent) => void>();
  const tmuxStatusListeners = new Set<(status: TmuxStatus) => void>();
  const installProgressListeners = new Set<(progress: TmuxInstallProgress) => void>();
  const installLogListeners = new Set<(log: TmuxInstallLog) => void>();
  const execStreams = new Map<string, (line: string) => void>();

  let profiles: StoredProfile[] = [];
  let knownHosts: Record<string, string> = {};
  let activeProfileId: string | null = null;
  let connectedProfileId: string | null = null;
  let loaded = false;
  let streamCounter = 0;

  const publicProfile = (profile: StoredProfile): ConnectionProfile => ({
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    hasPassword: profile.hasPassword === true,
  });

  const load = async (): Promise<void> => {
    if (loaded) return;
    const [rawProfiles, rawHosts] = await Promise.all([
      store.get({ key: PROFILES_KEY }),
      store.get({ key: KNOWN_HOSTS_KEY }),
    ]);
    try {
      profiles = rawProfiles.value === null ? [] : (JSON.parse(rawProfiles.value) as StoredProfile[]);
    } catch {
      profiles = [];
    }
    try {
      knownHosts = rawHosts.value === null ? {} : (JSON.parse(rawHosts.value) as Record<string, string>);
    } catch {
      knownHosts = {};
    }
    loaded = true;
  };

  const persistProfiles = () => store.set({ key: PROFILES_KEY, value: JSON.stringify(profiles) });
  const persistHosts = () =>
    store.set({ key: KNOWN_HOSTS_KEY, value: JSON.stringify(knownHosts) });

  const emitState = (profileId: string, state: ConnectionState, error?: string): void => {
    const event: ConnectionStateChanged = {
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    };
    stateListeners.forEach((listener) => listener(event));
  };

  // ── 原生事件轉接 ─────────────────────────────────────────────────────
  void ssh.addListener('connectionState', (payload) => {
    const state = String(payload.state) as ConnectionState;
    // 沒有 activeProfileId 就沒有可重連的目標；帶空字串會讓自動重連連到不存在的 profile。
    if (activeProfileId === null) return;
    if (state === 'connected') {
      connectedProfileId = activeProfileId;
    }
    if (state === 'disconnected' || state === 'error') {
      // 連線已死，繼續輪詢只會每 5 秒失敗一次。
      connectedProfileId = null;
      telemetry.stop();
    }
    emitState(activeProfileId, state, payload.error as string | undefined);
  });
  void ssh.addListener('terminalOutput', (payload) => {
    const event: TerminalOutputEvent = {
      terminalId: String(payload.terminalId),
      dataBase64: String(payload.dataBase64),
    };
    outputListeners.forEach((listener) => listener(event));
  });
  void ssh.addListener('terminalClosed', (payload) => {
    const event: TerminalClosedEvent = { terminalId: String(payload.terminalId) };
    closedListeners.forEach((listener) => listener(event));
  });
  /** requestId → 該次提示的主機與指紋，接受後才寫入 known hosts。 */
  const pendingHostKeys = new Map<string, { host: string; port: number; fingerprint: string }>();

  void ssh.addListener('hostKeyPrompt', (payload) => {
    const previous = String(payload.previousFingerprint ?? '');
    pendingHostKeys.set(String(payload.requestId), {
      host: String(payload.host),
      port: Number(payload.port),
      fingerprint: String(payload.fingerprintSha256),
    });
    const event: HostKeyPromptEvent = {
      requestId: String(payload.requestId),
      profileId: activeProfileId ?? '',
      host: String(payload.host),
      port: Number(payload.port),
      keyType: String(payload.keyType),
      fingerprintSha256: String(payload.fingerprintSha256),
      status: payload.status === 'changed' ? 'changed' : 'new',
      ...(previous === '' ? {} : { previousFingerprint: previous }),
    };
    hostKeyListeners.forEach((listener) => listener(event));
  });
  void ssh.addListener('execLine', (payload) => {
    execStreams.get(String(payload.streamId))?.(String(payload.line));
  });

  /**
   * 程序被 Android 凍結時 watchdog 可能沒機會回報斷線，
   * 回到前景時主動確認一次，讓 UI 的自動重連能接手。
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const profileId = activeProfileId;
    if (profileId === null) return;
    void ssh
      .isConnected()
      .then(({ connected }) => {
        if (!connected) {
          connectedProfileId = null;
          telemetry.stop();
          emitState(profileId, 'disconnected');
        }
      })
      .catch(() => undefined);
  });

  const exec = async (command: string, timeoutMs?: number): Promise<string> => {
    const result = await ssh.exec({
      command,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return result.output;
  };

  const execStream = async (
    command: string,
    onLine: (line: string) => void,
    timeoutMs?: number,
  ): Promise<string> => {
    const streamId = `stream-${streamCounter++}`;
    execStreams.set(streamId, onLine);
    try {
      const result = await ssh.exec({
        command,
        streamId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return result.output;
    } finally {
      execStreams.delete(streamId);
    }
  };

  const files = new ShellRemoteFiles(exec);
  const telemetry = new ShellTelemetry(exec);
  const tmux = new TmuxRuntime(exec);
  const remoteSettings = new TmuxRemoteSettings(tmux);
  const provisioner = new ShellTmuxProvisioner(exec, execStream);
  const startTelemetry = (profileId: string): void => {
    if (telemetryListeners.size === 0) return;
    telemetry.start(profileId, (snapshot) =>
      telemetryListeners.forEach((listener) => listener(snapshot)),
    );
  };

  return {
    kind: 'capacitor',

    getAppInfo: (): Promise<AppInfo> => Promise.resolve({ mockData: false }),

    async listProfiles() {
      await load();
      return profiles.map(publicProfile);
    },

    async saveProfile(draft: ConnectionProfileDraft) {
      await load();
      const id = draft.id ?? `mobile-${Date.now().toString(36)}`;
      const existing = profiles.find((profile) => profile.id === id);

      let hasPassword = existing?.hasPassword === true;
      if (draft.password !== undefined && draft.password !== '' && draft.rememberPassword) {
        // 密碼直接寫進 Android Keystore 加密儲存，不留在 profile 物件裡。
        await store.set({ key: passwordKey(id), value: draft.password });
        hasPassword = true;
      } else if (!draft.rememberPassword) {
        await store.remove({ key: passwordKey(id) });
        hasPassword = false;
      }

      const stored: StoredProfile = {
        id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        username: draft.username,
        hasPassword,
      };
      profiles = [...profiles.filter((profile) => profile.id !== id), stored];
      await persistProfiles();
      return publicProfile(stored);
    },

    async deleteProfile({ profileId }) {
      await load();
      profiles = profiles.filter((profile) => profile.id !== profileId);
      await store.remove({ key: passwordKey(profileId) });
      await persistProfiles();
    },

    async connect({ profileId }) {
      await load();
      const profile = profiles.find((entry) => entry.id === profileId);
      if (!profile) throw new Error(`unknown profile: ${profileId}`);
      activeProfileId = profileId;
      emitState(profileId, 'connecting');
      // 只在此刻取出密碼，用完即棄，不長駐在 JS 記憶體。
      const password = profile.hasPassword
        ? (await store.get({ key: passwordKey(profileId) })).value
        : null;
      try {
        await ssh.connect({
          host: profile.host,
          port: profile.port,
          username: profile.username,
          ...(password === null ? {} : { password }),
          ...(knownHosts[`${profile.host}:${profile.port}`] === undefined
            ? {}
            : { knownFingerprint: knownHosts[`${profile.host}:${profile.port}`]! }),
        });
        connectedProfileId = profileId;
        startTelemetry(profileId);
      } catch (error) {
        connectedProfileId = null;
        emitState(profileId, 'error', error instanceof Error ? error.message : String(error));
        throw error;
      }
      // 與桌面一致：連上後立即偵測 tmux，缺少或過舊時由 UI 詢問安裝。
      void provisioner
        .status()
        .then((status) => tmuxStatusListeners.forEach((listener) => listener(status)))
        .catch(() => undefined);
    },

    async disconnect() {
      connectedProfileId = null;
      telemetry.stop();
      await ssh.disconnect();
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async openTerminal(request) {
      return ssh.openTerminal({ cols: request.cols, rows: request.rows });
    },

    writeTerminal(input) {
      void ssh.writeTerminal(input);
    },

    resizeTerminal(request) {
      return ssh.resizeTerminal(request);
    },

    closeTerminal(request) {
      return ssh.closeTerminal(request);
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
      if (telemetryListeners.size === 1 && connectedProfileId !== null) {
        startTelemetry(connectedProfileId);
      }
      return () => {
        telemetryListeners.delete(listener);
        if (telemetryListeners.size === 0) telemetry.stop();
      };
    },

    fsList: (request) => files.list(request.path),
    fsRead: async (request) => ({
      content: await files.readText(request.path, request.maxBytes, request.offset),
    }),
    fsReadBytes: async (request) => ({ dataBase64: await files.readBytes(request.path) }),
    fsWrite: (request) => files.write(request.path, request.contentBase64),
    fsCreate: (request) => files.create(request.directory, request.name, request.kind),
    fsRename: (request) => files.rename(request.path, request.newName),
    fsDuplicate: async (request) => ({ path: await files.duplicate(request.path) }),
    fsCopy: async (request) => ({
      path: await files.copyTo(request.sourcePath, request.destinationDirectory),
    }),
    fsMove: async (request) => ({
      path: await files.moveTo(request.sourcePath, request.destinationDirectory),
    }),
    fsDelete: (request) => files.remove(request.path),

    onHostKeyPrompt(listener) {
      hostKeyListeners.add(listener);
      return () => hostKeyListeners.delete(listener);
    },

    async respondHostKey(decision) {
      const pending = pendingHostKeys.get(decision.requestId);
      pendingHostKeys.delete(decision.requestId);
      if (decision.accept && pending) {
        knownHosts[`${pending.host}:${pending.port}`] = pending.fingerprint;
        await persistHosts();
      }
      await ssh.respondHostKey(decision);
    },

    getBackgroundMode: () => ssh.getBackgroundMode(),

    async setBackgroundMode(enabled) {
      const profile = profiles.find((entry) => entry.id === activeProfileId);
      await ssh.setBackgroundMode({
        enabled,
        ...(profile === undefined ? {} : { host: `${profile.username}@${profile.host}` }),
      });
    },

    async readClipboard() {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    },

    async writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Android WebView 未授權剪貼簿時忽略
      }
    },

    getRemoteSettings: (): Promise<RemoteSettings> => remoteSettings.get(),
    setRemoteSettings: (patch: RemoteSettingsPatch) => remoteSettings.set(patch),

    getTmuxStatus: () => provisioner.status(),

    installTmux: () =>
      provisioner.install(
        (progress) => installProgressListeners.forEach((listener) => listener(progress)),
        (log) => installLogListeners.forEach((listener) => listener(log)),
      ),

    onTmuxStatus(listener) {
      tmuxStatusListeners.add(listener);
      return () => tmuxStatusListeners.delete(listener);
    },

    onTmuxInstallProgress(listener) {
      installProgressListeners.add(listener);
      return () => installProgressListeners.delete(listener);
    },

    onTmuxInstallLog(listener) {
      installLogListeners.add(listener);
      return () => installLogListeners.delete(listener);
    },

    cleanupRemote: (removeTmuxBinary) => provisioner.cleanup(removeTmuxBinary),
  };
}
