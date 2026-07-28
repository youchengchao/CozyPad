import path from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import type { ConnectionProfile } from '@cozypad/contracts';
import { registerIpc } from './ipc';
import { MockTransport } from './transport/mockTransport';
import { Ssh2Transport } from './transport/ssh2Transport';
import type { TransportPort } from './transport/TransportPort';

const DEV_URL = process.env.COZYPAD_DEV_URL;
const SMOKE_TEST = process.argv.includes('--smoke-test');
const USE_MOCK = process.env.COZYPAD_MOCK === '1' || SMOKE_TEST;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 正式 profile 儲存（secure storage）在 Phase 3 才落地；
 * 在那之前可用環境變數指定一台真實主機做手動驗證。
 */
function createTransport(): TransportPort {
  if (USE_MOCK) return new MockTransport();
  const host = process.env.COZYPAD_SSH_HOST;
  const profiles: ConnectionProfile[] = host
    ? [
        {
          id: 'env-ssh',
          name: `env:${host}`,
          host,
          port: Number(process.env.COZYPAD_SSH_PORT ?? 22),
          username: process.env.COZYPAD_SSH_USER ?? 'root',
        },
      ]
    : [];
  return new Ssh2Transport({
    profiles,
    getPassword: () => process.env.COZYPAD_SSH_PASSWORD ?? null,
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

app.whenReady().then(() => {
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

  const transport = createTransport();
  const win = createWindow();
  registerIpc(transport, win);
  win.on('closed', () => transport.dispose());

  if (SMOKE_TEST) void runSmokeTest(win);
});

app.on('window-all-closed', () => {
  app.quit();
});
