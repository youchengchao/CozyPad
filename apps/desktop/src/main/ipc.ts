import { clipboard, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  ConnectRequestSchema,
  ConnectionProfileDraftSchema,
  DeleteProfileRequestSchema,
  FsCreateRequestSchema,
  FsPathRequestSchema,
  FsReadRequestSchema,
  FsRenameRequestSchema,
  FsTransferRequestSchema,
  FsWriteRequestSchema,
  HostKeyDecisionSchema,
  IpcChannels,
  RemoteSettingsPatchSchema,
  TerminalCloseRequestSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalResizeRequestSchema,
  base64ToBytes,
  bytesToBase64,
} from '@cozypad/contracts';
import type { RemoteFilesPort } from '@cozypad/remote-services';
import type { HostKeyGate } from './hostKeys';
import type { ProfileStorePort } from './profileStore';
import type { RemoteSettingsPort } from '@cozypad/remote-services';
import type { TmuxProvisionerPort } from '@cozypad/remote-services';
import type { TmuxSessionWatcher } from './tmuxWatcher';
import type { TelemetrySource } from '@cozypad/remote-services';
import type { TransportPort } from './transport/TransportPort';

export interface IpcServices {
  transport: TransportPort;
  profileStore: ProfileStorePort;
  files: RemoteFilesPort;
  telemetry: TelemetrySource;
  hostKeys: HostKeyGate | null;
  remoteSettings: RemoteSettingsPort;
  tmuxProvisioner: TmuxProvisionerPort;
  tmuxWatcher: TmuxSessionWatcher | null;
  mockData: boolean;
}

