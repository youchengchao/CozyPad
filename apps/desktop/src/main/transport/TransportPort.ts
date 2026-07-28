import type { ConnectionStateChanged, TerminalOpenRequest } from '@cozypad/contracts';

export interface TransportEvents {
  onConnectionState(event: ConnectionStateChanged): void;
  onTerminalOutput(terminalId: string, data: Uint8Array): void;
  onTerminalClosed(terminalId: string, exitCode: number | null, reason?: string): void;
}

/** main process 內的 SSH/PTY 抽象；ssh2 與 mock 各自實作，之後換 Tauri 也是換這層。 */
export interface TransportPort {
  setEvents(events: TransportEvents): void;
  connect(profileId: string): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  openTerminal(request: TerminalOpenRequest): Promise<string>;
  writeTerminal(terminalId: string, data: Uint8Array): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  closeTerminal(terminalId: string): void;
  dispose(): void;
}
