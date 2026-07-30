import { useEffect, useRef, useState } from 'react';
import { TerminalView } from '../components/TerminalView';
import type { TerminalHandle } from '../components/TerminalView';

interface TerminalWorkspaceProps {
  connected: boolean;
  profileId: string | null;
}

const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: '列出檔案', command: 'ls -la' },
  { label: '目前路徑', command: 'pwd' },
  { label: 'Git 狀態', command: 'git status' },
  { label: 'Git 最近提交', command: 'git log --oneline -10' },
  { label: 'GPU 狀態', command: 'nvidia-smi' },
  { label: 'GPU 監看', command: 'watch -n1 nvidia-smi' },
  { label: '記憶體', command: 'free -h' },
  { label: '磁碟用量', command: 'df -h' },
  { label: '系統監控', command: 'htop' },
  { label: 'tmux 列表', command: 'tmux ls' },
  { label: 'tmux 接回', command: 'tmux attach -t ' },
  { label: 'Python 版本', command: 'python -V' },
];

export function TerminalWorkspace({ connected, profileId }: TerminalWorkspaceProps) {
  const [tabs, setTabs] = useState<number[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [quickOpen, setQuickOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const nextId = useRef(1);
  const handles = useRef(new Map<number, TerminalHandle>());

  const addTab = () => {
    const id = nextId.current++;
    setTabs((current) => [...current, id]);
    setActive(id);
  };

  const closeTab = (id: number) => {
    handles.current.delete(id);
    setTabs((current) => {
      const remaining = current.filter((tab) => tab !== id);
      setActive((activeId) =>
        activeId === id ? (remaining[remaining.length - 1] ?? null) : activeId,
      );
      return remaining;
    });
  };

  useEffect(() => {
    if (!connected) {
      handles.current.clear();
      setTabs([]);
      setActive(null);
    }
  }, [connected]);

  const runQuick = (command: string, execute: boolean) => {
    const handle = active !== null ? handles.current.get(active) : undefined;
    if (!handle) return;
    if (execute) handle.run(command);
    else handle.paste(command);
    handle.focus();
  };

  if (!connected || !profileId) {
    return (
      <div className="placeholder">
        <p>Connect to open terminals.</p>
        <p className="hint">終端機分頁會在斷線時一併關閉。</p>
      </div>
    );
  }

  return (
    <div className="terminal-workspace">
      <div className="tab-bar">
        {tabs.map((id, index) => (
          <div
            key={id}
            className={`tab${active === id ? ' tab-active' : ''}`}
            onClick={() => setActive(id)}
          >
            <span>Terminal {index + 1}</span>
            <button
              className="tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-add" onClick={addTab} title="New terminal">
          ＋
        </button>
        <span className="spacer" />
        <span className="hint terminal-hint">右鍵：有選取＝複製、無選取＝貼上</span>
        <button
          className={`tab-quick-toggle${quickOpen ? ' tab-quick-toggle-on' : ''}`}
          onClick={() => setQuickOpen((open) => !open)}
          title="常用指令面板"
        >
          ⚡ 常用指令
        </button>
      </div>
      <div className="terminal-body">
        <div className="terminal-panes">
          {tabs.length === 0 ? (
            <div className="placeholder">
              <p>No terminals open.</p>
              <p className="hint">按上方 ＋ 開新分頁。</p>
            </div>
          ) : null}
          {tabs.map((id) => (
            <div key={id} className="terminal-pane" hidden={active !== id}>
              <TerminalView
                profileId={profileId}
                // 遠端 session 結束（exit、tmux kill-session、process 死亡）時
                // 本地分頁一併關閉，不留下空殼。
                onExit={() => closeTab(id)}
                onNotify={(message) => {
                  setToast(message);
                  setTimeout(() => setToast(null), 1600);
                }}
                onHandle={(handle) => {
                  if (handle) handles.current.set(id, handle);
                  else handles.current.delete(id);
                }}
              />
            </div>
          ))}
        </div>
        {quickOpen && tabs.length > 0 ? (
          <aside className="quick-commands">
            <div className="quick-head hint">點擊＝貼上 · ▶＝執行</div>
            {QUICK_COMMANDS.map((entry) => (
              <div key={entry.command} className="quick-row">
                <button
                  className="quick-paste"
                  title={entry.command}
                  onClick={() => runQuick(entry.command, false)}
                >
                  <span className="quick-label">{entry.label}</span>
                  <span className="quick-cmd mono">{entry.command}</span>
                </button>
                <button
                  className="quick-run"
                  title={`執行 ${entry.command}`}
                  onClick={() => runQuick(entry.command, true)}
                >
                  ▶
                </button>
              </div>
            ))}
          </aside>
        ) : null}
      </div>
      {toast !== null ? <div className="terminal-toast">{toast}</div> : null}
    </div>
  );
}
