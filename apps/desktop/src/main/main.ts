import path from 'node:path';
import { BrowserWindow, app, safeStorage, session } from 'electron';
import { IpcChannels } from '@cozypad/contracts';
import { MockRemoteFs, MockTelemetryGenerator } from '@cozypad/test-fixtures';
import { TmuxRuntime } from '@cozypad/tmux-runtime';
import {
  MemoryRemoteSettings,
  TmuxRemoteSettings,
} from '@cozypad/remote-services';
import type { RemoteSettingsPort } from '@cozypad/remote-services';
import { MockTmuxProvisioner, ShellTmuxProvisioner } from '@cozypad/remote-services';
import type { TmuxProvisionerPort } from '@cozypad/remote-services';
import { TmuxSessionWatcher } from './tmuxWatcher';
import type { RemoteFilesPort } from '@cozypad/remote-services';
import { ShellRemoteFiles } from '@cozypad/remote-services';
import { HostKeyGate, KnownHostsStore } from './hostKeys';
import { registerIpc } from './ipc';
import { MemoryProfileStore, ProfileStore } from './profileStore';
import type { ProfileCrypto, ProfileStorePort } from './profileStore';
import { ShellTelemetry } from '@cozypad/remote-services';
import type { TelemetrySource } from '@cozypad/remote-services';
import { MOCK_PROFILE, MockTransport } from './transport/mockTransport';
import { Ssh2Transport } from './transport/ssh2Transport';
import type { TransportPort } from './transport/TransportPort';

const DEV_URL = process.env.COZYPAD_DEV_URL;
/** 所有 agent conversation session 都開在這個 socket（SPEC_V3 §6）。 */
const TMUX_SOCKET = process.env.COZYPAD_TMUX_SOCKET ?? 'default';
const SMOKE_TEST = process.argv.includes('--smoke-test');
const USE_MOCK = process.env.COZYPAD_MOCK === '1' || SMOKE_TEST;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // Monaco 與 pdf.js 的 worker 皆由 Vite 打包成同源檔案；blob: 供 worker bootstrap。
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const electronProfileCrypto: ProfileCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
};

async function createProfileStore(): Promise<ProfileStorePort> {
  if (USE_MOCK) return new MemoryProfileStore([MOCK_PROFILE]);
  const store = new ProfileStore(
    path.join(app.getPath('userData'), 'profiles.json'),
    electronProfileCrypto,
  );
  await store.load();

  const envHost = process.env.COZYPAD_SSH_HOST;
  if (envHost && store.list().length === 0) {
    await store.save({
      name: `env:${envHost}`,
      host: envHost,
      port: Number(process.env.COZYPAD_SSH_PORT ?? 22),
      username: process.env.COZYPAD_SSH_USER ?? 'root',
      authMethod: 'password',
      password: process.env.COZYPAD_SSH_PASSWORD ?? undefined,
      rememberCredential: false,
    });
  }
  return store;
}

interface MainServices {
  transport: TransportPort;
  files: RemoteFilesPort;
  telemetry: TelemetrySource;
  hostKeys: HostKeyGate | null;
  remoteSettings: RemoteSettingsPort;
  tmuxProvisioner: TmuxProvisionerPort;
  tmuxWatcher: TmuxSessionWatcher | null;
}

