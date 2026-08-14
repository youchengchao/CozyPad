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
import { AppTitleBar } from './components/AppTitleBar';
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
import {
  isRetryableConnectError,
  reconnectDelayMs,
} from './reconnectPolicy';

type WorkspaceId = 'agents' | 'research' | 'terminal' | 'files' | 'monitor' | 'settings';

const WORKSPACE_CWDS_STORAGE_KEY = 'cozypad-workspace-cwds-v1';

const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  disconnected: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Connection error',
};

function workspaceHostKey(profile: ConnectionProfile | null): string | null {
  if (profile === null) return null;
  return profile.isLocal === true
    ? 'local'
    : `ssh:${profile.username}@${profile.host.toLowerCase()}:${profile.port}`;
}

function loadWorkspaceCwds(): {
  values: Record<string, string>;
  warning: string | null;
} {
  if (typeof window === 'undefined') return { values: {}, warning: null };
  try {
    const raw = window.localStorage.getItem(WORKSPACE_CWDS_STORAGE_KEY);
    if (raw === null) return { values: {}, warning: null };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        values: {},
        warning: 'Workspace PWD settings were invalid and were reset.',
      };
    }
    const entries = Object.entries(parsed);
    const valid = entries.filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== '',
    );
    return {
      values: Object.fromEntries(valid),
      warning:
        valid.length === entries.length
          ? null
          : 'Some invalid Workspace PWD settings were ignored.',
    };
  } catch {
    return {
      values: {},
      warning: 'Workspace PWD settings could not be read and were reset.',
    };
  }
}

