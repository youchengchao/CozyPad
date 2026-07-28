import { useMemo, useState } from 'react';
import type {
  AgentKind,
  AgentSessionStatus,
  AgentSessionSummary,
  ChatItem,
} from '@cozypad/contracts';
import {
  mockAgentInstallState,
  mockAgentSessions,
  mockAgentTimelines,
} from '@cozypad/test-fixtures';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';

const AGENTS: { kind: AgentKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'agy', label: 'agy' },
];

const STATUS_LABEL: Record<AgentSessionStatus, string> = {
  starting: 'starting',
  ready: 'ready',
  running: 'running',
  waiting_approval: 'approval',
  disconnected: 'offline',
  exited: 'exited',
  error: 'error',
};

const MOCK_REPLIES: Record<AgentKind, string> = {
  claude:
    '（mock 回覆）收到。這裡還沒接上真正的 Claude adapter——Phase 2 會用 stream-json 事件取代這段假字。',
  codex:
    '（mock 回覆）了解。Codex adapter 會在 Phase 3 以 app-server / JSONL exec 接上。',
  agy: '（mock 回覆）agy adapter 尚未定義 protocol。',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function AgentsWorkspace() {
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>(mockAgentSessions);
  const [timelines, setTimelines] =
    useState<Record<string, ChatItem[]>>(mockAgentTimelines);
  const [selected, setSelected] = useState<Record<AgentKind, string | null>>({
    claude: 'claude-s1',
    codex: 'codex-s1',
    agy: null,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<Record<AgentKind, string>>({
    claude: '',
    codex: '',
    agy: '',
  });
  const [nextItemId, setNextItemId] = useState(1);

  const agentSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.agentKind === agent)
        .filter((session) =>
          filters[agent] === ''
            ? true
            : `${session.title} ${session.host} ${session.project}`
                .toLowerCase()
                .includes(filters[agent].toLowerCase()),
        ),
    [sessions, agent, filters],
  );

  const selectedSessionId = selected[agent];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const timeline = selectedSessionId ? (timelines[selectedSessionId] ?? []) : [];

  const badge = (kind: AgentKind) => {
    const mine = sessions.filter((session) => session.agentKind === kind);
    const waiting = mine.some((session) => session.status === 'waiting_approval');
    const running = mine.some((session) => session.status === 'running');
    const unread = mine.reduce((sum, session) => sum + session.unread, 0);
    return { waiting, running, unread };
  };

  const selectSession = (sessionId: string) => {
    setSelected((current) => ({ ...current, [agent]: sessionId }));
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, unread: 0 } : session,
      ),
    );
  };

  const appendItems = (sessionId: string, items: ChatItem[]) => {
    setTimelines((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), ...items],
    }));
  };

  const sendMessage = (text: string) => {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    const now = new Date().toISOString();
    const userId = `local-${nextItemId}`;
    const assistantId = `local-${nextItemId + 1}`;
    setNextItemId((current) => current + 2);
    appendItems(sessionId, [
      { kind: 'message', id: userId, role: 'user', text, timestamp: now },
      {
        kind: 'message',
        id: assistantId,
        role: 'assistant',
        text: '',
        streaming: true,
        timestamp: now,
      },
    ]);
    setDrafts((current) => ({ ...current, [sessionId]: '' }));

    const reply = MOCK_REPLIES[agent];
    let cursor = 0;
    const interval = setInterval(() => {
      cursor = Math.min(cursor + 3, reply.length);
      const done = cursor >= reply.length;
      setTimelines((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).map((item) =>
          item.id === assistantId && item.kind === 'message'
            ? { ...item, text: reply.slice(0, cursor), streaming: !done }
            : item,
        ),
      }));
      if (done) clearInterval(interval);
    }, 30);
  };

  const resolveApproval = (itemId: string, resolution: 'allowed' | 'denied') => {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    setTimelines((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) =>
        item.id === itemId && item.kind === 'approval' ? { ...item, resolution } : item,
      ),
    }));
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, status: resolution === 'allowed' ? 'running' : 'ready' }
          : session,
      ),
    );
  };

  const diffPaths = timeline
    .filter((item): item is Extract<ChatItem, { kind: 'file_diff' }> => item.kind === 'file_diff')
    .map((item) => item.path);
  const usage = timeline
    .filter((item): item is Extract<ChatItem, { kind: 'usage' }> => item.kind === 'usage')
    .reduce(
      (sum, item) => ({
        input: sum.input + item.inputTokens,
        output: sum.output + item.outputTokens,
      }),
      { input: 0, output: 0 },
    );

  return (
    <div className="agents-workspace">
      <div className="agent-tabs">
        {AGENTS.map(({ kind, label }) => {
          const info = badge(kind);
          return (
            <button
              key={kind}
              className={`agent-tab${agent === kind ? ' agent-tab-active' : ''}`}
              onClick={() => setAgent(kind)}
            >
              {label}
              {info.waiting ? <span className="dot dot-approval" title="waiting approval" /> : null}
              {info.running ? <span className="dot dot-running" title="running" /> : null}
              {info.unread > 0 ? <span className="unread">{info.unread}</span> : null}
            </button>
          );
        })}
        <button className="agent-tab agent-tab-disabled" title="Custom adapters：Phase 5 adapter SDK">
          ＋
        </button>
      </div>

      {mockAgentInstallState[agent] === 'not_detected' ? (
        <div className="agent-setup">
          <h2>agy 尚未偵測到</h2>
          <p>遠端主機上找不到 agy 可執行檔。安裝後 CozyPad 會自動偵測版本與能力。</p>
          <p className="hint">
            在 adapter 完成 structured protocol 之前，agy 只提供 Terminal degraded
            mode（SPEC_V3 7.5）。
          </p>
        </div>
      ) : (
        <div className="agent-panes">
          <aside className="session-sidebar">
            <input
              className="session-filter"
              placeholder="搜尋 sessions…"
              value={filters[agent]}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [agent]: event.target.value }))
              }
            />
            <div className="session-list">
              {agentSessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item${
                    session.id === selectedSessionId ? ' session-item-active' : ''
                  }`}
                  onClick={() => selectSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {session.host} · {session.project}
                  </span>
                  <span className="session-footer">
                    <span className={`chip chip-${session.status}`}>
                      {STATUS_LABEL[session.status]}
                    </span>
                    {session.unread > 0 ? (
                      <span className="unread">{session.unread}</span>
                    ) : null}
                    <span className="session-time">{formatTime(session.updatedAt)}</span>
                  </span>
                </button>
              ))}
              {agentSessions.length === 0 ? (
                <p className="hint session-empty">沒有符合的 session。</p>
              ) : null}
            </div>
            <button className="session-new" title="Phase 2：由 adapter 啟動真實 session">
              ＋ New session（mock）
            </button>
          </aside>

          <div className="chat-column">
            {selectedSession ? (
              <>
                <ChatTimeline
                  sessionId={selectedSession.id}
                  items={timeline}
                  onResolveApproval={resolveApproval}
                />
                <ChatComposer
                  agentLabel={AGENTS.find((entry) => entry.kind === agent)?.label ?? agent}
                  value={drafts[selectedSession.id] ?? ''}
                  onChange={(value) =>
                    setDrafts((current) => ({ ...current, [selectedSession.id]: value }))
                  }
                  onSend={sendMessage}
                />
              </>
            ) : (
              <div className="placeholder">
                <p>選一個 session 開始。</p>
              </div>
            )}
          </div>

          <aside className="context-panel">
            {selectedSession ? (
              <>
                <h3>Context</h3>
                <dl>
                  <dt>Host</dt>
                  <dd>{selectedSession.host}</dd>
                  <dt>Project</dt>
                  <dd>{selectedSession.project}</dd>
                  <dt>cwd</dt>
                  <dd className="mono">{selectedSession.cwd}</dd>
                  <dt>Status</dt>
                  <dd>
                    <span className={`chip chip-${selectedSession.status}`}>
                      {STATUS_LABEL[selectedSession.status]}
                    </span>
                  </dd>
                  <dt>tmux</dt>
                  <dd className="mono">sdh_{selectedSession.id.replace('-', '_')}</dd>
                </dl>
                <h3>Changed files</h3>
                {diffPaths.length > 0 ? (
                  <ul className="changed-files">
                    {diffPaths.map((path) => (
                      <li key={path} className="mono">
                        {path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">尚無變更。</p>
                )}
                <h3>Usage</h3>
                {usage.input + usage.output > 0 ? (
                  <p className="hint">
                    in {usage.input.toLocaleString()} / out {usage.output.toLocaleString()}{' '}
                    tokens
                  </p>
                ) : (
                  <p className="hint">此對話尚無 usage 事件。</p>
                )}
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
