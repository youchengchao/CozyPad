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
  TerminalCloseRequest,
  TerminalClosedEvent,
  TerminalInput,
  TerminalOpenRequest,
  TerminalOpened,
  TerminalOutputEvent,
  TerminalResizeRequest,
} from './terminal';

export type Unsubscribe = () => void;

export type PlatformBridgeKind = 'electron' | 'capacitor' | 'mock';

export interface AppInfo {
  /** true = 內建假資料模式（COZYPAD_MOCK=1 或瀏覽器 mock bridge）。 */
  mockData: boolean;
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
  fsReadBytes(request: FsPathRequest): Promise<FsBytes>;
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

  /** 移除 CozyPad 在遠端主機留下的痕跡（建置暫存、PATH／tmux 設定區塊）。 */
  cleanupRemote(removeTmuxBinary: boolean): Promise<string>;
}
