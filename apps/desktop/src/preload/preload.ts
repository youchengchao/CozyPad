import { contextBridge, ipcRenderer } from 'electron';
import {
  AgentCommunicationErrorEventSchema,
  ApplicationMenuRequestSchema,
  AgentAttachmentBatchSchema,
  AgentDetectionRequestSchema,
  AgentInstallationSchema,
  AgentSessionBundleSchema,
  AgentSessionChangedEventSchema,
  AgentSessionDeletedEventSchema,
  AgentSessionListRequestSchema,
  AgentSessionRequestSchema,
  AgentTimelineChangedEventSchema,
  AnswerAgentQuestionRequestSchema,
  DeclineAgentQuestionRequestSchema,
  ConnectRequestSchema,
  ConnectionProfileDraftSchema,
  ConnectionStateChangedSchema,
  CreateAgentSessionRequestSchema,
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
  RenameAgentSessionRequestSchema,
  ResolveAgentApprovalRequestSchema,
  SetAgentSessionConfigOptionRequestSchema,
  SendAgentMessageRequestSchema,
  UploadAgentAttachmentsRequestSchema,
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

  showApplicationMenu: (request) => {
    ipcRenderer.send(
      IpcChannels.applicationMenuOpen,
      ApplicationMenuRequestSchema.parse(request),
    );
  },

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

  cancelRequest: (requestId) =>
    ipcRenderer.invoke(IpcChannels.cancelRequest, requestId),

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

  detectAgent: async (request) =>
    AgentInstallationSchema.parse(
      await ipcRenderer.invoke(
        IpcChannels.agentDetect,
        AgentDetectionRequestSchema.parse(request),
      ),
    ),

  listAgentSessions: async (request) =>
    AgentSessionBundleSchema.array().parse(
      await ipcRenderer.invoke(
        IpcChannels.agentSessionsList,
        AgentSessionListRequestSchema.parse(request),
      ),
    ),

  createAgentSession: async (request) =>
    AgentSessionBundleSchema.parse(
      await ipcRenderer.invoke(
        IpcChannels.agentSessionCreate,
        CreateAgentSessionRequestSchema.parse(request),
      ),
    ),

  reviveAgentSession: async (request) =>
    AgentSessionBundleSchema.parse(
      await ipcRenderer.invoke(
        IpcChannels.agentSessionRevive,
        AgentSessionRequestSchema.parse(request),
      ),
    ),

  renameAgentSession: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentSessionRename,
      RenameAgentSessionRequestSchema.parse(request),
    ),

  deleteAgentSession: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentSessionDelete,
      AgentSessionRequestSchema.parse(request),
    ),

  uploadAgentAttachments: async (request) =>
    AgentAttachmentBatchSchema.parse(
      await ipcRenderer.invoke(
        IpcChannels.agentAttachmentsUpload,
        UploadAgentAttachmentsRequestSchema.parse(request),
      ),
    ),

  sendAgentMessage: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentSessionSend,
      SendAgentMessageRequestSchema.parse(request),
    ),

  interruptAgentSession: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentSessionInterrupt,
      AgentSessionRequestSchema.parse(request),
    ),

  setAgentSessionConfigOption: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentSessionSetConfigOption,
      SetAgentSessionConfigOptionRequestSchema.parse(request),
    ),

  resolveAgentApproval: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentApprovalResolve,
      ResolveAgentApprovalRequestSchema.parse(request),
    ),

  answerAgentQuestion: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentQuestionAnswer,
      AnswerAgentQuestionRequestSchema.parse(request),
    ),

  declineAgentQuestion: (request) =>
    ipcRenderer.invoke(
      IpcChannels.agentQuestionDecline,
      DeclineAgentQuestionRequestSchema.parse(request),
    ),

  onAgentSessionChanged: (listener) =>
    subscribe(
      IpcChannels.agentSessionChanged,
      AgentSessionChangedEventSchema,
      listener,
    ),

  onAgentSessionDeleted: (listener) =>
    subscribe(
      IpcChannels.agentSessionDeleted,
      AgentSessionDeletedEventSchema,
      listener,
    ),

  onAgentTimelineChanged: (listener) =>
    subscribe(
      IpcChannels.agentTimelineChanged,
      AgentTimelineChangedEventSchema,
      listener,
    ),

  onAgentCommunicationError: (listener) =>
    subscribe(
      IpcChannels.agentCommunicationError,
      AgentCommunicationErrorEventSchema,
      listener,
    ),
};

contextBridge.exposeInMainWorld('cozypad', bridge);
