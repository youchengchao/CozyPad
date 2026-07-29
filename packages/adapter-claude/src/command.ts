/**
 * Claude CLI 非互動 structured mode 的啟動參數（SPEC_V3 §7.3）。
 * 回傳 argv 陣列——prompt 一律走 stdin，不拼接進 shell 字串（SPEC_V3 §13）。
 * 實際 flags 應在 capability detection 後確認，不得假定所有遠端版本相同。
 */
export function buildClaudeArgv(options: {
  resumeConversationId?: string;
  model?: string;
}): string[] {
  return [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(options.resumeConversationId === undefined
      ? []
      : ['--resume', options.resumeConversationId]),
    ...(options.model === undefined ? [] : ['--model', options.model]),
  ];
}

/** 版本偵測命令（capability handshake 的第一步）。 */
export const CLAUDE_DETECT_ARGV = ['claude', '--version'];
