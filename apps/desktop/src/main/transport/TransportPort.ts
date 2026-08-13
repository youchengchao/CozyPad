import type { ConnectionStateChanged, DirectoryListing, TerminalOpenRequest } from '@cozypad/contracts';

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
  exec(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
  /**
   * 同 exec，但每收到一行就回呼——長時間作業（如建置 tmux）才能顯示即時進度。
   * timeoutMs=0 表示由遠端程序／連線生命週期決定何時結束。
   */
  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs?: number,
    collectOutput?: boolean,
    signal?: AbortSignal,
  ): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;

  // 原生與 SFTP 檔案系統 API
  fsList(path: string): Promise<DirectoryListing>;
  fsReadText(path: string, maxBytes: number, offset: number): Promise<string>;
  fsReadBytes(path: string, maxBytes: number): Promise<string>;
  fsWrite(path: string, data: Uint8Array): Promise<void>;
  fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void>;
  fsRename(path: string, newName: string): Promise<void>;
  fsDuplicate(path: string): Promise<string>;
  fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  fsRemove(path: string): Promise<void>;
  /**
   * Opens an interactive SSH channel with a real PTY. When command is supplied,
   * the command is started directly on that PTY instead of being typed into a
   * login shell. This avoids shell-startup races and is required by tmux attach.
   */
  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string>;
  writeTerminal(terminalId: string, data: Uint8Array): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  closeTerminal(terminalId: string): void;
  dispose(): void;
}
