import type {
  ConnectRequest,
  ConnectionProfile,
  ConnectionProfileDraft,
  ConnectionStateChanged,
  DeleteProfileRequest,
} from './connection';
import type {
  DirectoryListing,
  FsBytes,
  FsContent,
  FsCreateRequest,
  FsPathRequest,
  FsPathResult,
  FsReadBytesRequest,
  FsReadRequest,
  FsRenameRequest,
  FsTransferRequest,
  FsWriteRequest,
  SaveDownloadRequest,
  SaveDownloadResult,
} from './files';
import type { HostKeyDecision, HostKeyPromptEvent } from './hostkey';
import type { RemoteSettings, RemoteSettingsPatch } from './remoteSettings';
import type {
  TmuxInstallLog,
  TmuxInstallProgress,
  TmuxInstallResult,
  TmuxStatus,
} from './tmuxSetup';
import type { TelemetrySnapshot } from './telemetry';
import type {
  AgentCommunicationErrorEvent,
  AgentAttachment,
  AgentDetectionRequest,
  AgentInstallation,
  AgentSessionBundle,
  AgentSessionChangedEvent,
  AgentSessionDeletedEvent,
  AgentSessionListRequest,
  AgentSessionRequest,
  AgentTimelineChangedEvent,
  AnswerAgentQuestionRequest,
  CreateAgentSessionRequest,
  DeclineAgentQuestionRequest,
  DeleteAgentSessionResult,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SetAgentSessionConfigOptionRequest,
  SendAgentMessageRequest,
  UploadAgentAttachmentsRequest,
} from './agentCommunication';
import type {
  TerminalCloseRequest,
  TerminalClosedEvent,
  TerminalInput,
  TerminalOpenRequest,
  TerminalOpened,
  TerminalOutputEvent,
  TerminalResizeRequest,
} from './terminal';
import type { ApplicationMenuRequest } from './ipc';

export type Unsubscribe = () => void;

export type PlatformBridgeKind = 'electron' | 'capacitor';

export interface AppInfo {
  /**
   * 啟動時降級處理過的問題（例如本機設定檔解不開）。App 仍可使用，
   * 但相關資料是空的，必須讓使用者看得到原因。
   */
  startupWarnings?: string[];
}

/**
 * 背景維持連線的能力。手機需要前景服務才能在切換 app／關螢幕時保住 socket；
 * 桌面只要視窗開著就會持續執行，回報 unsupported。
 */
export interface BackgroundMode {
  supported: boolean;
  enabled: boolean;
}

/**
 * 唯一允許 React app 接觸平台能力的介面（SPEC_V3 3.1）。
 * Electron preload、Capacitor plugin 與瀏覽器 mock 各自實作。
 */
export interface PlatformBridge {
  readonly kind: PlatformBridgeKind;

  getAppInfo(): Promise<AppInfo>;
  showApplicationMenu?(request: ApplicationMenuRequest): void;
  listProfiles(): Promise<ConnectionProfile[]>;
  saveProfile(draft: ConnectionProfileDraft): Promise<ConnectionProfile>;
  deleteProfile(request: DeleteProfileRequest): Promise<void>;
  connect(request: ConnectRequest): Promise<void>;
  disconnect(request: ConnectRequest): Promise<void>;
  onConnectionState(listener: (event: ConnectionStateChanged) => void): Unsubscribe;

