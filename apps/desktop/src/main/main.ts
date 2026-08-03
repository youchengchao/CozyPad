import path from 'node:path';
import { promises as fs } from 'node:fs';
import { BrowserWindow, app, dialog, safeStorage, session } from 'electron';
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
import { AgentCommunicationService } from './agentCommunicationService';
import type { AgentCommunicationPort } from './agentCommunicationService';
import { registerIpc } from './ipc';
import { MemoryProfileStore, ProfileStore, ProfileStoreWithLocal } from './profileStore';
import type { ProfileCrypto, ProfileStorePort } from './profileStore';
import { ShellTelemetry } from '@cozypad/remote-services';
import type { TelemetrySource } from '@cozypad/remote-services';
import { MOCK_PROFILE, MockTransport } from './transport/mockTransport';
import { Ssh2Transport } from './transport/ssh2Transport';
import {
  LOCAL_PROFILE,
  LocalTransport,
  isLocalProfile,
} from './transport/localTransport';
import { LocalAgentRuntime } from './localAgentRuntime';
import { RoutingAgentRuntime } from './routingAgentRuntime';
import { readLatestAgyTranscript } from './agyTranscript';
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
const AGY_SMOKE_TEST = process.argv.includes('--agy-smoke-test');
const AGY_BACKEND_SMOKE_TEST = process.argv.includes('--agy-backend-smoke-test');
const AGY_SMOKE_CWD = process.env.COZYPAD_AGY_SMOKE_CWD ?? '~';
const AGY_HISTORY_ONLY = process.env.COZYPAD_AGY_SMOKE_HISTORY_ONLY === '1';
const AGY_INTERACTION_CASE =
  process.env.COZYPAD_AGY_SMOKE_INTERACTION_CASE ?? '';
const USE_MOCK = process.env.COZYPAD_MOCK === '1' || SMOKE_TEST;

