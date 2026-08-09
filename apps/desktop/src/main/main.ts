import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  nativeTheme,
  safeStorage,
  session,
  shell,
} from 'electron';
import { IpcChannels, base64ToBytes } from '@cozypad/contracts';
import { TmuxRuntime } from '@cozypad/tmux-runtime';
import { TmuxRemoteSettings } from '@cozypad/remote-services';
import type { RemoteSettingsPort } from '@cozypad/remote-services';
import { ShellTmuxProvisioner } from '@cozypad/remote-services';
import type { TmuxProvisionerPort } from '@cozypad/remote-services';
import { TmuxSessionWatcher } from './tmuxWatcher';
import type { RemoteFilesPort } from '@cozypad/remote-services';
import { ShellRemoteFiles } from '@cozypad/remote-services';
import { HostKeyGate, KnownHostsStore } from './hostKeys';
import { AgentCommunicationService } from './agentCommunicationService';
import { AcpAgentRuntime } from './acp/acpAgentRuntime';
import { spawnSshAcpAgent } from './acp/sshAcpProcess';
import type { AgentCommunicationPort } from './agentCommunicationService';
import { registerIpc } from './ipc';
import { ProfileStore, ProfileStoreWithLocal } from './profileStore';
import type { ProfileCrypto, ProfileStorePort } from './profileStore';
import { ShellTelemetry } from '@cozypad/remote-services';
import type { TelemetrySource } from '@cozypad/remote-services';
import { Ssh2Transport } from './transport/ssh2Transport';
import {
  LOCAL_PROFILE,
  LocalTransport,
  isLocalProfile,
} from './transport/localTransport';
import { LocalAgentRuntime } from './localAgentRuntime';
import { RoutingAgentRuntime } from './routingAgentRuntime';
import {
  latestAgyConversationId,
  readAgyTranscript,
} from './agyTranscript';
import { RoutingTransport } from './transport/routingTransport';
import type { TransportPort } from './transport/TransportPort';

const DEV_URL = process.env.COZYPAD_DEV_URL;
/** 所有 agent conversation session 都開在這個 socket（SPEC_V3 §6）。 */
// Agent sessions use an isolated tmux server. Sharing the user's default
// socket makes CozyPad inherit that server's lifecycle and configuration and
// can turn a perfectly valid detached launch into "server exited
// unexpectedly". The environment variable remains available for deliberate
// overrides and migration/debugging.
const TMUX_SOCKET = process.env.COZYPAD_TMUX_SOCKET ?? 'cozypad';
const SMOKE_TEST = process.argv.includes('--smoke-test');
const ACP_SMOKE_TEST = process.argv.includes('--acp-smoke-test');

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

/**
 * 啟動時可以降級但必須讓使用者知道的問題。本機設定檔讀不開絕不能讓
 * 整個 app 沒有視窗地消失——那會讓使用者以為程式壞掉。
 */
const startupWarnings: string[] = [];

async function createProfileStore(): Promise<ProfileStorePort> {
  const store = new ProfileStore(
    path.join(app.getPath('userData'), 'profiles.json'),
    electronProfileCrypto,
  );
  try {
    await store.load();
  } catch (error) {
    // load() 失敗時已把記憶體內容清空，繼續使用等於空的連線清單。
    // 原檔一律保留：解不開有可能是暫時的（OS 金鑰服務尚未就緒），
    // 直接刪掉會永久毀掉使用者存的憑證。
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[cozypad] profile store unavailable:', detail);
    startupWarnings.push(
      `${detail}。連線清單這次是空的，原始檔案沒有被刪除；請重新新增一次連線設定。`,
    );
  }

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
  // Offered next to the saved hosts rather than behind a separate mode.
  return new ProfileStoreWithLocal(store, LOCAL_PROFILE);
}

