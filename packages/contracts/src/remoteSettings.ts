import { z } from 'zod';

/**
 * 遠端主機上與本專案相關的設定（存在遠端、跨裝置一致）。
 * 有別於 desktop 設定（主題、字級等，只影響本機 UI）。
 */
export const RemoteSettingsSchema = z.object({
  /** tmux mouse 模式：滾輪捲動 pane 歷史、滑鼠選取／切換 pane。 */
  tmuxMouseMode: z.boolean(),
  /** CozyPad 管理的 tmux socket 名稱（agent session 全部開在這裡）。 */
  tmuxSocket: z.string().min(1).default('default'),
});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

export const RemoteSettingsPatchSchema = RemoteSettingsSchema.partial();
export type RemoteSettingsPatch = z.infer<typeof RemoteSettingsPatchSchema>;
