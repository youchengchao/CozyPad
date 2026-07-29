import type { RemoteSettings, RemoteSettingsPatch } from '@cozypad/contracts';
import type { TmuxRuntime } from '@cozypad/tmux-runtime';

export interface RemoteSettingsPort {
  get(): Promise<RemoteSettings>;
  set(patch: RemoteSettingsPatch): Promise<RemoteSettings>;
}

/** 遠端設定實際套用在主機上（tmux 選項），不是本機偏好。 */
export class TmuxRemoteSettings implements RemoteSettingsPort {
  constructor(private readonly tmux: TmuxRuntime) {}

  async get(): Promise<RemoteSettings> {
    return {
      tmuxMouseMode: await this.tmux.getMouseMode(),
      tmuxSocket: this.tmux.socketName,
    };
  }

  async set(patch: RemoteSettingsPatch): Promise<RemoteSettings> {
    if (patch.tmuxMouseMode !== undefined) {
      await this.tmux.setMouseMode(patch.tmuxMouseMode);
    }
    return this.get();
  }
}

/** mock 模式：只在記憶體中保留，不碰任何主機。 */
export class MemoryRemoteSettings implements RemoteSettingsPort {
  private settings: RemoteSettings = { tmuxMouseMode: true, tmuxSocket: 'default' };

  get(): Promise<RemoteSettings> {
    return Promise.resolve({ ...this.settings });
  }

  set(patch: RemoteSettingsPatch): Promise<RemoteSettings> {
    this.settings = { ...this.settings, ...patch };
    return Promise.resolve({ ...this.settings });
  }
}