interface MainServices {
  transport: TransportPort;
  files: RemoteFilesPort;
  telemetry: TelemetrySource;
  hostKeys: HostKeyGate | null;
  remoteSettings: RemoteSettingsPort;
  tmuxProvisioner: TmuxProvisionerPort;
  tmuxWatcher: TmuxSessionWatcher | null;
  agentCommunication: AgentCommunicationPort | null;
  acp: AcpAgentRuntime;
}

async function createServices(
  profileStore: ProfileStorePort,
  win: BrowserWindow,
): Promise<MainServices> {
  const knownHosts = new KnownHostsStore(
    path.join(app.getPath('userData'), 'known_hosts.json'),
    electronProfileCrypto,
  );
  try {
    await knownHosts.load();
  } catch (error) {
    // 讀不到已信任的 host key 時退回「全部重新詢問」，不是「全部放行」。
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[cozypad] known-hosts store unavailable:', detail);
    startupWarnings.push(
      `${detail}。第一次連線會重新詢問主機指紋，請確認後再接受。`,
    );
  }
  const hostKeys = new HostKeyGate(knownHosts, (event) => {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.hostKeyPrompt, event);
  });

  // "This computer" is a peer of the saved SSH hosts, so it is chosen the same
  // way — by connecting to a profile — and everything downstream is unchanged.
  const localTransport = new LocalTransport();
  const sshTransport = new Ssh2Transport({
    getProfile: (profileId) => profileStore.get(profileId),
    getCredential: (profileId) => profileStore.getCredential(profileId),
    verifyHostKey: (profile, key) => hostKeys.verify(profile, key),
  });
  const transport = new RoutingTransport(sshTransport, localTransport);
  const exec = (command: string, timeoutMs?: number) => transport.exec(command, timeoutMs);

  // Remote agents live in tmux so they survive a dropped link; local agents are
  // children of this process and need nothing installed to run.
  const localRuntime = new LocalAgentRuntime({
    openTerminal: (request, command) => localTransport.openTerminal(request, command),
    writeTerminal: (id, data) => localTransport.writeTerminal(id, data),
    closeTerminal: (id) => localTransport.forceCloseTerminal(id),
    hasTerminal: (id) => localTransport.hasTerminal(id),
  });
  // tmux settings and the session watcher describe a remote host only, so they
  // keep talking to the real tmux rather than to the router.
  const remoteTmux = new TmuxRuntime(exec, TMUX_SOCKET);
  const tmux = new RoutingAgentRuntime(remoteTmux, localRuntime);
  // Agents that speak ACP run as child processes here. The runtime is built
  // before the service so the service can send through it.
  const acp = new AcpAgentRuntime({
    onTimeline: (sessionId, items) => {
      agentCommunication.replaceTimeline(sessionId, items);
    },
    // Waits for the user, forever, on purpose.
    //
    // The approval card is already in the timeline by the time this is called,
    // and `resolveControl` is what settles it when the user picks an option.
    // Returning here would answer on their behalf: `null` declined every tool
    // claude and codex ever tried to run, which made both unusable, and
    // returning an optionId would be worse — silently allowing.
    //
    // A session that ends with a request still open has it declined by
    // `AcpAgentRuntime.stop`, so nothing is left hanging.
    onPermission: () => new Promise<string | null>(() => undefined),
    onCommands: (sessionId, commands) => {
      agentCommunication.setSlashCommands(sessionId, commands);
    },
    // Adapters report identity here — agy names its conversation id on every
    // prompt response — and binding it is what a later Resume continues from.
    onPromptMeta: (sessionId, meta) => {
      agentCommunication.notePromptMeta(sessionId, meta);
    },
    onExit: (sessionId, detail) => {
      agentCommunication.noteAgentExit(sessionId, detail);
    },
    onError: (sessionId, message) => {
      console.error('[cozypad] acp session', sessionId, message);
    },
  },
  undefined,
  (spec, handlers) => spawnSshAcpAgent(sshTransport, spec, handlers),
  );
  const agentCommunication = new AgentCommunicationService({
    transport,
    tmux,
    profileStore,
    storePath: path.join(app.getPath('userData'), 'agent-sessions.json'),
    acp,
    getHostFingerprint: (profileId) => {
      // This machine has no host key to verify — it is the host. A fixed
      // sentinel lets agent identities bind (and conversations resume) here
      // exactly as they do against a trusted remote fingerprint.
      if (isLocalProfile(profileId)) return 'local';
      const profile = profileStore.get(profileId);
      return profile === undefined
        ? undefined
        : knownHosts.get(profile.host, profile.port);
    },
    attachExisting: (sessionId) => {
      const terminalId = tmux.terminalFor(sessionId);
      // The viewer shares the session's console, so closing the view must not
      // end the agent behind it.
      if (terminalId !== undefined) localTransport.protectTerminal(terminalId);
      return terminalId;
    },
    isLocalHost: (profileId) => isLocalProfile(profileId),
    onHostChanged: (profileId) => tmux.useLocal(isLocalProfile(profileId)),
    getLatestLocalAgyConversationId: (window) => latestAgyConversationId(window),
    readLocalAgyTranscript: (conversationId) =>
      readAgyTranscript(conversationId),
    onStoreRecovered: ({ reason, backupPath }) => {
      startupWarnings.push(
        backupPath === null
          ? `過去的 agent 對話清單讀不出來（${reason}），這次以空清單啟動。`
          : `過去的 agent 對話清單讀不出來（${reason}），已備份到 ${backupPath}，這次以空清單啟動。`,
      );
    },
  });
  // The agent subsystem must not be able to take the rest of the app with it.
  // `MainServices.agentCommunication` is already nullable and `registerIpc`
  // already handles null by rejecting agent calls with a reason — but until now
  // nothing ever produced a null, because a throw here escaped to the caller,
  // where it also skipped `registerIpc()` and left `window.cozypad` undefined.
  // Files, terminal, monitor and settings died with it.
  //
  // `load()` no longer throws on store contents, so this catches what is left:
  // an unreadable path, a permissions problem, a bug in a future migration.
  let loaded: AgentCommunicationPort | null = agentCommunication;
  try {
    await agentCommunication.load();
  } catch (error) {
    loaded = null;
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[cozypad] agent session store failed to load:', error);
    startupWarnings.push(
      `Agent 對話功能這次無法啟動（${detail}）。其他功能不受影響。`,
    );
  }
  return {
    transport,
    files: new TransportRemoteFiles(transport),
    telemetry: new ShellTelemetry(exec),
    hostKeys,
    remoteSettings: new TmuxRemoteSettings(remoteTmux),
    tmuxProvisioner: new ShellTmuxProvisioner(exec, (command, onLine, timeoutMs) =>
      transport.execStream(command, onLine, timeoutMs),
    ),
    tmuxWatcher: new TmuxSessionWatcher(remoteTmux),
    acp,
    agentCommunication: loaded,
  };
}

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    // Not "SSH mode" any more: this computer is the default connection.
    title: 'CozyPad',
    icon: path.join(__dirname, '../assets/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#d4d4d4',
      height: 32,
    },
    backgroundColor: '#050506',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      void shell.openExternal(details.url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      void shell.openExternal(url);
    } else if (!DEV_URL || !url.startsWith(DEV_URL)) {
      event.preventDefault();
    }
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, 'app-dist', 'index.html'));
  } else {
    void win.loadFile(path.join(__dirname, '../../app/dist/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}

function configureApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { id: 'file', role: 'fileMenu' },
      { id: 'edit', role: 'editMenu' },
      { id: 'view', role: 'viewMenu' },
      { id: 'window', role: 'windowMenu' },
    ]),
  );
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
        await bridge.connect({ profileId: 'local-machine' });
        const { terminalId } = await bridge.openTerminal({
          profileId: 'local-machine', cols: 80, rows: 24,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        bridge.writeTerminal({ terminalId, dataBase64: btoa('echo cozypad-smoke-ok\\r') });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const text = chunks.map((chunk) => atob(chunk)).join('');
        return JSON.stringify({
          ok: text.includes('cozypad-smoke-ok'),
        });
      })()`,
    );

    const verdict = JSON.parse(String(roundTrip)) as { ok: boolean };
    if (!verdict.ok) throw new Error('terminal input round trip failed');
    console.log(
      '[smoke] OK: renderer loaded, bridge exposed, terminal IPC round trip verified',
    );
    app.exit(0);
  } catch (error) {
    console.error('[smoke] FAILED:', error);
    app.exit(1);
  }
}


/**
 * Does what a user does, once, and says whether it worked.
 *
 * Every layer below this has tests, and none of them prove the app runs: the
 * client has fake agents, the adapter has a fake transport, the reducer has
 * recordings. This is the first thing that spawns a real agent through the real
 * IPC and reads the real timeline.
 */
async function runAcpSmokeTest(win: BrowserWindow): Promise<void> {
  const prompt = process.env.COZYPAD_ACP_SMOKE_PROMPT ?? 'Reply with exactly: OK';
  const agentKind = process.env.COZYPAD_ACP_SMOKE_AGENT ?? 'agy';
  const cwd = process.env.COZYPAD_ACP_SMOKE_CWD ?? process.cwd();
  const turns = Number(process.env.COZYPAD_ACP_SMOKE_TURNS ?? '1');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('renderer load timeout')), 15_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_e, code, description) => {
        clearTimeout(timer);
        reject(new Error('did-fail-load ' + String(code) + ' ' + description));
      });
    });

    const result: unknown = await win.webContents.executeJavaScript(
      '(async () => {' +
      '  const bridge = window.cozypad;' +
      '  if (!bridge || bridge.kind !== "electron") throw new Error("preload bridge unavailable");' +
      '  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
      '  const steps = [];' +
      '  const profiles = await bridge.listProfiles();' +
      '  const local = profiles.find((p) => p.host === "localhost" || p.id === "local");' +
      '  if (!local) throw new Error("no local profile: " + JSON.stringify(profiles.map((p) => p.id)));' +
      '  steps.push("profile:" + local.id);' +
      '  await bridge.connect({ profileId: local.id });' +
      '  steps.push("connected");' +
      '  let timeline = [];' +
      '  const stop = bridge.onAgentTimelineChanged((e) => { timeline = e.items; });' +
      '  const bundle = await bridge.createAgentSession({' +
      '    profileId: local.id, agentKind: ' + JSON.stringify(agentKind) + ',' +
      '    cwd: ' + JSON.stringify(cwd) + ', interactionMode: "chat",' +
      '  });' +
      '  steps.push("session:" + bundle.session.id + " status:" + bundle.session.status);' +
      '  let latest = bundle.session;' +
      '  const stopS = bridge.onAgentSessionChanged((e) => { if (e.session.id === bundle.session.id) latest = e.session; });' +
      '  await bridge.sendAgentMessage({ sessionId: bundle.session.id, text: ' + JSON.stringify(prompt) + ', attachmentIds: [] });' +
      '  steps.push("sent");' +
      '  const wait1 = Date.now() + 180000;' +
      '  while (Date.now() < wait1 && !timeline.some((i) => i.kind === "message" && i.role === "assistant" && i.text.trim() !== "")) await sleep(250);' +
      '  if (' + JSON.stringify(turns) + ' > 1) {' +
      '    await bridge.sendAgentMessage({ sessionId: bundle.session.id, text: "Say OK again", attachmentIds: [] });' +
      '    steps.push("sent2");' +
      '  }' +
      '  const deadline = Date.now() + 180000;' +
      '  while (Date.now() < deadline) {' +
      '    const reply = timeline.find((i) => i.kind === "message" && i.role === "assistant" && i.text.trim() !== "");' +
      '    if (reply) { stop && stop(); stopS && stopS(); const fresh = (await bridge.listAgentSessions({ profileId: local.id })).find((b) => b.session.id === bundle.session.id); return { ok: true, steps, kinds: timeline.map((i) => i.kind), reply: reply.text.slice(0, 200), slash: ((fresh && fresh.session.slashCommands) || []).length, slashSample: ((fresh && fresh.session.slashCommands) || []).slice(0, 4) }; }' +
      '    await sleep(250);' +
      '  }' +
      '  stop && stop();' +
      '  return { ok: false, steps, kinds: timeline.map((i) => i.kind), reply: null };' +
      '})()',
    );
    const report = result as { ok: boolean; steps: string[]; kinds: string[]; reply: string | null };
    console.log('[acp-smoke] steps  :', report.steps.join(' -> '));
    console.log('[acp-smoke] kinds  :', report.kinds.join(', '));
    console.log('[acp-smoke] reply  :', JSON.stringify(report.reply));
    console.log('[acp-smoke] slash  :', String((report as { slash?: number }).slash ?? 0), JSON.stringify((report as { slashSample?: string[] }).slashSample ?? []));
    console.log('[acp-smoke] RESULT :', report.ok ? 'PASS' : 'FAIL');
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error('[acp-smoke] RESULT : FAIL', error);
    app.exit(1);
  }
}



// 第二個實例會與第一個爭寫 profiles.json / known_hosts.json，直接把焦點還給既有視窗。
const gotLock =
  SMOKE_TEST || ACP_SMOKE_TEST || app.requestSingleInstanceLock();
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
  configureApplicationMenu();
  console.log(
    `[cozypad] transport mode: SSH`,
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

  // 視窗必須先開。之後任何一步失敗都還有畫面可以顯示錯誤，
  // 不會變成「雙擊 CozyPad.bat 什麼都沒發生」。
  const win = createWindow();
  try {
    const profileStore = await createProfileStore();
    const services = await createServices(profileStore, win);
    registerIpc(
      {
        ...services,
        profileStore,
        startupWarnings,
        isLocalProfile,
      },
      win,
    );
    win.on('closed', () => {
      services.acp.stopAll();
      services.telemetry.stop();
      services.tmuxWatcher?.stop();
      services.transport.dispose();
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[cozypad] startup failed:', error);
    startupWarnings.push(`CozyPad 啟動時發生錯誤：${detail}`);
    dialog.showErrorBox('CozyPad 啟動失敗', detail);
  }

  if (SMOKE_TEST) void runSmokeTest(win);
  if (ACP_SMOKE_TEST) void runAcpSmokeTest(win);
});

app.on('window-all-closed', () => {
  app.quit();
});

class TransportRemoteFiles implements RemoteFilesPort {
  constructor(private readonly transport: TransportPort) {}

  list(path: string) {
    return this.transport.fsList(path);
  }
  readText(path: string, maxBytes: number, offset: number) {
    return this.transport.fsReadText(path, maxBytes, offset);
  }
  async readBytes(path: string, maxBytes?: number, signal?: AbortSignal) {
    return this.transport.fsReadBytes(path);
  }
  write(path: string, contentBase64: string, maxBytes?: number, signal?: AbortSignal) {
    return this.transport.fsWrite(path, base64ToBytes(contentBase64));
  }
  create(directory: string, name: string, kind: 'file' | 'directory') {
    return this.transport.fsCreate(directory, name, kind);
  }
  rename(path: string, newName: string) {
    return this.transport.fsRename(path, newName);
  }
  duplicate(path: string) {
    return this.transport.fsDuplicate(path);
  }
  copyTo(sourcePath: string, destinationDirectory: string) {
    return this.transport.fsCopyTo(sourcePath, destinationDirectory);
  }
  moveTo(sourcePath: string, destinationDirectory: string) {
    return this.transport.fsMoveTo(sourcePath, destinationDirectory);
  }
  remove(path: string) {
    return this.transport.fsRemove(path);
  }
}
