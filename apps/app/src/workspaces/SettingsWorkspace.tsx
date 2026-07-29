import { PROTOCOL_VERSION } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface SettingsWorkspaceProps {
  bridgeKind: string;
}

export function SettingsWorkspace({ bridgeKind }: SettingsWorkspaceProps) {
  const bridge = getBridge();
  const canSimulateDrop = 'simulateDrop' in bridge;

  return (
    <div className="settings-workspace">
      <div className="card">
        <h3>Appearance</h3>
        <div className="settings-row">
          <span>Theme</span>
          <span className="hint">Dark（淺色主題與縮放沿用 SPEC FR-09，Phase 6 移植）</span>
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
        <h3>Connection</h3>
        <div className="settings-row">
          <span>Profiles</span>
          <span className="hint">
            secure profile 儲存（Electron safeStorage）於 Phase 3 落地；目前為 mock／環境變數
          </span>
        </div>
        <div className="settings-row">
          <span>Host key verification</span>
          <span className="hint">Phase 1 terminal gate 項目，尚未實作</span>
        </div>
      </div>

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
          <span>Agent adapter</span>
          <span className="hint">尚未接線（Phase 2/3）；架構層與 parser 已完成</span>
        </div>
        <div className="settings-row">
          <span>Protocol</span>
          <span className="mono">v{PROTOCOL_VERSION}</span>
        </div>
        <div className="settings-row">
          <span>Stack</span>
          <span className="hint">
            Electron + Capacitor 共用同一套 React app；Tauri 為效能逃生路線（SPEC_V3 3.1）
          </span>
        </div>
      </div>
    </div>
  );
}
