import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectionProfile,
  ConnectionState,
  HostKeyPromptEvent,
  TmuxStatus,
} from '@cozypad/contracts';
import { getBridge } from './platform/bridge';
import {
  ConnectionManager,
  CredentialPrompt,
  HostKeyDialog,
} from './components/ConnectionManager';
import type { CredentialSubmission } from './components/ConnectionManager';
import {
  AgentsIcon,
  FilesIcon,
  MonitorIcon,
  ResearchIcon,
  SettingsIcon,
  TerminalIcon,
} from './components/icons';
import { TmuxSetupDialog } from './components/TmuxSetupDialog';
import { AgentsWorkspace } from './workspaces/agents/AgentsWorkspace';
import { FilesWorkspace } from './workspaces/FilesWorkspace';
import { MonitorWorkspace } from './workspaces/MonitorWorkspace';
import { ResearchWorkspace } from './workspaces/ResearchWorkspace';
import { SettingsWorkspace } from './workspaces/SettingsWorkspace';
import { TerminalWorkspace } from './workspaces/TerminalWorkspace';
import { reconnectDelayMs } from './reconnectPolicy';

type WorkspaceId = 'agents' | 'research' | 'terminal' | 'files' | 'monitor' | 'settings';

const NAV_ITEMS: { id: WorkspaceId; label: string; icon: () => React.ReactElement }[] = [
  { id: 'agents', label: 'Agents', icon: () => <AgentsIcon /> },
  { id: 'research', label: 'Research', icon: () => <ResearchIcon /> },
  { id: 'terminal', label: 'Terminal', icon: () => <TerminalIcon /> },
  { id: 'files', label: 'Files', icon: () => <FilesIcon /> },
  { id: 'monitor', label: 'Monitor', icon: () => <MonitorIcon /> },
  { id: 'settings', label: 'Settings', icon: () => <SettingsIcon /> },
];

