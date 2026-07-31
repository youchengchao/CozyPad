import { useEffect, useRef, useState } from 'react';
import type {
  TmuxInstallLogLine,
  TmuxInstallProgress,
  TmuxStatus,
} from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

/** 保留在畫面上的最大行數；建置輸出可達上萬行。 */
const MAX_LOG_LINES = 600;

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
  const [logLines, setLogLines] = useState<TmuxInstallLogLine[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(
    () => bridge.onTmuxInstallProgress((event) => setProgress((all) => [...all, event])),
    [bridge],
  );

  useEffect(
    () =>
      bridge.onTmuxInstallLog((log) =>
        setLogLines((all) => [...all, ...log.lines].slice(-MAX_LOG_LINES)),
      ),
    [bridge],
  );

  useEffect(() => {
    const element = consoleRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [logLines]);

  // 安裝跑在這條 SSH 連線上：關掉視窗會中斷建置。
  useEffect(() => {
    if (!installing) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [installing]);

  const install = () => {
    setInstalling(true);
    setFailure(null);
    setProgress([]);
    setLogLines([]);
    stickToBottom.current = true;
    void bridge
      .installTmux()
      .then((result) => {
        if (result.ok) {
          onInstalled(result.status);
        } else {
          setFailure(result.log.trim() || '安裝失敗，未取得詳細訊息');
        }
      })
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false));
  };

  const outdated = status.installed && !status.satisfiesTarget;
  const latest = progress[progress.length - 1];
  const formatDuration = (seconds: number): string =>
    seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;

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
            遠端缺少基本建置工具：{status.missingTools.join('、')}
            ——這些無法自行補齊，請先請管理者安裝，或直接安裝 tmux。
          </div>
        ) : (
          <p className="hint">
            自動安裝會以<strong>使用者層級</strong>建置 tmux {status.targetVersion}
            （libevent + ncurses + tmux
            {status.extraBuilds.length > 0 ? ` + ${status.extraBuilds.join(' + ')}` : ''}
            ）到 <span className="mono">~/.local</span>，不需要 sudo、不影響系統其他使用者，
            並把 <span className="mono">~/.local/bin</span> 加進 shell PATH。
            建置暫存在完成後會自動刪除。整個過程約
            {status.extraBuilds.length > 0 ? ' 5-15 ' : ' 3-10 '}分鐘。
          </p>
        )}

        {status.canInstall && status.extraBuilds.length > 0 ? (
          <p className="hint">
            偵測到遠端缺少 <span className="mono">yacc</span>，安裝時會一併建置{' '}
            <span className="mono">{status.extraBuilds.join('、')}</span>——不需要你另外處理。
          </p>
        ) : null}

        {latest !== undefined ? (
          <div className="install-progress">
            <div className="install-progress-head">
              <span className="install-current">
                {STAGE_LABEL[latest.stage]} · {latest.message}
              </span>
              <span className="mono install-percent">{latest.percent}%</span>
            </div>
            <div className="bar">
              <div
                className={`bar-fill${latest.stage === 'failed' ? ' bar-hot' : ''}`}
                style={{ width: `${latest.percent}%` }}
              />
            </div>
            <div className="install-timing hint">
              <span>已耗時 {formatDuration(latest.elapsedSeconds)}</span>
              {latest.etaSeconds !== undefined && latest.stage !== 'done' ? (
                <span>預估剩餘 約 {formatDuration(latest.etaSeconds)}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {logLines.length > 0 ? (
          <div
            className="install-console"
            ref={consoleRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            }}
          >
            {logLines.map((line, index) => (
              <div
                key={index}
                className={line.kind === 'command' ? 'console-cmd' : 'console-out'}
              >
                {line.kind === 'command' ? `$ ${line.text}` : line.text}
              </div>
            ))}
          </div>
        ) : null}

        {progress.length > 1 ? (
          <details className="install-log-details">
            <summary className="hint">步驟摘要（{progress.length}）</summary>
            <div className="install-log">
              {progress.map((event, index) => (
                <div key={index} className={`install-row install-${event.stage}`}>
                  <span className="install-stage">{STAGE_LABEL[event.stage]}</span>
                  <span className="install-message">{event.message}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {failure !== null ? (
          <>
            <p className="hint install-failure-hint">
              安裝失敗。下方是遠端建置的錯誤輸出，可複製後貼給我或管理者。
            </p>
            <pre className="command-block install-error">{failure}</pre>
            <button
              className="install-copy"
              onClick={() => void bridge.writeClipboard(failure).catch(() => undefined)}
            >
              複製錯誤訊息
            </button>
          </>
        ) : null}

        {installing ? (
          <p className="hint install-keepopen">
            安裝在這條 SSH 連線上執行——請保持視窗開啟並維持連線；中斷後可重新安裝，
            已完成的部分會被重用。
          </p>
        ) : null}

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
