import type {
  TmuxInstallLog,
  TmuxInstallLogLine,
  TmuxInstallProgress,
  TmuxInstallResult,
  TmuxStatus,
} from '@cozypad/contracts';
import {
  buildRemoteCleanupScript,
  buildTmuxInstallScript,
  detectTmux,
  parseInstallFailure,
} from '@cozypad/tmux-runtime';
import type { RemoteExec } from './shellRemoteFiles';

const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export type StreamingExec = (
  command: string,
  onLine: (line: string) => void,
  timeoutMs?: number,
) => Promise<string>;

export interface TmuxProvisionerPort {
  status(): Promise<TmuxStatus>;
  install(
    onProgress: (progress: TmuxInstallProgress) => void,
    onLog?: (log: TmuxInstallLog) => void,
  ): Promise<TmuxInstallResult>;
  cleanup(removeTmuxBinary: boolean): Promise<string>;
}

const LOG_FLUSH_MS = 120;

/** 使用者層級 tmux 佈建：偵測 → （使用者同意後）建置安裝 → 驗證確實可用。 */
export class ShellTmuxProvisioner implements TmuxProvisionerPort {
  constructor(
    private readonly exec: RemoteExec,
    private readonly execStream: StreamingExec,
  ) {}

  status(): Promise<TmuxStatus> {
    return detectTmux(this.exec);
  }

  async install(
    onProgress: (progress: TmuxInstallProgress) => void,
    onLog?: (log: TmuxInstallLog) => void,
  ): Promise<TmuxInstallResult> {
    const startedAt = Date.now();
    const elapsed = (): number => Math.round((Date.now() - startedAt) / 1000);

    // 建置會產生上萬行輸出；批次送出避免 IPC 與 React 被洗版。
    let buffer: TmuxInstallLogLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (buffer.length === 0) return;
      onLog?.({ lines: buffer });
      buffer = [];
    };
    const queueLog = (line: TmuxInstallLogLine): void => {
      buffer.push(line);
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        flush();
      }, LOG_FLUSH_MS);
    };

    onProgress({
      stage: 'starting',
      percent: 0,
      message: '準備使用者層級安裝（不需要 sudo）',
      elapsedSeconds: 0,
    });

    let log = '';
    try {
      // 逐行串流，讓 UI 在數分鐘的建置過程中持續看到進度與實際輸出。
      log = await this.execStream(
        buildTmuxInstallScript(),
        (line) => {
          const command = /^__CMD__\t(.*)$/.exec(line);
          if (command) {
            queueLog({ kind: 'command', text: command[1]!.trim() });
            return;
          }
          const output = /^__LOG__\t(.*)$/.exec(line);
          if (output) {
            queueLog({ kind: 'output', text: output[1]! });
            return;
          }
          const match = /^__STAGE__\t(\S+)\t(\d+)\t(.*)$/.exec(line);
          if (!match) return;
          flush();
          const percent = Number(match[2]);
          const seconds = elapsed();
          onProgress({
            stage: match[1] as TmuxInstallProgress['stage'],
            percent,
            message: match[3]!.trim(),
            elapsedSeconds: seconds,
            // 用目前進度線性外推剩餘時間；百分比夠低時不猜。
            ...(percent >= 10 && percent < 100
              ? {
                  etaSeconds: Math.max(
                    5,
                    Math.round((seconds / percent) * (100 - percent)),
                  ),
                }
              : {}),
          });
        },
        INSTALL_TIMEOUT_MS,
      );
      flush();
    } catch (error) {
      flush();
      const message = error instanceof Error ? error.message : String(error);
      onProgress({
        stage: 'failed',
        percent: 0,
        message,
        elapsedSeconds: elapsed(),
      });
      return { ok: false, status: await this.status(), log: `${log}\n${message}`.trim() };
    }

    const failure = parseInstallFailure(log);
    if (failure !== null) {
      onProgress({
        stage: 'failed',
        percent: 0,
        message: `步驟失敗：${failure.step}`,
        elapsedSeconds: elapsed(),
      });
      return {
        ok: false,
        status: await this.status(),
        log: `失敗步驟：${failure.step}\n\n${failure.logTail}`,
      };
    }

    const status = await this.status();
    const ok = status.installed && status.satisfiesTarget;
    onProgress({
      stage: ok ? 'done' : 'failed',
      percent: ok ? 100 : 0,
      message: ok
        ? `tmux ${status.version ?? ''} 已可用`
        : '安裝流程結束，但仍偵測不到可用的 tmux',
      elapsedSeconds: elapsed(),
    });
    return { ok, status, log };
  }

  async cleanup(removeTmuxBinary: boolean): Promise<string> {
    const output = await this.exec(buildRemoteCleanupScript({ removeTmuxBinary }), 30_000);
    const match = /__CLEANED__\t(.*)/.exec(output);
    return match?.[1]?.trim() ?? '';
  }
}

/** mock 模式：假裝已裝好最新版。 */
export class MockTmuxProvisioner implements TmuxProvisionerPort {
  private readonly ready: TmuxStatus = {
    installed: true,
    version: '3.5a',
    path: '/usr/bin/tmux',
    userLevel: false,
    satisfiesTarget: true,
    targetVersion: '3.5a',
    canInstall: true,
    missingTools: [],
    extraBuilds: [],
  };

  status(): Promise<TmuxStatus> {
    return Promise.resolve(this.ready);
  }

  install(
    onProgress: (progress: TmuxInstallProgress) => void,
    onLog?: (log: TmuxInstallLog) => void,
  ): Promise<TmuxInstallResult> {
    onLog?.({ lines: [{ kind: 'command', text: 'mock: 略過安裝' }] });
    onProgress({ stage: 'done', percent: 100, message: 'mock 模式無需安裝', elapsedSeconds: 0 });
    return Promise.resolve({ ok: true, status: this.ready, log: '' });
  }

  cleanup(): Promise<string> {
    return Promise.resolve('mock');
  }
}
