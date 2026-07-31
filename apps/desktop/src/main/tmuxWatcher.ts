import type { TmuxRuntime, TmuxSessionInfo } from '@cozypad/tmux-runtime';

export interface TmuxWatcherEvents {
  onSessions(sessions: TmuxSessionInfo[]): void;
}

/**
 * 週期性回報遠端 tmux session 清單，讓 UI 能在遠端 session 結束時
 * 一併關閉本地檢視（SPEC_V3 §5.4 reconciliation 的即時來源）。
 */
export class TmuxSessionWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastSerialized = '';

  constructor(
    private readonly tmux: TmuxRuntime,
    private readonly intervalMs = 4000,
  ) {}

  start(events: TmuxWatcherEvents): void {
    this.stop();
    const poll = async (): Promise<void> => {
      if (this.polling) return;
      this.polling = true;
      try {
        const sessions = await this.tmux.listSessions();
        const serialized = JSON.stringify(sessions);
        if (serialized !== this.lastSerialized) {
          this.lastSerialized = serialized;
          events.onSessions(sessions);
        }
      } catch {
        // tmux 尚未安裝或連線中斷：保持輪詢，斷線時由 stop() 收拾
      } finally {
        this.polling = false;
      }
    };
    void poll();
    this.timer = setInterval(() => void poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.lastSerialized = '';
  }
}
