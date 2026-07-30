import { contextBridge, ipcRenderer } from 'electron';
import {
  ConnectRequestSchema,
  ConnectionProfileDraftSchema,
  ConnectionStateChangedSchema,
  DeleteProfileRequestSchema,
  FsCreateRequestSchema,
  FsPathRequestSchema,
  FsReadRequestSchema,
  FsRenameRequestSchema,
  FsTransferRequestSchema,
  FsWriteRequestSchema,
  HostKeyDecisionSchema,
  HostKeyPromptEventSchema,
  IpcChannels,
  RemoteSettingsPatchSchema,
  TelemetrySnapshotSchema,
  TmuxInstallLogSchema,
  TmuxInstallProgressSchema,
  TmuxStatusSchema,
  TerminalCloseRequestSchema,
  TerminalClosedEventSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalOutputEventSchema,
  TerminalResizeRequestSchema,
} from '@cozypad/contracts';
import type { PlatformBridge, Unsubscribe } from '@cozypad/contracts';

interface ParsableSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function subscribe<T>(
  channel: string,
  schema: ParsableSchema<T>,
  listener: (event: T) => void,
): Unsubscribe {
  const handler = (_event: unknown, payload: unknown): void => {
    const parsed = schema.safeParse(payload);
    if (parsed.success) listener(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** 唯一暴露給 renderer 的 API 面；窄、具名、雙向 Zod 驗證（SPEC_V3 4.1）。 */
const bridge: PlatformBridge = {
  kind: 'electron',

  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),

  listProfiles: () => ipcRenderer.invoke(IpcChannels.listProfiles),

  saveProfile: (draft) =>
    ipcRenderer.invoke(
      IpcChannels.saveProfile,
      ConnectionProfileDraftSchema.parse(draft),
    ),

  deleteProfile: (request) =>
    ipcRenderer.invoke(
      IpcChannels.deleteProfile,
      DeleteProfileRequestSchema.parse(request),
    ),

  connect: (request) =>
    ipcRenderer.invoke(IpcChannels.connect, ConnectRequestSchema.parse(request)),

  disconnect: (request) =>
    ipcRenderer.invoke(IpcChannels.disconnect, ConnectRequestSchema.parse(request)),

  onConnectionState: (listener) =>
    subscribe(IpcChannels.connectionState, ConnectionStateChangedSchema, listener),

  openTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalOpen,
      TerminalOpenRequestSchema.parse(request),
    ),

  writeTerminal: (input) => {
    ipcRenderer.send(IpcChannels.terminalWrite, TerminalInputSchema.parse(input));
  },

  resizeTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalResize,
      TerminalResizeRequestSchema.parse(request),
    ),

  closeTerminal: (request) =>
    ipcRenderer.invoke(
      IpcChannels.terminalClose,
      TerminalCloseRequestSchema.parse(request),
    ),

  onTerminalOutput: (listener) =>
    subscribe(IpcChannels.terminalOutput, TerminalOutputEventSchema, listener),

  onTerminalClosed: (listener) =>
    subscribe(IpcChannels.terminalClosed, TerminalClosedEventSchema, listener),

  onTelemetry: (listener) =>
    subscribe(IpcChannels.telemetryUpdated, TelemetrySnapshotSchema, listener),

  fsList: (request) =>
    ipcRenderer.invoke(IpcChannels.fsList, FsPathRequestSchema.parse(request)),

  fsRead: (request) =>
    ipcRenderer.invoke(IpcChannels.fsRead, FsReadRequestSchema.parse(request)),

  fsReadBytes: (request) =>
    ipcRenderer.invoke(IpcChannels.fsReadBytes, FsPathRequestSchema.parse(request)),

  fsWrite: (request) =>
    ipcRenderer.invoke(IpcChannels.fsWrite, FsWriteRequestSchema.parse(request)),

  fsCreate: (request) =>
    ipcRenderer.invoke(IpcChannels.fsCreate, FsCreateRequestSchema.parse(request)),

  fsRename: (request) =>
    ipcRenderer.invoke(IpcChannels.fsRename, FsRenameRequestSchema.parse(request)),

  fsDuplicate: (request) =>
    ipcRenderer.invoke(IpcChannels.fsDuplicate, FsPathRequestSchema.parse(request)),

  fsCopy: (request) =>
    ipcRenderer.invoke(IpcChannels.fsCopy, FsTransferRequestSchema.parse(request)),

  fsMove: (request) =>
    ipcRenderer.invoke(IpcChannels.fsMove, FsTransferRequestSchema.parse(request)),

  fsDelete: (request) =>
    ipcRenderer.invoke(IpcChannels.fsDelete, FsPathRequestSchema.parse(request)),

  onHostKeyPrompt: (listener) =>
    subscribe(IpcChannels.hostKeyPrompt, HostKeyPromptEventSchema, listener),

  respondHostKey: (decision) =>
    ipcRenderer.invoke(IpcChannels.hostKeyDecision, HostKeyDecisionSchema.parse(decision)),

  // 桌面只要視窗開著就持續執行，不需要前景服務。
  getBackgroundMode: () => Promise.resolve({ supported: false, enabled: false }),
  setBackgroundMode: () => Promise.resolve(),

  readClipboard: () => ipcRenderer.invoke(IpcChannels.clipboardRead),

  writeClipboard: (text) => ipcRenderer.invoke(IpcChannels.clipboardWrite, text),

  getTmuxStatus: () => ipcRenderer.invoke(IpcChannels.tmuxStatus),

  installTmux: () => ipcRenderer.invoke(IpcChannels.tmuxInstall),

  cleanupRemote: (removeTmuxBinary) =>
    ipcRenderer.invoke(IpcChannels.remoteCleanup, removeTmuxBinary),

  onTmuxStatus: (listener) =>
    subscribe(IpcChannels.tmuxStatusChanged, TmuxStatusSchema, listener),

  onTmuxInstallProgress: (listener) =>
    subscribe(IpcChannels.tmuxInstallProgress, TmuxInstallProgressSchema, listener),

  onTmuxInstallLog: (listener) =>
    subscribe(IpcChannels.tmuxInstallLog, TmuxInstallLogSchema, listener),

  getRemoteSettings: () => ipcRenderer.invoke(IpcChannels.remoteSettingsGet),

  setRemoteSettings: (patch) =>
    ipcRenderer.invoke(
      IpcChannels.remoteSettingsSet,
      RemoteSettingsPatchSchema.parse(patch),
    ),
};

contextBridge.exposeInMainWorld('cozypad', bridge);