  openTerminal(request: TerminalOpenRequest): Promise<TerminalOpened>;
  writeTerminal(input: TerminalInput): void;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  closeTerminal(request: TerminalCloseRequest): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutputEvent) => void): Unsubscribe;
  onTerminalClosed(listener: (event: TerminalClosedEvent) => void): Unsubscribe;

  /** 連線期間每 5 秒推送一次（SPEC FR-03）。 */
  onTelemetry(listener: (snapshot: TelemetrySnapshot) => void): Unsubscribe;

  fsList(request: FsPathRequest): Promise<DirectoryListing>;
  fsRead(request: FsReadRequest): Promise<FsContent>;
  fsReadBytes(request: FsReadBytesRequest): Promise<FsBytes>;
  fsWrite(request: FsWriteRequest): Promise<void>;
  fsCreate(request: FsCreateRequest): Promise<void>;
  fsRename(request: FsRenameRequest): Promise<void>;
  fsDuplicate(request: FsPathRequest): Promise<FsPathResult>;
  fsCopy(request: FsTransferRequest): Promise<FsPathResult>;
  fsMove(request: FsTransferRequest): Promise<FsPathResult>;
  fsDelete(request: FsPathRequest): Promise<void>;
  /**
   * 原生平台可選的下載落盤能力。Android 使用 MediaStore／系統文件選擇器；
   * 未提供時 renderer 使用標準 browser download。
   */
  saveDownload?(request: SaveDownloadRequest): Promise<SaveDownloadResult>;

  onHostKeyPrompt(listener: (event: HostKeyPromptEvent) => void): Unsubscribe;
  respondHostKey(decision: HostKeyDecision): Promise<void>;

  /** 遠端主機上的專案設定；需要連線中。 */
  getRemoteSettings(): Promise<RemoteSettings>;
  setRemoteSettings(patch: RemoteSettingsPatch): Promise<RemoteSettings>;

  getBackgroundMode(): Promise<BackgroundMode>;
  setBackgroundMode(enabled: boolean): Promise<void>;

  /** 系統剪貼簿；桌面走原生 API，不受 renderer 權限限制。 */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  /** tmux 佈建：連線後自動偵測，缺少或版本過舊時由 UI 詢問是否安裝。 */
  getTmuxStatus(): Promise<TmuxStatus>;
  installTmux(): Promise<TmuxInstallResult>;
  onTmuxStatus(listener: (status: TmuxStatus) => void): Unsubscribe;
  onTmuxInstallProgress(listener: (progress: TmuxInstallProgress) => void): Unsubscribe;
  /** 安裝過程的即時指令與輸出（批次送達以免洗版）。 */
  onTmuxInstallLog(listener: (log: TmuxInstallLog) => void): Unsubscribe;

  detectAgent(request: AgentDetectionRequest): Promise<AgentInstallation>;
  listAgentSessions(request: AgentSessionListRequest): Promise<AgentSessionBundle[]>;
  createAgentSession(request: CreateAgentSessionRequest): Promise<AgentSessionBundle>;
  /**
   * Relaunch an exited session's agent in place: same record, same timeline,
   * resuming the bound conversation when the agent supports it.
   */
  reviveAgentSession(request: AgentSessionRequest): Promise<AgentSessionBundle>;
  /**
   * Canonical Markdown recovered from AGY's own local conversation store.
   * Fresh sessions must include their exact submitted prompt so the backend
   * can bind the correct native conversation without exposing other history.
   */
  renameAgentSession(request: RenameAgentSessionRequest): Promise<void>;
  deleteAgentSession(
    request: AgentSessionRequest,
  ): Promise<DeleteAgentSessionResult>;
  uploadAgentAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]>;
  sendAgentMessage(request: SendAgentMessageRequest): Promise<void>;
  interruptAgentSession(request: AgentSessionRequest): Promise<void>;
  /** `session/set_config_option` — how the model (and codex effort) is picked. */
  setAgentSessionConfigOption(
    request: SetAgentSessionConfigOptionRequest,
  ): Promise<void>;
  resolveAgentApproval(request: ResolveAgentApprovalRequest): Promise<void>;
  answerAgentQuestion(request: AnswerAgentQuestionRequest): Promise<void>;
  declineAgentQuestion(request: DeclineAgentQuestionRequest): Promise<void>;
  onAgentSessionChanged(
    listener: (event: AgentSessionChangedEvent) => void,
  ): Unsubscribe;
  onAgentSessionDeleted(
    listener: (event: AgentSessionDeletedEvent) => void,
  ): Unsubscribe;
  onAgentTimelineChanged(
    listener: (event: AgentTimelineChangedEvent) => void,
  ): Unsubscribe;
  onAgentCommunicationError(
    listener: (event: AgentCommunicationErrorEvent) => void,
  ): Unsubscribe;

  /** 移除 CozyPad 在遠端主機留下的痕跡（建置暫存、PATH／tmux 設定區塊）。 */
  cleanupRemote(removeTmuxBinary: boolean): Promise<string>;

  /** 取消指定的背景請求 */
  cancelRequest(requestId: string): Promise<void>;
}
