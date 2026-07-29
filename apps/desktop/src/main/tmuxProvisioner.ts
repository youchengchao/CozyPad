import type { TmuxInstallProgress, TmuxInstallResult, TmuxStatus } from '@cozypad/contracts';
import { buildTmuxInstallScript, detectTmux } from '@cozypad/tmux-runtime';
import type { RemoteExec } from './files/shellRemoteFiles';

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

export interface TmuxProvisionerPort {
  status(): Promise<TmuxStatus>;
  install(onProgress: (progress: TmuxInstallProgress) => void): Promise<TmuxInstallResult>;
}

/** 使用者層級 tmux 佈建：偵測 → （使用者同意後）建置安裝 → 驗證確實可用。 */
export class ShellTmuxProvisioner implements TmuxProvisionerPort {
  constructor(private readonly exec: RemoteExec) {}

  status(): Promise<TmuxStatus> {
    return detectTmux(this.exec);
  }

  async install(
    onProgress: (progress: TmuxInstallProgress) => void,
  ): Promise<TmuxInstallResult> {
    onProgress({ stage: 'starting', message: '準備使用者層級安裝（不需要 sudo）' });
    let log = '';
    try {
      log = await this.exec(buildTmuxInstallScript(), INSTALL_TIMEOUT_MS);
      for (const match of log.matchAll(/__STAGE__\t(\S+)\t(.*)/g)) {
        const stage = match[1] as TmuxInstallProgress['stage'];
        onProgress({ stage, message: match[2]!.trim() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress({ stage: 'failed', message });
      return { ok: false, status: await this.status(), log: `${log}\n${message}`.trim() };
    }

    onProgress({ stage: 'verifying', message: '確認 tmux 生效中…' });
    const status = await this.status();
    const ok = status.installed && status.satisfiesTarget;
    onProgress(
      ok
        ? { stage: 'done', message: `tmux ${status.version ?? ''} 已可用` }
        : { stage: 'failed', message: '安裝流程結束，但仍偵測不到可用的 tmux' },
    );
    return { ok, status, log };
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
  };

  status(): Promise<TmuxStatus> {
    return Promise.resolve(this.ready);
  }

  install(
    onProgress: (progress: TmuxInstallProgress) => void,
  ): Promise<TmuxInstallResult> {
    onProgress({ stage: 'done', message: 'mock 模式無需安裝' });
    return Promise.resolve({ ok: true, status: this.ready, log: '' });
  }
}