const NAV_ITEMS: { id: WorkspaceId; label: string; icon: () => React.ReactElement }[] = [
  { id: 'agents', label: 'Agents', icon: () => <AgentsIcon /> },
  { id: 'research', label: 'Research', icon: () => <ResearchIcon /> },
  { id: 'terminal', label: 'Terminal', icon: () => <TerminalIcon /> },
  { id: 'files', label: 'Files', icon: () => <FilesIcon /> },
  { id: 'monitor', label: 'Monitor', icon: () => <MonitorIcon /> },
  { id: 'settings', label: 'Settings', icon: () => <SettingsIcon /> },
];

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const initialWorkspaceCwds = useMemo(loadWorkspaceCwds, []);
  const [workspace, setWorkspace] = useState<WorkspaceId>('agents');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [switching, setSwitching] = useState(false);
  /** Which host is actually in use, as opposed to which one is highlighted. */
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [credentialPrompt, setCredentialPrompt] = useState<ConnectionProfile | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptEvent | null>(null);
  const [hostKeyResponding, setHostKeyResponding] = useState(false);
  const [hostKeyResponseError, setHostKeyResponseError] = useState<string | null>(null);
  const [startupWarnings, setStartupWarnings] = useState<string[]>(
    initialWorkspaceCwds.warning === null
      ? []
      : [initialWorkspaceCwds.warning],
  );
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null);
  const [tmuxPromptDismissed, setTmuxPromptDismissed] = useState(false);
  const [reconnect, setReconnect] = useState<{
    attempt: number;
    secondsLeft: number;
  } | null>(null);
  const [workspaceCwds, setWorkspaceCwds] = useState(
    initialWorkspaceCwds.values,
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORKSPACE_CWDS_STORAGE_KEY,
        JSON.stringify(workspaceCwds),
      );
    } catch {
      setStartupWarnings((current) =>
        current.includes('Workspace PWD could not be saved on this device.')
          ? current
          : [...current, 'Workspace PWD could not be saved on this device.'],
      );
    }
  }, [workspaceCwds]);

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

  useEffect(
    () =>
      bridge.onHostKeyPrompt((prompt) => {
        setHostKeyPrompt(prompt);
        setHostKeyResponding(false);
        setHostKeyResponseError(null);
      }),
    [bridge],
  );


  useEffect(() => {
    const handleOpenFile = () => {
      setWorkspace('files');
    };
    window.addEventListener('cozypad:open-file', handleOpenFile);
    return () => {
      window.removeEventListener('cozypad:open-file', handleOpenFile);
    };
  }, []);

  useEffect(() => {
    void bridge.getAppInfo().then((info) => {
      setStartupWarnings((current) => [
        ...new Set([...(info.startupWarnings ?? []), ...current]),
      ]);
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
          setError(err instanceof Error ? err.message : String(err));
          const retryable = isRetryableConnectError(err);
          if (!retryable) manualDisconnect.current = true;
          if (wasConnected.current && retryable) {
            scheduleRef.current(profileId);
          }
        });
    },
    [bridge],
  );

  const scheduleReconnect = useCallback(
    (profileId: string) => {
      if (manualDisconnect.current || reconnectScheduled.current || connectInFlight.current) return;
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
        setSwitching(false);
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
        const retryable = isRetryableConnectError(event.error ?? '');
        if (!retryable) manualDisconnect.current = true;
        if (
          !manualDisconnect.current &&
          wasConnected.current &&
          retryable
        ) {
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
    profiles.find((profile) => profile.id === connectedId) ?? null;
  const statusProfile =
    connectedProfile ??
    (state === 'connecting' || state === 'error' ? selectedProfile : null);
  const connectedHostKey = workspaceHostKey(
    connectedId === null ? null : connectedProfile,
  );
  const workspaceCwd =
    connectedHostKey === null ? null : (workspaceCwds[connectedHostKey] ?? null);
  const setWorkspaceCwd = useCallback(
    (cwd: string) => {
      if (connectedHostKey === null || cwd.trim() === '') return;
      setWorkspaceCwds((current) => ({
        ...current,
        [connectedHostKey]: cwd,
      }));
    },
    [connectedHostKey],
  );

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
      manualDisconnect.current = true;
      wasConnected.current = false;
      connectInFlight.current = true;
      setSwitching(true);
      const previousProfileId = connectedId;
      void bridge
        .disconnect({ profileId: previousProfileId })
        .then(() => {
          connectInFlight.current = false;
          doConnect(selectedProfile.id);
        })
        .catch((switchError: unknown) => {
          connectInFlight.current = false;
          setSwitching(false);
          setState('error');
          setError(
            switchError instanceof Error
              ? switchError.message
              : String(switchError),
          );
        });
      return;
    }
    doConnect(selectedProfile.id);
  };

  const handleDisconnect = () => {
    const profileId = connectedId ?? selectedId;
    manualDisconnect.current = true;
    wasConnected.current = false;
    connectInFlight.current = false;
    setSwitching(false);
    clearTimers();
    setReconnect(null);
    setHostKeyPrompt(null);
    setHostKeyResponding(false);
    setHostKeyResponseError(null);
    if (profileId !== null) {
      void bridge.disconnect({ profileId }).catch((disconnectError: unknown) => {
        setState('error');
        setError(
          disconnectError instanceof Error
            ? disconnectError.message
            : String(disconnectError),
        );
      });
    }
  };

  const respondToHostKey = async (accept: boolean): Promise<void> => {
    const prompt = hostKeyPrompt;
    if (prompt === null || hostKeyResponding) return;
    setHostKeyResponding(true);
    setHostKeyResponseError(null);
    try {
      await bridge.respondHostKey({ requestId: prompt.requestId, accept });
      setHostKeyPrompt(null);
    } catch (responseError) {
      setHostKeyResponseError(
        responseError instanceof Error
          ? responseError.message
          : String(responseError),
      );
    } finally {
      setHostKeyResponding(false);
    }
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
      <AppTitleBar bridge={bridge} />
      <header className="topbar">
        <select
          className="profile-select"
          aria-label="Connection target"
          value={selectedId ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={state === 'connecting' || switching}
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
        <div
          className={`connection-status connection-status-${state}`}
          role="status"
          aria-live="polite"
          aria-label={`${CONNECTION_STATE_LABEL[state]}${
            statusProfile === null ? '' : `: ${statusProfile.name}`
          }`}
        >
          <span className="connection-status-dot" aria-hidden="true" />
          <strong>{CONNECTION_STATE_LABEL[state]}</strong>
          {statusProfile !== null ? (
            <>
              <span className="connection-status-separator" aria-hidden="true">/</span>
              <span className="connection-status-target">{statusProfile.name}</span>
              <span className="connection-status-transport">
                {statusProfile.isLocal === true
                  ? 'local'
                  : `SSH · ${statusProfile.username}@${statusProfile.host}:${statusProfile.port}`}
              </span>
            </>
          ) : null}
        </div>
        <span className="spacer" />
        {/*
          Being connected to one host must never hide the way to reach another.
          Picking a different host from the list turns this into the action that
          switches to it; Disconnect only applies to the host in use.
        */}
        {switching ? (
          <button disabled>Switching…</button>
        ) : state === 'connecting' ? (
          <button onClick={handleDisconnect}>Cancel</button>
        ) : state === 'connected' && selectedId === connectedId ? (
          <button onClick={handleDisconnect}>Disconnect</button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!selectedProfile}
          >
            {state === 'connected'
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
          <button onClick={handleDisconnect}>
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
              profileId={connectedId}
              workspaceCwd={workspaceCwd}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'research'}>
            <ResearchWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'terminal'}>
            <TerminalWorkspace
              connected={state === 'connected'}
              profileId={connectedId}
              workspaceCwd={workspaceCwd}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'files'}>
            <FilesWorkspace
              connected={state === 'connected'}
              profileId={connectedId}
              workspaceCwd={workspaceCwd}
              onWorkspaceCwdChange={setWorkspaceCwd}
            />
          </section>
          <section className="workspace-page" hidden={workspace !== 'monitor'}>
            <MonitorWorkspace
              connected={state === 'connected'}
              host={connectedProfile ? `${connectedProfile.username}@${connectedProfile.host}` : null}
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
          responding={hostKeyResponding}
          error={hostKeyResponseError}
          onRespond={(accept) => void respondToHostKey(accept)}
        />
      ) : null}
    </div>
  );
}
