/**
 * Claude CLI 非互動 structured mode 的啟動參數（SPEC_V3 §7.3）。
 * 回傳 argv 陣列——prompt 一律走 stdin，不拼接進 shell 字串（SPEC_V3 §13）。
 * 實際 flags 應在 capability detection 後確認，不得假定所有遠端版本相同。
 */
export function buildClaudeArgv(options: {
  executable?: string;
  resumeConversationId?: string;
  model?: string;
  includePartialMessages?: boolean;
}): string[] {
  return [
    options.executable ?? 'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(options.includePartialMessages === true
      ? ['--include-partial-messages']
      : []),
    ...(options.resumeConversationId === undefined
      ? []
      : ['--resume', options.resumeConversationId]),
    ...(options.model === undefined ? [] : ['--model', options.model]),
  ];
}

/**
 * Claude Agent SDK 使用的長連線 stdio 模式。程序由 tmux 持有，CozyPad 以
 * NDJSON user/control frames 驅動同一個 conversation，而不是每回合重啟 CLI。
 */
export function buildClaudeStreamingArgv(options: {
  executable?: string;
  /** 喚醒既有 session：以 --resume 續接已綁定的 conversation。 */
  resumeConversationId?: string;
  includePartialMessages?: boolean;
  permissionPromptTool?: string;
  permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'plan'
    | 'auto'
    | 'dontAsk'
    | 'bypassPermissions';
  /** @deprecated Prefer permissionMode: 'bypassPermissions'. */
  dangerouslySkipPermissions?: boolean;
  model?: string;
} = {}): string[] {
  return [
    options.executable ?? 'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    ...(options.resumeConversationId === undefined
      ? []
      : ['--resume', options.resumeConversationId]),
    ...(options.includePartialMessages === true
      ? ['--include-partial-messages']
      : []),
    ...(options.permissionPromptTool === undefined
      ? []
      : ['--permission-prompt-tool', options.permissionPromptTool]),
    ...(options.permissionMode === undefined
      ? []
      : ['--permission-mode', options.permissionMode]),
    ...(options.permissionMode === undefined &&
    options.dangerouslySkipPermissions === true
      ? ['--dangerously-skip-permissions']
      : []),
    ...(options.model === undefined ? [] : ['--model', options.model]),
  ];
}
