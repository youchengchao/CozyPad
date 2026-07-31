import { z } from 'zod';

/** CozyPad 期望的 tmux 版本下限（低於此版本的 mouse 模式與 pane 格式行為不一致）。 */
export const TMUX_TARGET_VERSION = '3.5a';

export const TmuxStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  /** 可執行檔路徑；使用者層級安裝會在 ~/.local/bin/tmux。 */
  path: z.string().nullable(),
  userLevel: z.boolean(),
  /** 版本是否達到 TMUX_TARGET_VERSION。 */
  satisfiesTarget: z.boolean(),
  targetVersion: z.string(),
  /** 是否具備自動安裝所需的工具（curl/tar/make/cc）。 */
  canInstall: z.boolean(),
  missingTools: z.array(z.string()),
  /** 安裝時會順便建置的相依工具（例如遠端缺 yacc 時的 bison）。 */
  extraBuilds: z.array(z.string()).default([]),
});
export type TmuxStatus = z.infer<typeof TmuxStatusSchema>;

export const TmuxInstallProgressSchema = z.object({
  stage: z.enum(['starting', 'downloading', 'building', 'installing', 'verifying', 'done', 'failed']),
  /** 0-100；由安裝腳本的已知步驟權重推得。 */
  percent: z.number().min(0).max(100),
  message: z.string(),
  elapsedSeconds: z.number().min(0),
  /** 依目前進度線性外推的剩餘秒數；進度太低時不提供。 */
  etaSeconds: z.number().min(0).optional(),
});
export type TmuxInstallProgress = z.infer<typeof TmuxInstallProgressSchema>;

/** 安裝過程的即時輸出：實際執行的指令與其 stdout/stderr。 */
export const TmuxInstallLogSchema = z.object({
  lines: z.array(
    z.object({
      kind: z.enum(['command', 'output']),
      text: z.string(),
    }),
  ),
});
export type TmuxInstallLog = z.infer<typeof TmuxInstallLogSchema>;
export type TmuxInstallLogLine = TmuxInstallLog['lines'][number];

export const TmuxInstallResultSchema = z.object({
  ok: z.boolean(),
  status: TmuxStatusSchema,
  log: z.string(),
});
export type TmuxInstallResult = z.infer<typeof TmuxInstallResultSchema>;
