import { quoteShellArg } from '@cozypad/contracts';

export type RemoteExec = (command: string, timeoutMs?: number) => Promise<string>;

/** CozyPad 管理的 session 名稱前綴（SPEC FR-08）。 */
export const SESSION_PREFIX = 'sdh_';

export interface TmuxSessionInfo {
  /** #{session_id}，如 "$3"——同一 tmux server 生命週期內唯一。 */
  sessionId: string;
  name: string;
  createdEpoch: number;
  attached: boolean;
}

export interface TmuxPaneInfo {
  paneId: string;
  pid: number;
  currentCommand: string;
  currentPath: string;
}

export function normalizeSessionName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized.startsWith(SESSION_PREFIX)
    ? sanitized
    : `${SESSION_PREFIX}${sanitized}`;
}

export function parseListSessions(output: string): TmuxSessionInfo[] {
  const sessions: TmuxSessionInfo[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('__')) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    sessions.push({
      sessionId: parts[0]!,
      name: parts[1]!,
      createdEpoch: Number.parseInt(parts[2]!, 10) || 0,
      attached: parts[3] !== '0',
    });
  }
  return sessions;
}

export function parseListPanes(output: string): TmuxPaneInfo[] {
  const panes: TmuxPaneInfo[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('__')) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    panes.push({
      paneId: parts[0]!,
      pid: Number.parseInt(parts[1]!, 10) || 0,
      currentCommand: parts[2]!,
      currentPath: parts.slice(3).join('\t'),
    });
  }
  return panes;
}

function throwOnError(output: string, fallback: string): string {
  const trimmed = output.trimStart();
  if (trimmed.startsWith('__ERROR__')) {
    const parts = trimmed.split('\t');
    throw new Error(parts.length > 1 ? parts[1]!.split('\n')[0]!.trim() : fallback);
  }
  return output;
}

/**
 * tmux 是 process supervisor 與 reconnect anchor，不是聊天協定（SPEC_V3 §6）。
 * 一律以 #{session_id} 定位；capture-pane 只供 fallback／診斷。
 */
export class TmuxRuntime {
  constructor(
    private readonly exec: RemoteExec,
    private readonly socket = 'default',
  ) {}

  get socketName(): string {
    return this.socket;
  }

  private tmux(): string {
    return this.socket === 'default' ? 'tmux' : `tmux -L ${quoteShellArg(this.socket)}`;
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    const command = `if ! command -v tmux >/dev/null 2>&1; then
  echo "__ERROR__\ttmux is not installed"
  exit 0
fi
${this.tmux()} list-sessions -F '#{session_id}\t#{session_name}\t#{session_created}\t#{session_attached}' 2>/dev/null || true
`;
    const output = await this.exec(command, 8000);
    throwOnError(output, 'tmux list failed');
    return parseListSessions(output).filter((session) =>
      session.name.startsWith(SESSION_PREFIX),
    );
  }

  async listPanes(sessionId: string): Promise<TmuxPaneInfo[]> {
    const command = `${this.tmux()} list-panes -t ${quoteShellArg(sessionId)} -F '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}' 2>/dev/null || true
`;
    return parseListPanes(await this.exec(command, 8000));
  }

  /**
   * 建立 detached session 並回傳真正的 #{session_id}／#{pane_id}
   * （SPEC_V3 §5.3 步驟 2）。command 以 argv 形式傳入，不做字串拼接。
   */
  async newSession(options: {
    name: string;
    cwd: string;
    argv: string[];
  }): Promise<{ sessionId: string; paneId: string; createdEpoch: number }> {
    const session = normalizeSessionName(options.name);
    const shellCommand =
      options.argv.length === 0
        ? 'exec bash'
        : options.argv.map((arg) => quoteShellArg(arg)).join(' ');
    const command = `if ! command -v tmux >/dev/null 2>&1; then
  echo "__ERROR__\ttmux is not installed"
  exit 0
fi
session=${quoteShellArg(session)}
cwd=${quoteShellArg(options.cwd.trim() === '' ? '~' : options.cwd.trim())}
case "$cwd" in
  '~') cwd="$HOME" ;;
  '~/'*) cwd="$HOME/\${cwd#~/}" ;;
esac
if [ ! -d "$cwd" ]; then
  echo "__ERROR__\tWorking directory does not exist: $cwd"
  exit 0
fi
if ${this.tmux()} has-session -t "$session" 2>/dev/null; then
  echo "__ERROR__\tSession already exists: $session"
  exit 0
fi
${this.tmux()} new-session -d -s "$session" -c "$cwd" -P -F '__TMUX__\t#{session_id}\t#{pane_id}\t#{session_created}' ${quoteShellArg(shellCommand)}
`;
    const output = await this.exec(command, 10000);
    throwOnError(output, 'tmux new-session failed');
    for (const line of output.split('\n')) {
      if (line.startsWith('__TMUX__\t')) {
        const parts = line.split('\t');
        if (parts.length >= 4) {
          return {
            sessionId: parts[1]!,
            paneId: parts[2]!,
            createdEpoch: Number.parseInt(parts[3]!, 10) || 0,
          };
        }
      }
    }
    throw new Error(
      output.trim() === '' ? 'tmux new-session returned no status' : output.trim(),
    );
  }