/** 所有 IPC 進出都經 Zod 驗證，且只接受主視窗的 sender（SPEC_V3 4.1、13）。 */
export function registerIpc(services: IpcServices, win: BrowserWindow): void {
  const {
    transport,
    profileStore,
    files,
    telemetry,
    hostKeys,
    remoteSettings,
    tmuxProvisioner,
    tmuxWatcher,
    mockData,
  } = services;

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  /**
   * 終端機輸出合併：`cat` 大檔或編譯輸出時，PTY 會以極小的 chunk 高頻回傳，
   * 一個 chunk 一次 IPC 會把 renderer 淹掉。以 16ms（約一幀）為窗口合併。
   */
  const outputBuffers = new Map<string, Uint8Array[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTerminalOutput = (): void => {
    flushTimer = null;
    for (const [terminalId, chunks] of outputBuffers) {
      if (chunks.length === 0) continue;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      send(IpcChannels.terminalOutput, {
        terminalId,
        dataBase64: bytesToBase64(merged),
      });
    }
    outputBuffers.clear();
  };

  transport.setEvents({
    onConnectionState: (event) => {
      send(IpcChannels.connectionState, event);
      if (event.state === 'connected') {
        telemetry.start(event.profileId, (snapshot) =>
          send(IpcChannels.telemetryUpdated, snapshot),
        );
        // 連線後立即偵測 tmux，缺少或版本過舊時由 UI 詢問安裝。
        void tmuxProvisioner
          .status()
          .then((status) => send(IpcChannels.tmuxStatusChanged, status))
          .catch(() => undefined);
        tmuxWatcher?.start({
          onSessions: (sessions) => send(IpcChannels.tmuxSessionsChanged, sessions),
        });
      }
      if (event.state === 'disconnected' || event.state === 'error') {
        telemetry.stop();
        tmuxWatcher?.stop();
        send(IpcChannels.tmuxSessionsChanged, []);
      }
    },
    onTerminalOutput: (terminalId, data) => {
      const chunks = outputBuffers.get(terminalId) ?? [];
      chunks.push(data);
      outputBuffers.set(terminalId, chunks);
      flushTimer ??= setTimeout(flushTerminalOutput, 16);
    },
    onTerminalClosed: (terminalId, exitCode, reason) => {
      flushTerminalOutput();
      send(IpcChannels.terminalClosed, {
        terminalId,
        exitCode,
        ...(reason === undefined ? {} : { reason }),
      });
    },
  });

  const assertSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (event.sender !== win.webContents) throw new Error('unauthorized IPC sender');
  };

  ipcMain.handle(IpcChannels.appInfo, (event) => {
    assertSender(event);
    return { mockData };
  });

  ipcMain.handle(IpcChannels.listProfiles, (event) => {
    assertSender(event);
    return profileStore.list();
  });

  ipcMain.handle(IpcChannels.saveProfile, (event, raw: unknown) => {
    assertSender(event);
    return profileStore.save(ConnectionProfileDraftSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.deleteProfile, (event, raw: unknown) => {
    assertSender(event);
    return profileStore.remove(DeleteProfileRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.connect, (event, raw: unknown) => {
    assertSender(event);
    return transport.connect(ConnectRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.disconnect, (event, raw: unknown) => {
    assertSender(event);
    return transport.disconnect(ConnectRequestSchema.parse(raw).profileId);
  });

  ipcMain.handle(IpcChannels.terminalOpen, async (event, raw: unknown) => {
    assertSender(event);
    const request = TerminalOpenRequestSchema.parse(raw);
    const terminalId = await transport.openTerminal(request);
    return { terminalId };
  });

  ipcMain.on(IpcChannels.terminalWrite, (event, raw: unknown) => {
    assertSender(event);
    const input = TerminalInputSchema.parse(raw);
    transport.writeTerminal(input.terminalId, base64ToBytes(input.dataBase64));
  });

  ipcMain.handle(IpcChannels.terminalResize, (event, raw: unknown) => {
    assertSender(event);
    const request = TerminalResizeRequestSchema.parse(raw);
    transport.resizeTerminal(request.terminalId, request.cols, request.rows);
  });

  ipcMain.handle(IpcChannels.terminalClose, (event, raw: unknown) => {
    assertSender(event);
    transport.closeTerminal(TerminalCloseRequestSchema.parse(raw).terminalId);
  });

  ipcMain.handle(IpcChannels.fsList, (event, raw: unknown) => {
    assertSender(event);
    return files.list(FsPathRequestSchema.parse(raw).path);
  });

  ipcMain.handle(IpcChannels.fsRead, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsReadRequestSchema.parse(raw);
    return { content: await files.readText(request.path, request.maxBytes, request.offset) };
  });

  ipcMain.handle(IpcChannels.fsReadBytes, async (event, raw: unknown) => {
    assertSender(event);
    return { dataBase64: await files.readBytes(FsPathRequestSchema.parse(raw).path) };
  });

  ipcMain.handle(IpcChannels.fsWrite, (event, raw: unknown) => {
    assertSender(event);
    const request = FsWriteRequestSchema.parse(raw);
    return files.write(request.path, request.contentBase64);
  });

  ipcMain.handle(IpcChannels.fsCreate, (event, raw: unknown) => {
    assertSender(event);
    const request = FsCreateRequestSchema.parse(raw);
    return files.create(request.directory, request.name, request.kind);
  });

  ipcMain.handle(IpcChannels.fsRename, (event, raw: unknown) => {
    assertSender(event);
    const request = FsRenameRequestSchema.parse(raw);
    return files.rename(request.path, request.newName);
  });

  ipcMain.handle(IpcChannels.fsDuplicate, async (event, raw: unknown) => {
    assertSender(event);
    return { path: await files.duplicate(FsPathRequestSchema.parse(raw).path) };
  });

  ipcMain.handle(IpcChannels.fsCopy, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsTransferRequestSchema.parse(raw);
    return { path: await files.copyTo(request.sourcePath, request.destinationDirectory) };
  });

  ipcMain.handle(IpcChannels.fsMove, async (event, raw: unknown) => {
    assertSender(event);
    const request = FsTransferRequestSchema.parse(raw);
    return { path: await files.moveTo(request.sourcePath, request.destinationDirectory) };
  });

  ipcMain.handle(IpcChannels.fsDelete, (event, raw: unknown) => {
    assertSender(event);
    return files.remove(FsPathRequestSchema.parse(raw).path);
  });

  ipcMain.handle(IpcChannels.remoteSettingsGet, (event) => {
    assertSender(event);
    return remoteSettings.get();
  });

  ipcMain.handle(IpcChannels.remoteSettingsSet, (event, raw: unknown) => {
    assertSender(event);
    return remoteSettings.set(RemoteSettingsPatchSchema.parse(raw));
  });

  ipcMain.handle(IpcChannels.clipboardRead, (event) => {
    assertSender(event);
    return clipboard.readText();
  });

  ipcMain.handle(IpcChannels.clipboardWrite, (event, raw: unknown) => {
    assertSender(event);
    if (typeof raw !== 'string') throw new Error('clipboard payload must be a string');
    clipboard.writeText(raw);
  });

  ipcMain.handle(IpcChannels.tmuxStatus, (event) => {
    assertSender(event);
    return tmuxProvisioner.status();
  });

  ipcMain.handle(IpcChannels.tmuxInstall, async (event) => {
    assertSender(event);
    const result = await tmuxProvisioner.install(
      (progress) => send(IpcChannels.tmuxInstallProgress, progress),
      (log) => send(IpcChannels.tmuxInstallLog, log),
    );
    send(IpcChannels.tmuxStatusChanged, result.status);
    return result;
  });

  ipcMain.handle(IpcChannels.remoteCleanup, (event, raw: unknown) => {
    assertSender(event);
    return tmuxProvisioner.cleanup(raw === true);
  });

  ipcMain.handle(IpcChannels.hostKeyDecision, (event, raw: unknown) => {
    assertSender(event);
    const decision = HostKeyDecisionSchema.parse(raw);
    hostKeys?.resolve(decision.requestId, decision.accept);
  });
}
