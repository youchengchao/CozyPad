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
} from './files';
import type { HostKeyDecision, HostKeyPromptEvent } from './hostkey';
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

  onHostKeyPrompt(listener: (event: HostKeyPromptEvent) => void): Unsubscribe;
  respondHostKey(decision: HostKeyDecision): Promise<void>;
}