// Windows' GPU Viz process can reject capturePage immediately after repeated
// full-screen smoke launches. Software compositing makes the visual regression
// harness deterministic and does not affect ordinary CozyPad launches.
if (AGY_SMOKE_TEST) app.disableHardwareAcceleration();

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
  if (USE_MOCK) return new MemoryProfileStore([MOCK_PROFILE]);
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
      agentCommunication: null,
    };
  }

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
  const transport = new RoutingTransport(
    new Ssh2Transport({
      getProfile: (profileId) => profileStore.get(profileId),
      getCredential: (profileId) => profileStore.getCredential(profileId),
      verifyHostKey: (profile, key) => hostKeys.verify(profile, key),
    }),
    localTransport,
  );
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
  const agentCommunication = new AgentCommunicationService({
    transport,
    tmux,
    profileStore,
    storePath: path.join(app.getPath('userData'), 'agent-sessions.json'),
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
    readLocalAgyTranscript: () => readLatestAgyTranscript(),
  });
  await agentCommunication.load();
  return {
    transport,
    files: new ShellRemoteFiles(exec),
    telemetry: new ShellTelemetry(exec),
    hostKeys,
    remoteSettings: new TmuxRemoteSettings(remoteTmux),
    tmuxProvisioner: new ShellTmuxProvisioner(exec, (command, onLine, timeoutMs) =>
      transport.execStream(command, onLine, timeoutMs),
    ),
    tmuxWatcher: new TmuxSessionWatcher(remoteTmux),
    agentCommunication,
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Not "SSH mode" any more: this computer is the default connection.
    title: USE_MOCK ? 'CozyPad — MOCK 模式（假主機）' : 'CozyPad',
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

async function runAgyBackendSmokeTest(win: BrowserWindow): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('renderer load timeout')), 15_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${description}`));
      });
    });

    const result: unknown = await win.webContents.executeJavaScript(
      `(async () => {
        const bridge = window.cozypad;
        if (!bridge || bridge.kind !== 'electron') {
          throw new Error('Electron preload bridge is unavailable');
        }

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, timeoutMs, label) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (predicate()) return;
            await sleep(100);
          }
          const surface = document.querySelector('[data-testid="agy-surface"]');
          const debug = surface?.textContent || '';
          throw new Error('Timed out waiting for ' + label + '\\nAGY screen:\\n' + debug);
        };
        const encode = (value) => {
          const bytes = new TextEncoder().encode(value);
          let binary = '';
          for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]);
          }
          return btoa(binary);
        };
        const outputEvents = [];
        let terminalId = null;
        let profileId = null;
        let sessionId = null;
        const unsubscribeOutput = bridge.onTerminalOutput((event) => {
          outputEvents.push(event);
        });
        const terminalText = () => {
          const binary = outputEvents
            .filter((event) => terminalId === null || event.terminalId === terminalId)
            .map((event) => atob(event.dataBase64))
            .join('');
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        };
        const occurrences = (text, needle) => text.split(needle).length - 1;
        const write = (value) => {
          if (terminalId === null) throw new Error('AGY terminal is not open');
          bridge.writeTerminal({ terminalId, dataBase64: encode(value) });
        };
        const sendPrompt = (value) => {
          write('\\u001b[200~' + value + '\\u001b[201~\\r');
        };

        try {
          const profiles = await bridge.listProfiles();
          // Prefer this machine: no credential and no network means the
          // whole flow is reachable in a test.
          const profile =
            profiles.find((candidate) => candidate.isLocal === true) ||
            profiles.find((candidate) =>
              candidate.authMethod === 'privateKey'
                ? candidate.hasPrivateKey === true
                : candidate.hasPassword === true,
            ) ||
            profiles[0];
          if (!profile) throw new Error('No connection is available');
          profileId = profile.id;
          await bridge.connect({ profileId });

          const installation = await bridge.detectAgent({
            profileId,
            agentKind: 'agy',
          });
          if (!installation.installed) {
            throw new Error('AGY is not installed for profile ' + profile.name);
          }
          if (installation.launchModes.length === 0) {
            throw new Error('AGY did not advertise a launch mode');
          }
          const home = await bridge.fsList({ path: ${JSON.stringify(AGY_SMOKE_CWD)} });
          const launchMode =
            ${JSON.stringify(AGY_INTERACTION_CASE)} === 'approval'
              ? installation.launchModes.find((mode) => mode.id === 'sandbox') ||
                installation.launchModes[0]
              : installation.launchModes[0];
          const bundle = await bridge.createAgentSession({
            profileId,
            agentKind: 'agy',
            cwd: home.path,
            interactionMode: 'terminal',
            launchMode: launchMode.id,
            title: 'CozyPad AGY smoke ' + new Date().toISOString(),
          });
          sessionId = bundle.session.id;
          const opened = await bridge.openAgentTerminal({
            sessionId,
            cols: 120,
            rows: 40,
          });
          terminalId = opened.terminalId;
          await waitFor(() => terminalText().length > 0, 20_000, 'AGY start screen');

          // Select the default start action if AGY opened on its welcome screen.
          write('\\r');
          await sleep(1_200);

          // Reproduce the original bug exactly: each character may trigger a
          // full-screen slash-menu redraw, but no Stop/Ctrl+C is inserted.
          const slashStart = terminalText().length;
          write('/');
          await waitFor(() => terminalText().length > slashStart, 5_000, 'slash redraw');
          const slashM = terminalText().length;
          write('m');
          await waitFor(() => terminalText().length > slashM, 5_000, 'second slash character');
          const slashO = terminalText().length;
          write('o');
          await waitFor(() => terminalText().length > slashO, 5_000, 'third slash character');
          write('\\u001b\\u001b');
          await sleep(800);

          const replyToken = 'COZYPAD_AGY_REPLY_' + Date.now();
          const replyBefore = occurrences(terminalText(), replyToken);
          sendPrompt('Reply with exactly ' + replyToken);
          await waitFor(
            () => occurrences(terminalText(), replyToken) >= replyBefore + 2,
            120_000,
            'AGY response',
          );

          const cancelPrompt =
            'Work on this slowly and do not finish immediately; inspect the current directory first.';
          sendPrompt(cancelPrompt);
          await sleep(900);
          const beforeInterrupt = terminalText().length;
          await bridge.interruptAgentSession({ sessionId });
          await waitFor(
            () => terminalText().length > beforeInterrupt,
            10_000,
            'Ctrl+C acknowledgement',
          );
          await sleep(900);

          // A successful answer after interruption proves the Stop action
          // returned terminal control instead of merely resolving its IPC call.
          const stopToken = 'COZYPAD_AGY_AFTER_STOP_' + Date.now();
          const stopBefore = occurrences(terminalText(), stopToken);
          sendPrompt('Reply with exactly ' + stopToken);
          await waitFor(
            () => occurrences(terminalText(), stopToken) >= stopBefore + 2,
            120_000,
            'post-Stop AGY response',
          );

          return {
            profile: profile.name,
            version: installation.version || 'unknown',
            slashCharacters: 3,
            replyVerified: true,
            stopVerified: true,
          };
        } finally {
          unsubscribeOutput();
          if (terminalId !== null) {
            try { await bridge.closeTerminal({ terminalId }); } catch {}
          }
          if (sessionId !== null) {
            try { await bridge.deleteAgentSession({ sessionId }); } catch {}
          }
          if (profileId !== null) {
            try { await bridge.disconnect({ profileId }); } catch {}
          }
        }
      })()`,
      true,
    );

    console.log('[agy-smoke] OK:', JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error('[agy-smoke] FAILED:', error);
    app.exit(1);
  }
}

async function runAgyUiSmokeTest(win: BrowserWindow): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('renderer load timeout')), 15_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${description}`));
      });
    });

    win.maximize();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const visualDir = path.join(app.getPath('temp'), 'cozypad-agy-ui-smoke');
    await fs.rm(visualDir, { recursive: true, force: true });
    await fs.mkdir(visualDir, { recursive: true });

    let result: unknown;
    let executionError: unknown;
    let settled = false;
    const execution = win.webContents.executeJavaScript(
      `(async () => {
        const bridge = window.cozypad;
        if (!bridge || bridge.kind !== 'electron') {
          throw new Error('Electron preload bridge is unavailable');
        }

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const terminalOutputEvents = [];
        const observations = [];
        const unsubscribeTerminalOutput = bridge.onTerminalOutput((event) => {
          terminalOutputEvents.push(event);
        });
        const terminalOutputText = () => {
          const binary = terminalOutputEvents
            .map((event) => atob(event.dataBase64))
            .join('');
          const bytes = Uint8Array.from(
            binary,
            (character) => character.charCodeAt(0),
          );
          return new TextDecoder().decode(bytes);
        };
        const markStage = async (label) => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await sleep(450);
          delete document.documentElement.dataset.agySmokeCaptured;
          document.documentElement.dataset.agySmokeStage = label;
          const deadline = Date.now() + 8_000;
          while (
            document.documentElement.dataset.agySmokeCaptured !== label &&
            Date.now() < deadline
          ) {
            await sleep(100);
          }
          if (document.documentElement.dataset.agySmokeCaptured !== label) {
            throw new Error('Timed out waiting for screenshot ' + label);
          }
          await sleep(180);
          observations.push({
            label,
            terminalOutputTail: terminalOutputText().slice(-24_000),
            cozyPadText:
              document.querySelector('[data-testid="agy-surface"]')?.textContent || '',
            terminalEventCount: terminalOutputEvents.length,
          });
        };
        const waitFor = async (predicate, timeoutMs, label) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (predicate()) return;
            await sleep(100);
          }
          const surface = document.querySelector('[data-testid="agy-surface"]');
          const debug = surface?.textContent || '';
          throw new Error('Timed out waiting for ' + label + '\\nAGY screen:\\n' + debug);
        };
        const waitForAsync = async (predicate, timeoutMs, label) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (await predicate()) return;
            await sleep(150);
          }
          const surface = document.querySelector('[data-testid="agy-surface"]');
          const debug = surface?.textContent || '';
          throw new Error('Timed out waiting for ' + label + '\\nAGY screen:\\n' + debug);
        };
        let profileId = null;
        let sessionId = null;
        const composer = () => document.querySelector('[data-testid="agy-composer-input"]');
        const sendButton = () => document.querySelector('[data-testid="agy-send"]');
        const setComposer = (value) => {
          const input = composer();
          if (!(input instanceof HTMLTextAreaElement)) {
            throw new Error('AGY composer is unavailable');
          }
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          ).set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const click = (element, label) => {
          if (!(element instanceof HTMLElement)) {
            throw new Error(label + ' is unavailable');
          }
          element.click();
        };
        const assistantContains = (value) =>
          Array.from(document.querySelectorAll('.agy-chat-turn .msg-assistant'))
            .some((element) => element.textContent.includes(value));
        const assistantTextContaining = (value) =>
          Array.from(document.querySelectorAll('.agy-chat-turn .msg-assistant'))
            .find((element) => element.textContent.includes(value))?.textContent || null;
        const userContains = (value) =>
          Array.from(document.querySelectorAll('.agy-chat-turn .msg-user'))
            .some((element) => element.textContent.includes(value));
        const submitFromUi = async (value) => {
          setComposer(value);
          await waitFor(
            () => composer()?.value === value && composer()?.disabled === false,
            5_000,
            'editable composer value',
          );
          click(sendButton(), 'AGY Send button');
        };
        const inspectOverlay = async (
          command,
          kind,
          stage,
          preservedPrompt = null,
          preservedReplyToken = null,
          preservedReplyText = null,
        ) => {
          const selector = '[data-testid="agy-overlay-' + kind + '"]';
          await submitFromUi(command);
          await waitFor(
            () => document.querySelector(selector) !== null,
            20_000,
            command + ' native control surface',
          );
          if (
            preservedPrompt !== null &&
            preservedReplyToken !== null &&
            preservedReplyText !== null
          ) {
            await waitFor(
              () =>
                userContains(preservedPrompt) &&
                assistantTextContaining(preservedReplyToken) === preservedReplyText,
              5_000,
              'conversation while ' + command + ' is open',
            );
          }
          await markStage(stage);
          click(
            document.querySelector(selector + ' .agy-overlay-actions button.ghost'),
            command + ' close button',
          );
          await waitFor(
            () => document.querySelector(selector) === null && composer()?.disabled === false,
            20_000,
            'prompt after closing ' + command,
          );
          if (
            preservedPrompt !== null &&
            preservedReplyToken !== null &&
            preservedReplyText !== null
          ) {
            await waitFor(
              () =>
                userContains(preservedPrompt) &&
                assistantTextContaining(preservedReplyToken) === preservedReplyText,
              5_000,
              'conversation after closing ' + command,
            );
          }
        };

        try {
          const profiles = await bridge.listProfiles();
          // Prefer this machine: no credential and no network means the
          // whole flow is reachable in a test.
          const profile =
            profiles.find((candidate) => candidate.isLocal === true) ||
            profiles.find((candidate) =>
              candidate.authMethod === 'privateKey'
                ? candidate.hasPrivateKey === true
                : candidate.hasPassword === true,
            ) ||
            profiles[0];
          if (!profile) throw new Error('No connection is available');
          profileId = profile.id;
          await bridge.connect({ profileId });
          await waitFor(
            () => document.querySelector('.status-connected') !== null,
            10_000,
            'connected application state',
          );

          const installation = await bridge.detectAgent({
            profileId,
            agentKind: 'agy',
          });
          if (!installation.installed) {
            throw new Error('AGY is not installed for profile ' + profile.name);
          }
          if (installation.launchModes.length === 0) {
            throw new Error('AGY did not advertise a launch mode');
          }
          const home = await bridge.fsList({ path: ${JSON.stringify(AGY_SMOKE_CWD)} });
          const bundle = await bridge.createAgentSession({
            profileId,
            agentKind: 'agy',
            cwd: home.path,
            interactionMode: 'terminal',
            launchMode: installation.launchModes[0].id,
            title: 'CozyPad AGY UI smoke ' + new Date().toISOString(),
          });
          sessionId = bundle.session.id;
          // Create first, then reveal AGY. Otherwise opening the tab mounts the
          // most recent persisted (often exited) session for a moment and its
          // failed terminal attach races the fresh smoke-test session.
          const agyTab = Array.from(document.querySelectorAll('.agent-tab')).find(
            (button) => button.textContent.trim().toLowerCase() === 'agy',
          );
          click(agyTab, 'AGY tab');
          await markStage('01-agents-tab');
          await waitFor(
            () => document.querySelector('[data-session-id="' + CSS.escape(sessionId) + '"]') !== null,
            10_000,
            'new AGY session row',
          );
          click(
            document.querySelector('[data-session-id="' + CSS.escape(sessionId) + '"]'),
            'new AGY session row',
          );
          await waitFor(
            () =>
              document.querySelector('.session-item-active')?.getAttribute('data-session-id') ===
              sessionId,
            5_000,
            'new AGY session selection',
          );
          await waitFor(
            () =>
              JSON.stringify(
                Array.from(document.querySelectorAll('.context-menu .menu-label')).map(
                  (label) => label.textContent.trim(),
                ),
              ) === JSON.stringify(['Rename', 'Delete']),
            5_000,
            'desktop session action menu',
          );
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          await waitFor(
            () => document.querySelector('.context-menu') === null,
            5_000,
            'desktop session action menu dismissal',
          );
          const sessionRow = document.querySelector(
            '[data-session-id="' + CSS.escape(sessionId) + '"]',
          );
          sessionRow.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              clientX: 150,
              clientY: 220,
              pointerId: 7,
              pointerType: 'touch',
            }),
          );
          await waitFor(
            () => document.querySelector('.context-menu') !== null,
            2_000,
            'touch long-press session action menu',
          );
          sessionRow.dispatchEvent(
            new PointerEvent('pointerup', {
              bubbles: true,
              clientX: 150,
              clientY: 220,
              pointerId: 7,
              pointerType: 'touch',
            }),
          );
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          await waitFor(
            () => document.querySelector('.context-menu') === null,
            5_000,
            'touch session action menu dismissal',
          );
          await waitFor(
            () => document.querySelector('[data-testid="agy-surface"]') !== null,
            30_000,
            'AGY chat surface',
          );
          await markStage('02-agy-open');

          const welcomeSeen =
            document.querySelector('[data-testid="agy-welcome"]') !== null;
          await waitFor(
            () => {
              const panel = document.querySelector('[data-testid="agy-panel"]');
              return (
                (panel !== null && /trust/i.test(panel.textContent || '')) ||
                document.querySelector('[data-testid="agy-start-option"]') !== null ||
                composer()?.disabled === false
              );
            },
            30_000,
            'AGY workspace trust, start choices, or prompt',
          );
          const trustPanel = document.querySelector('[data-testid="agy-panel"]');
          const workspaceTrustSeen =
            trustPanel !== null && /trust/i.test(trustPanel.textContent || '');
          if (workspaceTrustSeen) {
            await markStage('02-workspace-trust');
            if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'trust-deny') {
              const trustOptions = Array.from(
                trustPanel.querySelectorAll('[data-testid="agy-panel-option"]'),
              ).map((option) => option.textContent.trim());
              const denyTrust = Array.from(
                trustPanel.querySelectorAll('[data-testid="agy-panel-option"]'),
              ).find((option) => /no|exit|do not trust|don't trust/i.test(option.textContent || ''));
              click(denyTrust, 'deny trust for this AGY workspace');
              await waitFor(
                () => document.querySelector('[aria-label="AGY approval"]') === null,
                20_000,
                'AGY workspace trust denial',
              );
              await markStage('03-workspace-trust-denied');
              return {
                profile: profile.name,
                version: installation.version || 'unknown',
                uiDriven: true,
                interactionCase: 'trust-deny',
                trustOptions,
                observations,
              };
            }
            const trustOption = Array.from(
              trustPanel.querySelectorAll('[data-testid="agy-panel-option"]'),
            ).find((option) => /yes.*trust/i.test(option.textContent || ''));
            click(trustOption, 'trust this AGY workspace option');
            await waitFor(
              () => {
                const panel = document.querySelector('[data-testid="agy-panel"]');
                return panel === null || !/trust/i.test(panel.textContent || '');
              },
              20_000,
              'AGY workspace trust dismissal',
            );
          }
          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'trust-deny') {
            throw new Error('AGY did not show the expected workspace trust interface');
          }
          await waitFor(
            () =>
              document.querySelector('[data-testid="agy-start-option"]') !== null ||
              composer()?.disabled === false,
            30_000,
            'AGY start choices or prompt',
          );
          const startOptions = document.querySelectorAll(
            '[data-testid="agy-start-option"]',
          ).length;
          const startOption = document.querySelector('[data-testid="agy-start-option"]');
          if (startOption !== null) click(startOption, 'first AGY start option');
          await waitFor(
            () => composer()?.disabled === false,
            20_000,
            'AGY prompt after start choice',
          );
          if (${JSON.stringify(AGY_INTERACTION_CASE)} === '') {
            await waitFor(
              () => {
                const statusline =
                  document.querySelector('[data-testid="agy-statusline"]')?.textContent || '';
                return /Context\\s*\\d+%/i.test(statusline) && /Weekly\\s*\\d+%/i.test(statusline);
              },
              20_000,
              'automatic AGY context and usage status',
            );
          }
          await markStage('03-ready');

          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'question') {
            const completionToken = 'COZYPAD_AGY_QUESTION_' + Date.now();
            const questionPrompt = [
              'Use your native interactive question interface before doing anything else.',
              'Ask exactly: Choose the greeting style?',
              'Offer these choices in this order: Formal, Friendly.',
              'Leave the native Write-in option enabled.',
              'Wait for my selection. After I select an option, reply with exactly ' +
                completionToken,
            ].join(' ');
            await submitFromUi(questionPrompt);
            await waitFor(
              () =>
                document
                  .querySelector('[data-testid="agy-panel"]')
                  ?.getAttribute('aria-label') === 'AGY question' &&
                document.querySelectorAll('[data-testid="agy-panel-option"]').length >= 3,
              60_000,
              'AGY native question interface',
            );
            const questionOptions = Array.from(
              document.querySelectorAll('[data-testid="agy-panel-option"]'),
            ).map((option) => option.textContent.trim());
            if (
              JSON.stringify(questionOptions) !==
              JSON.stringify(['Formal', 'Friendly', 'Write-in...'])
            ) {
              throw new Error(
                'Unexpected question options: ' + JSON.stringify(questionOptions),
              );
            }
            if (
              document.querySelector('.agy-chat-turn .msg-assistant') !== null
            ) {
              throw new Error('Question terminal furniture leaked into an assistant message');
            }
            await markStage('04-question');
            click(
              document.querySelectorAll('[data-testid="agy-panel-option"]')[1],
              'Friendly question option',
            );
            await waitFor(
              () => document.querySelector('[aria-label="AGY question"]') === null,
              30_000,
              'question interface dismissal',
            );
            await waitFor(
              () => assistantContains(completionToken),
              120_000,
              'post-question AGY reply',
            );
            await markStage('05-question-answered');
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              interactionCase: 'question',
              questionOptions,
              completionToken,
              workspaceTrustSeen,
              observations,
            };
          }

          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'file-edit') {
            const completionToken = 'COZYPAD_AGY_FILE_EDIT_' + Date.now();
            const filePath = home.path.replace(/[\\\\/]+$/u, '') + '/src/demo.ts';
            const beforeContent = (await bridge.fsRead({
              path: filePath,
              maxBytes: 64_000,
              offset: 0,
            })).content;
            if (
              beforeContent.includes('export function farewell') ||
              beforeContent.includes('Greeting is disabled')
            ) {
              throw new Error('File-edit fixture was not reset before the test');
            }
            const editPrompt = [
              'Modify src/demo.ts now using your native file-editing tool.',
              "Change 'Greeting disabled' to 'Greeting is disabled'.",
              "Add exactly: export function farewell(name: string): string { return 'Goodbye, ' + name + '!'; }",
              'Do not modify any other file.',
              'After saving, run exactly: git -c safe.directory=* diff -- src/demo.ts',
              'Also run exactly: git -c safe.directory=* log -1 --oneline',
              'Your final reply must start with ' + completionToken + '.',
              'Then include the exact unified diff in a fenced code block labelled diff.',
              'Then include the exact commit line in a fenced code block labelled gitlog.',
            ].join(' ');
            await submitFromUi(editPrompt);

            await waitForAsync(
              async () => {
                const approval = document.querySelector('[aria-label="AGY approval"]');
                if (approval !== null) return true;
                const content = (await bridge.fsRead({
                  path: filePath,
                  maxBytes: 64_000,
                  offset: 0,
                })).content;
                return (
                  content.includes('export function farewell') &&
                  content.includes('Greeting is disabled')
                );
              },
              120_000,
              'AGY approval or saved file edit',
            );

            const approval = document.querySelector('[aria-label="AGY approval"]');
            let approvalSeen = false;
            if (approval !== null) {
              approvalSeen = true;
              await markStage('04-file-edit-approval');
              const allow =
                Array.from(
                  approval.querySelectorAll('[data-testid="agy-panel-option"]'),
                ).find((option) => /yes|allow|approve|proceed/i.test(option.textContent || '')) ||
                approval.querySelector('.btn-allow');
              click(allow, 'allow AGY file edit');
            }

            await waitForAsync(
              async () => {
                const content = (await bridge.fsRead({
                  path: filePath,
                  maxBytes: 64_000,
                  offset: 0,
                })).content;
                return (
                  content.includes('export function farewell') &&
                  content.includes('Greeting is disabled')
                );
              },
              120_000,
              'saved src/demo.ts modification',
            );
            await markStage('04-file-edited');
            await waitFor(
              () =>
                assistantContains(completionToken) &&
                document.querySelector('.agy-diff-card .diff-add') !== null &&
                document.querySelector('.agy-diff-card .diff-del') !== null &&
                document.querySelector('.agy-diff-card .diff-hunk') !== null &&
                document.querySelector('.agy-git-history') !== null,
              120_000,
              'post-edit AGY diff and git history reply',
            );
            await markStage('05-file-edit-complete');
            const afterContent = (await bridge.fsRead({
              path: filePath,
              maxBytes: 64_000,
              offset: 0,
            })).content;
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              interactionCase: 'file-edit',
              approvalSeen,
              completionToken,
              fileChanged: beforeContent !== afterContent,
              diffStat:
                document.querySelector('.agy-diff-card .diff-stat')?.textContent || null,
              gitHistory:
                document.querySelector('.agy-git-history pre')?.textContent || null,
              observations,
            };
          }

          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'diff-report') {
            const completionToken = 'COZYPAD_AGY_DIFF_REPORT_' + Date.now();
            const filePath = home.path.replace(/[\\\\/]+$/u, '') + '/src/demo.ts';
            const content = (await bridge.fsRead({
              path: filePath,
              maxBytes: 64_000,
              offset: 0,
            })).content;
            if (
              !content.includes('export function farewell') ||
              !content.includes('Greeting is disabled')
            ) {
              throw new Error('Diff-report fixture has no pending file modification');
            }
            const reportPrompt = [
              'Inspect the existing uncommitted change without modifying any file.',
              'Run exactly: git -c safe.directory=* diff -- src/demo.ts',
              'Run exactly: git -c safe.directory=* log -1 --oneline',
              'Your final reply must start with ' + completionToken + '.',
              'Then reproduce the exact unified diff and the exact commit line.',
            ].join(' ');
            await submitFromUi(reportPrompt);
            await waitFor(
              () =>
                assistantContains(completionToken) &&
                document.querySelector('.agy-diff-card .diff-add') !== null &&
                document.querySelector('.agy-diff-card .diff-del') !== null &&
                document.querySelector('.agy-diff-card .diff-hunk') !== null &&
                document.querySelector('.agy-git-history') !== null,
              120_000,
              'AGY diff and git history cards',
            );
            await markStage('04-diff-history');
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              interactionCase: 'diff-report',
              completionToken,
              diffStat:
                document.querySelector('.agy-diff-card .diff-stat')?.textContent || null,
              gitHistory:
                document.querySelector('.agy-git-history pre')?.textContent || null,
              observations,
            };
          }

          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'approval') {
            const completionToken = 'COZYPAD_AGY_DENIED_' + Date.now();
            const approvalPrompt = [
              'Use your native shell tool to run exactly: node -p 6*7',
              'Request permission through the native approval interface before running it.',
              'Wait for my decision.',
              'If I deny it, do not retry and reply with exactly ' + completionToken,
            ].join(' ');
            await submitFromUi(approvalPrompt);
            await waitFor(
              () => document.querySelector('[aria-label="AGY approval"]') !== null,
              120_000,
              'AGY command approval interface',
            );
            const approval = document.querySelector('[aria-label="AGY approval"]');
            const approvalOptions = Array.from(
              approval.querySelectorAll('[data-testid="agy-panel-option"]'),
            ).map((option) => option.textContent.trim());
            const approvalCommand = approval.querySelector('code')?.textContent || null;
            await markStage('04-command-approval');
            const deny =
              Array.from(
                approval.querySelectorAll('[data-testid="agy-panel-option"]'),
              ).find((option) => /no|deny|reject/i.test(option.textContent || '')) ||
              approval.querySelector('.btn-deny');
            click(deny, 'deny AGY command');
            await waitFor(
              () => document.querySelector('[aria-label="AGY approval"]') === null,
              30_000,
              'AGY command approval dismissal',
            );
            await waitFor(
              () => assistantContains(completionToken),
              120_000,
              'post-denial AGY reply',
            );
            await markStage('05-command-denied');
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              interactionCase: 'approval',
              launchMode: launchMode.id,
              approvalOptions,
              approvalCommand,
              completionToken,
              observations,
            };
          }

          if (${JSON.stringify(AGY_INTERACTION_CASE)} === 'viewer') {
            const completionToken = 'COZYPAD_AGY_VIEW_' + Date.now();
            const viewPrompt = [
              'Inspect README.md using your native Read tool.',
              'Do not modify any files.',
              'After reading it, reply with exactly ' + completionToken,
            ].join(' ');
            await submitFromUi(viewPrompt);
            await waitFor(
              () =>
                assistantContains(completionToken) &&
                Array.from(document.querySelectorAll('.tool-card .tool-name')).some(
                  (name) => /^read$/i.test(name.textContent.trim()),
                ),
              120_000,
              'AGY Read tool card and reply',
            );
            const readCard = Array.from(document.querySelectorAll('.tool-card')).find(
              (card) => /^read$/i.test(card.querySelector('.tool-name')?.textContent.trim() || ''),
            );
            const readSummary = readCard?.querySelector('summary');
            click(readSummary, 'AGY Read tool summary');
            await markStage('04-read-tool');
            const beforeNativeViewEvents = terminalOutputEvents.length;
            click(
              readCard?.querySelector('[data-testid="agy-tool-native-view"]'),
              'View in AGY tool action',
            );
            await waitFor(
              () => terminalOutputEvents.length > beforeNativeViewEvents,
              20_000,
              'AGY native tool detail redraw',
            );
            await markStage('05-read-native-view');
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              interactionCase: 'viewer',
              completionToken,
              nativeViewMode:
                document.querySelector('[data-testid="agy-surface"]')?.getAttribute('data-mode'),
              readCardText: readCard?.textContent || '',
              observations,
            };
          }

          // Reproduce the original lock exactly. Every value change is sent by
          // the real React textarea while AGY redraws its slash TUI underneath.
          for (const value of ['/', '/m', '/mo']) {
            setComposer(value);
            await waitFor(
              () => composer()?.value === value && composer()?.disabled === false,
              5_000,
              'continuous slash value ' + value,
            );
            await sleep(250);
            if (composer()?.disabled) {
              throw new Error('AGY composer locked after typing ' + value);
            }
          }
          await waitFor(
            () =>
              Array.from(document.querySelectorAll('.agy-slash-menu .slash-item'))
                .some((item) => item.querySelector('.slash-name')?.textContent === '/model'),
            10_000,
            'live /model suggestion',
          );
          await markStage('04-slash-model');
          const modelCommand = Array.from(
            document.querySelectorAll('.agy-slash-menu .slash-item'),
          ).find((item) => item.querySelector('.slash-name')?.textContent === '/model');
          click(modelCommand, 'clickable /model suggestion');
          await waitFor(() => composer()?.value === '/model', 5_000, '/model completion');
          click(sendButton(), 'AGY Send button');
          await waitFor(
            () =>
              document.querySelector(
                '[data-testid="agy-overlay-modelPicker"] .agy-overlay-row',
              ) !== null,
            20_000,
            'clickable AGY model choices',
          );
          await markStage('05-model-picker');
          click(
            document.querySelector(
              '[data-testid="agy-overlay-modelPicker"] .agy-overlay-row',
            ),
            'first AGY model choice',
          );
          await waitFor(
            () =>
              document
                .querySelector('[data-testid="agy-overlay-modelPicker"] .agy-overlay-row')
                ?.getAttribute('aria-selected') === 'true',
            5_000,
            'focused AGY model choice',
          );
          click(
            document.querySelector(
              '[data-testid="agy-overlay-modelPicker"] .agy-overlay-actions button:not(.ghost)',
            ),
            'apply AGY model choice',
          );
          await waitFor(
            () => composer()?.disabled === false,
            20_000,
            'prompt after model choice',
          );
          await markStage('06-model-selected');

          await inspectOverlay('/permissions', 'permissionScopes', '06-permissions');
          await inspectOverlay('/resume', 'sessionPicker', '06-resume');
          await inspectOverlay('/context', 'contextReport', '06-context');
          await inspectOverlay('/usage', 'quotaReport', '06-usage');

          const replyToken = 'COZYPAD_AGY_UI_REPLY_' + Date.now();
          const replyPrompt = 'Reply with exactly ' + replyToken;
          await submitFromUi(replyPrompt);
          await waitFor(
            () => assistantContains(replyToken),
            120_000,
            'AGY response rendered as an assistant message',
          );
          await markStage('07-reply');
          const replySnapshot = assistantTextContaining(replyToken);
          if (replySnapshot === null) {
            throw new Error('Could not snapshot the completed AGY reply');
          }

          // Slash commands are modal controls, but they must never replace or
          // erase the conversation that was already rendered in the timeline.
          await inspectOverlay(
            '/model',
            'modelPicker',
            '07-model-after-reply',
            replyPrompt,
            replyToken,
            replySnapshot,
          );
          await inspectOverlay(
            '/usage',
            'quotaReport',
            '07-usage-after-reply',
            replyPrompt,
            replyToken,
            replySnapshot,
          );
          await markStage('07-conversation-preserved');

          if (${JSON.stringify(AGY_HISTORY_ONLY)}) {
            return {
              profile: profile.name,
              version: installation.version || 'unknown',
              uiDriven: true,
              historyPreserved: true,
              overlaysVerified: ['model-after-reply', 'usage-after-reply'],
              replySnapshotVerified: true,
              observations,
            };
          }

          const cancelPrompt =
            'Inspect this directory carefully and keep working for at least 30 seconds before replying.';
          await submitFromUi(cancelPrompt);
          await markStage('08-running-requested');
          await waitFor(
            () =>
              document.querySelector('[data-testid="agy-surface"]')?.getAttribute('data-mode') ===
                'running' &&
              document.querySelector('[data-testid="agy-stop"]') !== null,
            20_000,
            'visible Stop button while AGY is running',
          );
          await markStage('08-running');
          click(document.querySelector('[data-testid="agy-stop"]'), 'AGY Stop button');
          await waitFor(
            () =>
              document.querySelector('.agy-stop-confirmed') !== null &&
              composer()?.disabled === false,
            15_000,
            'verified Stop acknowledgement and editable prompt',
          );
          await markStage('09-stopped');

          const stopToken = 'COZYPAD_AGY_UI_AFTER_STOP_' + Date.now();
          await submitFromUi('Reply with exactly ' + stopToken);
          await waitFor(
            () => assistantContains(stopToken),
            120_000,
            'post-Stop assistant response',
          );
          await markStage('10-post-stop-reply');

          if (document.querySelector('.agy-native-navigation') !== null) {
            throw new Error('Visible arrow navigation controls leaked into AGY chat');
          }
          if (document.querySelector('.agy-tui-start-screen') !== null) {
            throw new Error('Raw terminal start screen leaked into AGY chat');
          }

          return {
            profile: profile.name,
            version: installation.version || 'unknown',
            uiDriven: true,
            welcomeSeen,
            startOptions,
            slashCharacters: 3,
            slashClickVerified: true,
            overlaysVerified: ['model', 'permissions', 'resume', 'context', 'usage'],
            replyVerified: true,
            stopVerified: true,
            terminalChromeHidden: true,
            observations,
          };
        } catch (error) {
          await markStage('99-error');
          return {
            __error:
              error instanceof Error
                ? error.message + '\\n' + (error.stack || '')
                : String(error),
            observations,
          };
        } finally {
          unsubscribeTerminalOutput();
          if (sessionId !== null) {
            try { await bridge.deleteAgentSession({ sessionId }); } catch {}
          }
          if (profileId !== null) {
            try { await bridge.disconnect({ profileId }); } catch {}
          }
        }
      })()`,
      true,
    ).then(
      (value) => {
        result = value;
        settled = true;
      },
      (error: unknown) => {
        executionError = error;
        settled = true;
      },
    );

    const captured = new Set<string>();
    while (!settled) {
      const stage: unknown = await win.webContents.executeJavaScript(
        'document.documentElement.dataset.agySmokeStage || ""',
        true,
      );
      if (typeof stage === 'string' && stage !== '' && !captured.has(stage)) {
        captured.add(stage);
        let image: Awaited<ReturnType<typeof win.webContents.capturePage>> | null = null;
        let captureError: unknown;
        for (let attempt = 0; attempt < 4 && image === null; attempt += 1) {
          try {
            image = await win.webContents.capturePage();
          } catch (error) {
            captureError = error;
            await new Promise((resolve) => setTimeout(resolve, 180));
          }
        }
        if (image === null) throw captureError;
        await fs.writeFile(path.join(visualDir, `${stage}.png`), image.toPNG());
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.agySmokeCaptured = ${JSON.stringify(stage)}`,
          true,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await execution;
    if (executionError !== undefined) throw executionError;
    console.log('[agy-ui-smoke] screenshots:', visualDir);

    if (
      typeof result === 'object' &&
      result !== null &&
      'observations' in result &&
      Array.isArray(result.observations)
    ) {
      const observationFile = path.join(visualDir, 'observations.json');
      await fs.writeFile(
        observationFile,
        JSON.stringify(result.observations, null, 2),
        'utf8',
      );
      const observationCount = result.observations.length;
      const summary = { ...(result as Record<string, unknown>) };
      delete summary.observations;
      result = {
        ...summary,
        observationCount,
        observationFile,
      };
      console.log('[agy-ui-smoke] observations:', observationFile);
    }

    if (
      typeof result === 'object' &&
      result !== null &&
      '__error' in result &&
      typeof result.__error === 'string'
    ) {
      throw new Error(result.__error);
    }
    console.log('[agy-ui-smoke] OK:', JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error('[agy-ui-smoke] FAILED:', error);
    app.exit(1);
  }
}

// 第二個實例會與第一個爭寫 profiles.json / known_hosts.json，直接把焦點還給既有視窗。
const gotLock =
  SMOKE_TEST ||
  AGY_SMOKE_TEST ||
  AGY_BACKEND_SMOKE_TEST ||
  app.requestSingleInstanceLock();
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
        mockData: USE_MOCK,
        startupWarnings,
        isLocalProfile: (profileId) => !USE_MOCK && isLocalProfile(profileId),
      },
      win,
    );
    win.on('closed', () => {
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
  if (AGY_SMOKE_TEST) void runAgyUiSmokeTest(win);
  if (AGY_BACKEND_SMOKE_TEST) void runAgyBackendSmokeTest(win);
});

app.on('window-all-closed', () => {
  app.quit();
});
