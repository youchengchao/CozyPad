import { useEffect, useMemo, useState } from 'react';
import type { ConnectionProfile, ConnectionState } from '@cozypad/contracts';
import { getBridge } from './platform/bridge';
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

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [workspace, setWorkspace] = useState<WorkspaceId>('agents');
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge.listProfiles().then((profiles) => setProfile(profiles[0] ?? null));
    return bridge.onConnectionState((event) => {
      setState(event.state);
      setError(event.error ?? null);
    });
  }, [bridge]);

  const connect = () => {
    if (!profile) return;
    void bridge.connect({ profileId: profile.id }).catch((err: unknown) => {
      setState('error');
      setError(String(err));
    });
  };

  const disconnect = () => {
    if (!profile) return;
    void bridge.disconnect({ profileId: profile.id });
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CozyPad</span>
        <span className="profile">
          {profile ? `${profile.username}@${profile.host}:${profile.port}` : 'no profile'}
        </span>
        <span className={`status status-${state}`}>{state}</span>
        <span className="bridge-kind">bridge: {bridge.kind}</span>
        <span className="spacer" />
        {state === 'connected' ? (
          <button onClick={disconnect}>Disconnect</button>
        ) : (
          <button onClick={connect} disabled={!profile || state === 'connecting'}>
            {state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
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
            <AgentsWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'research'}>
            <ResearchWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'terminal'}>
            <TerminalWorkspace connected={state === 'connected'} profileId={profile?.id ?? null} />
          </section>
          <section className="workspace-page" hidden={workspace !== 'files'}>
            <FilesWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'monitor'}>
            <MonitorWorkspace />
          </section>
          <section className="workspace-page" hidden={workspace !== 'settings'}>
            <SettingsWorkspace bridgeKind={bridge.kind} />
          </section>
        </main>
      </div>
    </div>
  );
}
