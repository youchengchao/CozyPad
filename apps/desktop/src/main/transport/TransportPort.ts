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
  /** 在遠端執行單一命令並回傳 stdout（telemetry 與檔案操作的基礎）。 */
  exec(command: string, timeoutMs?: number): Promise<string>;
  /**
   * 同 exec，但每收到一行就回呼——長時間作業（如建置 tmux）才能顯示即時進度。
   */
  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs?: number,
  ): Promise<string>;
  openTerminal(request: TerminalOpenRequest): Promise<string>;
  writeTerminal(terminalId: string, data: Uint8Array): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  closeTerminal(terminalId: string): void;
  dispose(): void;
}
