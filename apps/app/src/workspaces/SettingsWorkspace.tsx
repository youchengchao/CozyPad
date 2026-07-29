import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RemoteSettings } from '@cozypad/contracts';
import { PROTOCOL_VERSION } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface SettingsWorkspaceProps {
  bridgeKind: string;
  mockData: boolean;
  connected: boolean;
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className={`switch${disabled ? ' switch-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

export function SettingsWorkspace({
  bridgeKind,
  mockData,
  connected,
}: SettingsWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const canSimulateDrop = 'simulateDrop' in bridge;
  const [remote, setRemote] = useState<RemoteSettings | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRemote = useCallback(() => {
    setRemoteError(null);
    bridge
      .getRemoteSettings()
      .then(setRemote)
      .catch((err: unknown) => setRemoteError(err instanceof Error ? err.message : String(err)));
  }, [bridge]);

  useEffect(() => {
    if (connected) loadRemote();
    else setRemote(null);
  }, [connected, loadRemote]);

  const patchRemote = (patch: Partial<RemoteSettings>) => {
    setBusy(true);
    setRemoteError(null);
    bridge
      .setRemoteSettings(patch)
      .then(setRemote)
      .catch((err: unknown) => setRemoteError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-workspace">
      <div className="card">
        <h3>遠端設定（套用在主機上）</h3>
        <p className="hint settings-note">
          這些設定寫入遠端主機，換一台電腦連同一台主機也會生效。
        </p>
        {!connected ? (
          <p className="hint">連線後才能讀取／修改遠端設定。</p>
        ) : remoteError !== null ? (
          <div className="error-banner">{remoteError}</div>
        ) : remote === null ? (
          <p className="hint">讀取中…</p>
        ) : (
          <>
            <div className="settings-row">
              <span>
                tmux 滑鼠模式
                <span className="hint settings-sub">
                  滾輪捲動 pane 歷史、滑鼠選取與切換 pane；寫入 ~/.tmux.conf 並立即套用
                </span>
              </span>
              <Toggle
                checked={remote.tmuxMouseMode}
                disabled={busy}
                onChange={(value) => patchRemote({ tmuxMouseMode: value })}
              />
            </div>
            <div className="settings-row">
              <span>
                tmux socket
                <span className="hint settings-sub">
                  所有 agent conversation session 都開在這個 socket
                </span>
              </span>
              <span className="mono">{remote.tmuxSocket}</span>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Desktop 設定（只影響本機）</h3>
        <div className="settings-row">
          <span>主題</span>
          <span className="hint">Dark（淺色主題與字級縮放沿用 SPEC FR-09，Phase 6 移植）</span>
        </div>
        <div className="settings-row">
          <span>
            Terminal 字型
            <span className="hint settings-sub">Cascadia Mono / Consolas / Noto Sans Mono CJK</span>
          </span>
          <span className="hint">Phase 6 開放調整</span>
        </div>
        <div className="settings-row">
          <span>資料模式</span>
          <span className={`mode-tag${mockData ? ' mode-mock' : ' mode-ssh'}`}>
            {mockData ? 'MOCK 資料' : 'SSH'}
          </span>
        </div>
      </div>

      <div className="card">
        <h3>連線</h3>
        <div className="settings-row">
          <span>連線設定</span>
          <span className="hint">用頂端 ⚙ 管理；密碼以 OS 安全儲存加密</span>
        </div>
        <div className="settings-row">
          <span>Host key 驗證</span>
          <span className="hint">首次信任與變更警告已啟用</span>
        </div>
      </div>

      {canSimulateDrop ? (
        <div className="card">
          <h3>Developer (mock)</h3>
          <div className="settings-row">
            <span>斷線重連測試</span>
            <button
              onClick={() =>
                (bridge as unknown as { simulateDrop(): void }).simulateDrop()
              }
            >
              模擬非預期斷線
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3>About</h3>
        <div className="settings-row">
          <span>App</span>
          <span className="mono">CozyPad V3 0.0.1 (bootstrap)</span>
        </div>
        <div className="settings-row">
          <span>Bridge</span>
          <span className="mono">{bridgeKind}</span>
        </div>
        <div className="settings-row">
          <span>Protocol</span>
          <span className="mono">v{PROTOCOL_VERSION}</span>
        </div>
        <div className="settings-row">
          <span>Agent adapter</span>
          <span className="hint">尚未接線（Phase 2/3）；架構層與 parser 已完成</span>
        </div>
      </div>
    </div>
  );
}
