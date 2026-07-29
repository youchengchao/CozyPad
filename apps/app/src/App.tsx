import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectionProfile,
  ConnectionState,
  HostKeyPromptEvent,
} from '@cozypad/contracts';
import { getBridge } from './platform/bridge';
import {
  ConnectionManager,
  HostKeyDialog,
  PasswordPrompt,
} from './components/ConnectionManager';
import {
  AgentsIcon,
  FilesIcon,
  MonitorIcon,
  ResearchIcon,
  SettingsIcon,
  TerminalIcon,
} from './components/icons';
import { AgentsWorkspace } from './workspaces/agents/AgentsWorkspace';
import { FilesWorkspace } from './workspaces/FilesWorkspace';
import { MonitorWorkspace } from './workspaces/MonitorWorkspace';
import { ResearchWorkspace } from './workspaces/ResearchWorkspace';
import { SettingsWorkspace } from './workspaces/SettingsWorkspace';
import { TerminalWorkspace } from './workspaces/TerminalWorkspace';

type WorkspaceId = 'agents' | 'research' | 'terminal' | 'files' | 'monitor' | 'settings';

const NAV_ITEMS: { id: WorkspaceId; label: string; icon: () => React.ReactElement }[] = [
  { id: 'agents', label: 'Agents', icon: () => <AgentsIcon /> },
  { id: 'research', label: 'Research', icon: () => <ResearchIcon /> },
  { id: 'terminal', label: 'Terminal', icon: () => <TerminalIcon /> },
  { id: 'files', label: 'Files', icon: () => <FilesIcon /> },
  { id: 'monitor', label: 'Monitor', icon: () => <MonitorIcon /> },
  { id: 'settings', label: 'Settings', icon: () => <SettingsIcon /> },
];