  /** 以 literal 模式送字（-l），避免 tmux 把輸入解讀成 key names（SPEC_V3 §13）。 */
  async sendText(target: string, text: string, pressEnter = true): Promise<void> {
    const command = `if ! ${this.tmux()} has-session -t ${quoteShellArg(target)} 2>/dev/null; then
  echo "__ERROR__\tSession not found: ${target}"
  exit 0
fi
${this.tmux()} send-keys -t ${quoteShellArg(target)} -l -- ${quoteShellArg(text)}
${pressEnter ? `${this.tmux()} send-keys -t ${quoteShellArg(target)} Enter` : 'true'}
printf "__OK__\\n"
`;
    throwOnError(await this.exec(command, 5000), 'tmux send failed');
  }

  /** Terminal fallback／診斷用；不得作為 chat 主資料源（SPEC_V3 §6）。 */
  async capturePane(target: string, lines = 160): Promise<string> {
    const clamped = Math.min(500, Math.max(20, Math.trunc(lines)));
    const command = `if ! ${this.tmux()} has-session -t ${quoteShellArg(target)} 2>/dev/null; then
  echo "__ERROR__\tSession not found: ${target}"
  exit 0
fi
${this.tmux()} capture-pane -p -J -t ${quoteShellArg(target)} -S -${clamped}
`;
    return throwOnError(await this.exec(command, 5000), 'tmux capture failed');
  }

  /**
   * 讀取 tmux 全域 mouse 模式（滾輪捲動 / 滑鼠選取）。
   * 沒有執行中的 server 時退回讀 ~/.tmux.conf 內 CozyPad 管理區塊。
   */
  async getMouseMode(): Promise<boolean> {
    const command = `mode="$(${this.tmux()} show-options -gv mouse 2>/dev/null || true)"
if [ -z "$mode" ]; then
  mode="$(sed -n 's/^set -g mouse \\(on\\|off\\)$/\\1/p' "$HOME/.tmux.conf" 2>/dev/null | tail -n 1)"
fi
printf '__MOUSE__\\t%s\\n' "\${mode:-off}"
`;
    const output = await this.exec(command, 5000);
    return /__MOUSE__\ton/.test(output);
  }

  /**
   * 設定 tmux mouse 模式：立即套用到執行中的 server，並寫入 ~/.tmux.conf
   * 的 CozyPad 管理區塊（冪等；不動使用者其他設定）。
   */
  async setMouseMode(enabled: boolean): Promise<void> {
    const mode = enabled ? 'on' : 'off';
    const command = `mode=${mode}
conf="$HOME/.tmux.conf"
tmp="$(mktemp)" || { echo "__ERROR__\tcannot create temp file"; exit 1; }
if [ -f "$conf" ]; then
  awk 'BEGIN{skip=0}
       /^# >>> cozypad managed >>>$/{skip=1}
       skip==0{print}
       /^# <<< cozypad managed <<<$/{skip=0}' "$conf" > "$tmp"
fi
printf '# >>> cozypad managed >>>\\nset -g mouse %s\\n# <<< cozypad managed <<<\\n' "$mode" >> "$tmp"
mv -- "$tmp" "$conf" || { echo "__ERROR__\tcannot write $conf"; exit 1; }
${this.tmux()} set-option -g mouse "$mode" 2>/dev/null || true
printf '__OK__\\t%s\\n' "$mode"
`;
    const output = await this.exec(command, 8000);
    throwOnError(output, 'failed to set tmux mouse mode');
  }

  async hasSession(target: string): Promise<boolean> {
    const command = `${this.tmux()} has-session -t ${quoteShellArg(target)} 2>/dev/null && echo yes || echo no
`;
    return (await this.exec(command, 5000)).trim().endsWith('yes');
  }

  async killSession(target: string): Promise<void> {
    const command = `if ${this.tmux()} has-session -t ${quoteShellArg(target)} 2>/dev/null; then
  ${this.tmux()} kill-session -t ${quoteShellArg(target)}
fi
printf "__OK__\\n"
`;
    throwOnError(await this.exec(command, 5000), 'tmux kill failed');
  }
}
