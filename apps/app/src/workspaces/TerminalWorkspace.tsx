import { useEffect, useRef, useState } from 'react';
import { TerminalView } from '../components/TerminalView';

interface TerminalWorkspaceProps {
  connected: boolean;
  profileId: string | null;
}

export function TerminalWorkspace({ connected, profileId }: TerminalWorkspaceProps) {
  const [tabs, setTabs] = useState<number[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const nextId = useRef(1);

  const addTab = () => {
    const id = nextId.current++;
    setTabs((current) => [...current, id]);
    setActive(id);
  };

  const closeTab = (id: number) => {
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
      setTabs([]);
      setActive(null);
    }
  }, [connected]);

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
      </div>
      <div className="terminal-panes">
        {tabs.length === 0 ? (
          <div className="placeholder">
            <p>No terminals open.</p>
            <p className="hint">按上方 ＋ 開新分頁。</p>
          </div>
        ) : null}
        {tabs.map((id) => (
          <div key={id} className="terminal-pane" hidden={active !== id}>
            <TerminalView profileId={profileId} />
          </div>
        ))}
      </div>
    </div>
  );
}