const RECONNECT_DELAYS_MS = [2000, 5000, 10000];

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [workspace, setWorkspace] = useState<WorkspaceId>('agents');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [passwordPrompt, setPasswordPrompt] = useState<ConnectionProfile | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptEvent | null>(null);
  const [mockData, setMockData] = useState(false);
  const [reconnect, setReconnect] = useState<{
    attempt: number;
    secondsLeft: number;
  } | null>(null);

  const manualDisconnect = useRef(true);
  const wasConnected = useRef(false);
  const attempts = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current = [];
  };

  const refreshProfiles = useCallback(async () => {
    const list = await bridge.listProfiles();
    setProfiles(list);
    setSelectedId((current) =>
      current !== null && list.some((profile) => profile.id === current)
        ? current
        : (list[0]?.id ?? null),
    );
  }, [bridge]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => bridge.onHostKeyPrompt(setHostKeyPrompt), [bridge]);

  useEffect(() => {
    void bridge.getAppInfo().then((info) => setMockData(info.mockData));
  }, [bridge]);

  const doConnect = useCallback(
    (profileId: string) => {
      manualDisconnect.current = false;
      setError(null);
      void bridge.connect({ profileId }).catch((err: unknown) => {
        setState('error');
        setError(String(err));
        scheduleRef.current(profileId);
      });
    },
    [bridge],
  );

  const scheduleReconnect = useCallback(
    (profileId: string) => {
      if (manualDisconnect.current) return;
      if (attempts.current >= RECONNECT_DELAYS_MS.length) {
        setReconnect(null);
        setError('自動重連失敗（3 次）——請手動重新連線');
        return;
      }
      const delayMs = RECONNECT_DELAYS_MS[attempts.current]!;
      attempts.current += 1;
      const attempt = attempts.current;
      let secondsLeft = Math.round(delayMs / 1000);
      setReconnect({ attempt, secondsLeft });
      const ticker = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft > 0) setReconnect({ attempt, secondsLeft });
      }, 1000);
      timers.current.push(ticker as unknown as ReturnType<typeof setTimeout>);
      const timer = setTimeout(() => {
        clearInterval(ticker);
        setReconnect(null);
        doConnect(profileId);
      }, delayMs);
      timers.current.push(timer);
    },
    [doConnect],
  );

  const scheduleRef = useRef(scheduleReconnect);
  scheduleRef.current = scheduleReconnect;

  useEffect(() => {
    return bridge.onConnectionState((event) => {
      setState(event.state);
      setError(event.error ?? null);
      if (event.state === 'connected') {
        wasConnected.current = true;
        attempts.current = 0;
        clearTimers();
        setReconnect(null);
      }
      if (
        event.state === 'disconnected' &&
        !manualDisconnect.current &&
        wasConnected.current
      ) {
        scheduleRef.current(event.profileId);
      }
    });
  }, [bridge]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) ?? null;

  const handleConnect = () => {
    if (!selectedProfile) return;
    attempts.current = 0;
    if (selectedProfile.hasPassword !== true && bridge.kind !== 'mock') {
      setPasswordPrompt(selectedProfile);
      return;
    }
    doConnect(selectedProfile.id);
  };

  const handleDisconnect = () => {
    manualDisconnect.current = true;
    wasConnected.current = false;
    clearTimers();
    setReconnect(null);
    if (selectedId !== null) void bridge.disconnect({ profileId: selectedId });
  };

  const submitPassword = async (password: string, remember: boolean) => {
    const profile = passwordPrompt;
    if (!profile) return;
    setPasswordPrompt(null);
    await bridge.saveProfile({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password,
      rememberPassword: remember,
    });
    await refreshProfiles();
    doConnect(profile.id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CozyPad</span>
        <select
          className="profile-select"
          value={selectedId ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={state === 'connected' || state === 'connecting'}
        >
          {profiles.length === 0 ? <option value="">（無連線設定）</option> : null}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button
          className="ghost"
          title="管理連線"
          onClick={() => setManagerOpen(true)}
        >
          ⚙
        </button>
        <span className={`status status-${state}`}>{state}</span>
        <span className={`mode-tag${mockData ? ' mode-mock' : ' mode-ssh'}`}>
          {mockData ? 'MOCK 資料' : 'SSH'}
        </span>
        <span className="spacer" />
        {state === 'connected' ? (
          <button onClick={handleDisconnect}>Disconnect</button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!selectedProfile || state === 'connecting'}
          >
            {state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </header>
      {reconnect ? (
        <div className="reconnect-banner">
          <span>
            連線中斷 — {reconnect.secondsLeft}s 後重試（第 {reconnect.attempt}/
            {RECONNECT_DELAYS_MS.length} 次）
          </span>
          <button
            onClick={() => {
              clearTimers();
              setReconnect(null);
              if (selectedId !== null) doConnect(selectedId);
            }}
          >
            立即重連
          </button>
          <button
            onClick={() => {
              manualDisconnect.current = true;
              clearTimers();
              setReconnect(null);
            }}
          >
            取消
          </button>
        </div>
      ) : null}
      {error !== null && !reconnect ? <div className="error-banner">{error}</div> : null}
      <div className="shell">
        <nav className="nav-rail">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item${workspace === item.id ? ' nav-item-active' : ''}`}
              onClick={() => setWorkspace(item.id)}
              title={item.label}
            >
              {item.icon()}
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <main className="workspace">
          <section className="workspace-page" hidden={workspace !== 'agents'}>
            <AgentsWorkspace mockData={mockData} />
          </section>
          <section className="workspace-page" hidden={workspace !== 'research'}>
            <ResearchWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'terminal'}>
            <TerminalWorkspace
              connected={state === 'connected'}
              profileId={selectedId}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'files'}>
            <FilesWorkspace connected={state === 'connected'} />
          </section>
          <section className="workspace-page" hidden={workspace !== 'monitor'}>
            <MonitorWorkspace
              connected={state === 'connected'}
              host={selectedProfile ? `${selectedProfile.username}@${selectedProfile.host}` : null}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'settings'}>
            <SettingsWorkspace bridgeKind={bridge.kind} />
          </section>
        </main>
      </div>
      {managerOpen ? (
        <ConnectionManager
          profiles={profiles}
          onClose={() => setManagerOpen(false)}
          onChanged={refreshProfiles}
        />
      ) : null}
      {passwordPrompt ? (
        <PasswordPrompt
          profile={passwordPrompt}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={(password, remember) => void submitPassword(password, remember)}
        />
      ) : null}
      {hostKeyPrompt ? (
        <HostKeyDialog
          prompt={hostKeyPrompt}
          onRespond={(accept) => {
            void bridge.respondHostKey({ requestId: hostKeyPrompt.requestId, accept });
            setHostKeyPrompt(null);
          }}
        />
      ) : null}
    </div>
  );
}