async function createServices(
  profileStore: ProfileStorePort,
  win: BrowserWindow,
): Promise<MainServices> {
  if (USE_MOCK) {
    return {
      transport: new MockTransport(),
      files: new MockRemoteFs(),
      telemetry: new MockTelemetryGenerator(),
      hostKeys: null,
      remoteSettings: new MemoryRemoteSettings(),
      tmuxProvisioner: new MockTmuxProvisioner(),
      tmuxWatcher: null,
    };
  }

  const knownHosts = new KnownHostsStore(
    path.join(app.getPath('userData'), 'known_hosts.json'),
    electronProfileCrypto,
  );
  await knownHosts.load();
  const hostKeys = new HostKeyGate(knownHosts, (event) => {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.hostKeyPrompt, event);
  });

  const transport = new Ssh2Transport({
    getProfile: (profileId) => profileStore.get(profileId),
    getCredential: (profileId) => profileStore.getCredential(profileId),
    verifyHostKey: (profile, key) => hostKeys.verify(profile, key),
  });
  const exec = (command: string, timeoutMs?: number) => transport.exec(command, timeoutMs);

  const tmux = new TmuxRuntime(exec, TMUX_SOCKET);
  return {
    transport,
    files: new ShellRemoteFiles(exec),
    telemetry: new ShellTelemetry(exec),
    hostKeys,
    remoteSettings: new TmuxRemoteSettings(tmux),
    tmuxProvisioner: new ShellTmuxProvisioner(exec, (command, onLine, timeoutMs) =>
      transport.execStream(command, onLine, timeoutMs),
    ),
    tmuxWatcher: new TmuxSessionWatcher(tmux),
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: USE_MOCK ? 'CozyPad — MOCK 模式（假主機）' : 'CozyPad — SSH 模式',
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) event.preventDefault();
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, 'app-dist', 'index.html'));
  } else {
    void win.loadFile(path.join(__dirname, '../../app/dist/index.html'));
  }
  return win;
}

async function runSmokeTest(win: BrowserWindow): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('load timeout')), 15_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${description}`));
      });
    });
    const title: unknown = await win.webContents.executeJavaScript('document.title');
    const bridgeKind: unknown = await win.webContents.executeJavaScript(
      'window.cozypad && window.cozypad.kind',
    );
    if (title !== 'CozyPad') throw new Error(`unexpected title: ${String(title)}`);
    if (bridgeKind !== 'electron') {
      throw new Error(`bridge not exposed, kind: ${String(bridgeKind)}`);
    }

    const roundTrip: unknown = await win.webContents.executeJavaScript(
      `(async () => {
        const bridge = window.cozypad;
        const chunks = [];
        bridge.onTerminalOutput((event) => chunks.push(event.dataBase64));
        await bridge.connect({ profileId: 'mock-electron' });
        const { terminalId } = await bridge.openTerminal({
          profileId: 'mock-electron', cols: 80, rows: 24,
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        bridge.writeTerminal({ terminalId, dataBase64: btoa('ls\\r') });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const text = chunks.map((chunk) => atob(chunk)).join('');
        return JSON.stringify({
          banner: text.includes('CozyPad mock shell'),
          ls: text.includes('cozypad.study.yaml'),
        });
      })()`,
    );
    const verdict = JSON.parse(String(roundTrip)) as { banner: boolean; ls: boolean };
    if (!verdict.banner) throw new Error('terminal banner never arrived over IPC');
    if (!verdict.ls) throw new Error('terminal input round trip failed');
    console.log(
      '[smoke] OK: renderer loaded, bridge exposed, terminal IPC round trip verified',
    );
    app.exit(0);
  } catch (error) {
    console.error('[smoke] FAILED:', error);
    app.exit(1);
  }
}

// 第二個實例會與第一個爭寫 profiles.json / known_hosts.json，直接把焦點還給既有視窗。
const gotLock = SMOKE_TEST || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});

// main process 的例外不該讓 app 無聲消失。
process.on('uncaughtException', (error) => {
  console.error('[cozypad] uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[cozypad] unhandled rejection:', reason);
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  console.log(
    `[cozypad] transport mode: ${USE_MOCK ? 'MOCK' : 'SSH'} (COZYPAD_MOCK=${process.env.COZYPAD_MOCK ?? '(unset)'})`,
  );
  if (!DEV_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }

  const profileStore = await createProfileStore();
  const win = createWindow();
  const services = await createServices(profileStore, win);
  registerIpc({ ...services, profileStore, mockData: USE_MOCK }, win);
  win.on('closed', () => {
    services.telemetry.stop();
    services.tmuxWatcher?.stop();
    services.transport.dispose();
  });

  if (SMOKE_TEST) void runSmokeTest(win);
});

app.on('window-all-closed', () => {
  app.quit();
});