const INITIAL_CONNECT_MAX_ATTEMPTS = 3;

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [workspace, setWorkspace] = useState<WorkspaceId>('agents');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  /** Which host is actually in use, as opposed to which one is highlighted. */
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [credentialPrompt, setCredentialPrompt] = useState<ConnectionProfile | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptEvent | null>(null);
  const [startupWarnings, setStartupWarnings] = useState<string[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null);
  const [tmuxPromptDismissed, setTmuxPromptDismissed] = useState(false);
  const [reconnect, setReconnect] = useState<{
    attempt: number;
    secondsLeft: number;
  } | null>(null);

  const manualDisconnect = useRef(true);
  const wasConnected = useRef(false);
  const attempts = useRef(0);
  const connectInFlight = useRef(false);
  const reconnectScheduled = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTicker = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    if (reconnectTicker.current !== null) clearInterval(reconnectTicker.current);
    reconnectTimer.current = null;
    reconnectTicker.current = null;
    reconnectScheduled.current = false;
  }, []);

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
    void bridge.getAppInfo().then((info) => {
      setStartupWarnings(info.startupWarnings ?? []);
    });
  }, [bridge]);

  useEffect(
    () =>
      bridge.onTmuxStatus((status) => {
        setTmuxStatus(status);
        if (status.installed && status.satisfiesTarget) setTmuxPromptDismissed(false);
      }),
    [bridge],
  );

  const doConnect = useCallback(
    (profileId: string) => {
      if (connectInFlight.current) return;
      connectInFlight.current = true;
      manualDisconnect.current = false;
      setError(null);
      // tmux 狀態屬於單一主機。留著上一台的狀態，換到本機（不需要 tmux、
      // 也不會再送新狀態）時會拿舊主機的「未安裝」重新彈出安裝對話框。
      setTmuxStatus(null);
      setTmuxPromptDismissed(false);
      void bridge
        .connect({ profileId })
        .then(() => {
          connectInFlight.current = false;
        })
        .catch((err: unknown) => {
          connectInFlight.current = false;
          setState('error');
          setError(String(err));
          scheduleRef.current(profileId);
        });
    },
    [bridge],
  );

  const scheduleReconnect = useCallback(
    (profileId: string) => {
      if (manualDisconnect.current || reconnectScheduled.current || connectInFlight.current) return;
      if (!wasConnected.current && attempts.current >= INITIAL_CONNECT_MAX_ATTEMPTS) {
        setReconnect(null);
        setError('自動重連失敗（3 次）——請手動重新連線');
        return;
      }
      reconnectScheduled.current = true;
      const delayMs = reconnectDelayMs(attempts.current);
      attempts.current += 1;
      const attempt = attempts.current;
      let secondsLeft = Math.round(delayMs / 1000);
      setReconnect({ attempt, secondsLeft });
      const ticker = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft > 0) setReconnect({ attempt, secondsLeft });
      }, 1000);
      reconnectTicker.current = ticker;
      const timer = setTimeout(() => {
        clearInterval(ticker);
        reconnectTicker.current = null;
        reconnectTimer.current = null;
        reconnectScheduled.current = false;
        setReconnect(null);
        doConnect(profileId);
      }, delayMs);
      reconnectTimer.current = timer;
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
        connectInFlight.current = false;
        wasConnected.current = true;
        attempts.current = 0;
        setConnectedId(event.profileId);
        clearTimers();
        setReconnect(null);
      }
      if (event.state === 'disconnected') {
        setConnectedId((current) =>
          current === event.profileId ? null : current,
        );
      }
      if (event.state === 'error') {
        connectInFlight.current = false;
        if (!manualDisconnect.current && wasConnected.current) {
          scheduleRef.current(event.profileId);
        }
      }
      if (
        event.state === 'disconnected' &&
        !manualDisconnect.current &&
        wasConnected.current
      ) {
        scheduleRef.current(event.profileId);
      }
    });
  }, [bridge, clearTimers]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) ?? null;
  const connectedProfile =
    profiles.find((profile) => profile.id === connectedId) ?? selectedProfile;

  const handleConnect = () => {
    if (!selectedProfile) return;
    attempts.current = 0;
    // The local machine has nothing to authenticate against — asking for a
    // password there would be asking the user to unlock their own computer.
    const hasCredential =
      selectedProfile.isLocal === true ||
      ((selectedProfile.authMethod ?? 'password') === 'privateKey'
        ? selectedProfile.hasPrivateKey === true
        : selectedProfile.hasPassword === true);
    if (!hasCredential) {
      setCredentialPrompt(selectedProfile);
      return;
    }
    // Switching hosts: drop the current one first so the old connection is not
    // left running behind the new one.
    if (connectedId !== null && connectedId !== selectedProfile.id) {
      clearTimers();
      setReconnect(null);
      void bridge.disconnect({ profileId: connectedId });
    }
    doConnect(selectedProfile.id);
  };

  const handleDisconnect = () => {
    manualDisconnect.current = true;
    wasConnected.current = false;
    connectInFlight.current = false;
    clearTimers();
    setReconnect(null);
    if (selectedId !== null) void bridge.disconnect({ profileId: selectedId });
  };

  const submitCredential = async (credential: CredentialSubmission) => {
    const profile = credentialPrompt;
    if (!profile) return;
    setCredentialPrompt(null);
    try {
      await bridge.saveProfile({
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        ...credential,
      });
      await refreshProfiles();
      doConnect(profile.id);
    } catch (credentialError) {
      setState('error');
      setError(
        credentialError instanceof Error
          ? credentialError.message
          : String(credentialError),
      );
    }
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
        <span
          className={`mode-tag${
            connectedProfile?.isLocal === true ? ' mode-local' : ' mode-ssh'
          }`}
        >
          {connectedProfile?.isLocal === true ? 'LOCAL' : 'SSH'}
        </span>
        <span className="spacer" />
        {/*
          Being connected to one host must never hide the way to reach another.
          Picking a different host from the list turns this into the action that
          switches to it; Disconnect only applies to the host in use.
        */}
        {state === 'connected' && selectedId === connectedId ? (
          <button onClick={handleDisconnect}>Disconnect</button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!selectedProfile || state === 'connecting'}
          >
            {state === 'connecting'
              ? 'Connecting…'
              : state === 'connected'
                ? '切換到這台'
                : 'Connect'}
          </button>
        )}
      </header>
      {reconnect ? (
        <div className="reconnect-banner">
          <span>
            連線中斷 — {reconnect.secondsLeft}s 後重試（第 {reconnect.attempt} 次）
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
      {startupWarnings.map((warning) => (
        <div className="startup-warning-banner" role="alert" key={warning}>
          <strong>本機設定載入異常</strong>
          <span>{warning}</span>
          <button
            className="ghost"
            onClick={() =>
              setStartupWarnings((current) =>
                current.filter((entry) => entry !== warning),
              )
            }
          >
            知道了
          </button>
        </div>
      ))}
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
            <AgentsWorkspace
              connected={state === 'connected'}
              connectionState={state}
              reconnect={reconnect}
              profileId={selectedId}
            />
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
            <SettingsWorkspace
              bridgeKind={bridge.kind}
              connected={state === 'connected'}
            />
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
      {credentialPrompt ? (
        <CredentialPrompt
          profile={credentialPrompt}
          onCancel={() => setCredentialPrompt(null)}
          onSubmit={(credential) => void submitCredential(credential)}
        />
      ) : null}
      {tmuxStatus !== null &&
      !tmuxPromptDismissed &&
      state === 'connected' &&
      !(tmuxStatus.installed && tmuxStatus.satisfiesTarget) ? (
        <TmuxSetupDialog
          status={tmuxStatus}
          onDismiss={() => setTmuxPromptDismissed(true)}
          onInstalled={(status) => {
            setTmuxStatus(status);
            setTmuxPromptDismissed(true);
          }}
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
