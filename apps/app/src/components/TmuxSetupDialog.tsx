import { useEffect, useState } from 'react';
import type { TmuxInstallProgress, TmuxStatus } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface TmuxSetupDialogProps {
  status: TmuxStatus;
  onDismiss(): void;
  onInstalled(status: TmuxStatus): void;
}

const STAGE_LABEL: Record<TmuxInstallProgress['stage'], string> = {
  starting: '準備中',
  downloading: '下載原始碼',
  building: '建置中',
  installing: '安裝中',
  verifying: '驗證中',
  done: '完成',
  failed: '失敗',
};

export function TmuxSetupDialog({ status, onDismiss, onInstalled }: TmuxSetupDialogProps) {
  const bridge = getBridge();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<TmuxInstallProgress[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(
    () => bridge.onTmuxInstallProgress((event) => setProgress((all) => [...all, event])),
    [bridge],
  );

  const install = () => {
    setInstalling(true);
    setFailure(null);
    setProgress([]);
    void bridge
      .installTmux()
      .then((result) => {
        if (result.ok) {
          onInstalled(result.status);
        } else {
          setFailure(
            result.log.trim().split('\n').slice(-6).join('\n') || '安裝失敗，未取得詳細訊息',
          );
        }
      })
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false));
  };

  const outdated = status.installed && !status.satisfiesTarget;

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{outdated ? 'tmux 版本過舊' : '遠端主機未安裝 tmux'}</h2>
          {installing ? null : (
            <button className="modal-close" onClick={onDismiss}>
              ×
            </button>
          )}
        </div>

        <p className="hint">
          CozyPad 的 agent conversation session 一律在 tmux 中執行（斷線後仍持續、可重新接上）。
          {outdated
            ? ` 目前遠端為 tmux ${status.version ?? '未知'}，建議 ${status.targetVersion} 以上。`
            : ' 遠端主機上找不到 tmux。'}
        </p>

        {!status.canInstall ? (
          <div className="error-banner">
            遠端缺少建置工具：{status.missingTools.join('、')}
            ——無法自動安裝，請先請管理者安裝這些工具或直接安裝 tmux。
          </div>
        ) : (
          <p className="hint">
            自動安裝會以<strong>使用者層級</strong>建置 tmux {status.targetVersion}
            （libevent + ncurses + tmux）到 <span className="mono">~/.local</span>，
            不需要 sudo、不影響系統其他使用者，並把 <span className="mono">~/.local/bin</span>
            加進 shell PATH。整個過程約 3-10 分鐘。
          </p>
        )}

        {progress.length > 0 ? (
          <div className="install-log">
            {progress.map((event, index) => (
              <div key={index} className={`install-row install-${event.stage}`}>
                <span className="install-stage">{STAGE_LABEL[event.stage]}</span>
                <span className="install-message">{event.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        {failure !== null ? <pre className="command-block install-error">{failure}</pre> : null}

        <div className="form-actions">
          <button disabled={installing} onClick={onDismiss}>
            稍後再說
          </button>
          <button
            className="primary"
            disabled={installing || !status.canInstall}
            onClick={install}
          >
            {installing ? '安裝中…' : '安裝 tmux'}
          </button>
        </div>
      </div>
    </div>
  );
}
