import { useEffect, useMemo, useState } from 'react';
import type { ConnectionProfile, ConnectionState } from '@cozypad/contracts';
import { getBridge } from './platform/bridge';
import { TerminalView } from './components/TerminalView';

export function App() {
  const bridge = useMemo(() => getBridge(), []);
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
      <main className="workspace">
        {state === 'connected' && profile ? (
          <TerminalView profileId={profile.id} />
        ) : (
          <div className="placeholder">
            <p>Connect to open a terminal.</p>
            <p className="hint">
              {bridge.kind === 'mock'
                ? 'Browser mock mode — no Electron, no real host required.'
                : 'Running inside the desktop shell.'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
