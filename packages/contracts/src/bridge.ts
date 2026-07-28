import type {
  ConnectRequest,
  ConnectionProfile,
  ConnectionStateChanged,
} from './connection';
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

/**
 * 唯一允許 React app 接觸平台能力的介面（SPEC_V3 3.1）。
 * Electron preload、Capacitor plugin 與瀏覽器 mock 各自實作。
 */
export interface PlatformBridge {
  readonly kind: PlatformBridgeKind;

  listProfiles(): Promise<ConnectionProfile[]>;
  connect(request: ConnectRequest): Promise<void>;
  disconnect(request: ConnectRequest): Promise<void>;
  onConnectionState(listener: (event: ConnectionStateChanged) => void): Unsubscribe;

  openTerminal(request: TerminalOpenRequest): Promise<TerminalOpened>;
  writeTerminal(input: TerminalInput): void;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  closeTerminal(request: TerminalCloseRequest): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutputEvent) => void): Unsubscribe;
  onTerminalClosed(listener: (event: TerminalClosedEvent) => void): Unsubscribe;
}
