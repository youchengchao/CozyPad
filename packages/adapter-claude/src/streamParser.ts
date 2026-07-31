import type { AgentKind, NormalizedAgentEvent } from '@cozypad/contracts';

export const CLAUDE_RAW_EVENT_VERSION = 'claude-stream-json-v1';

/** parser 需要的 envelope 供應器；ID／時間由呼叫端控制以便測試與重放。 */
export interface ClaudeParseContext {
  localSessionId: string;
  agentConversationId?: string;
  nextSequence(): number;
  nextEventId(): string;
  now(): string;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: RawContentBlock) =>
        typeof block === 'object' && block !== null && typeof block.text === 'string'
          ? block.text
          : '',
      )
      .join('');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function summarizeInput(input: unknown, maxLength = 200): string {
  const text = input === undefined ? '' : JSON.stringify(input);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 把 Claude CLI `--output-format stream-json` 的一行轉成 normalized events
 * （SPEC_V3 §7.1／§7.3）。未知型別容忍略過（回傳空陣列），不得讓 UI 崩潰；
 * 無法解析的 JSON 產生 agent_error。
 */
export function parseClaudeStreamLine(
  line: string,
  context: ClaudeParseContext,
  agentKind: AgentKind = 'claude',
): NormalizedAgentEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  const envelope = () => ({
    eventId: context.nextEventId(),
    sequence: context.nextSequence(),
    localSessionId: context.localSessionId,
    agentKind,
    ...(context.agentConversationId === undefined
      ? {}
      : { agentConversationId: context.agentConversationId }),
    timestamp: context.now(),
    rawEventVersion: CLAUDE_RAW_EVENT_VERSION,
  });

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    return [
      {
        ...envelope(),
        kind: 'agent_error',
        message: `unparseable stream-json line: ${trimmed.slice(0, 120)}`,
      },
    ];
  }

  const type = raw.type;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (sessionId !== undefined) context.agentConversationId = sessionId;

  if (type === 'system') {
    if (raw.subtype === 'init' && sessionId !== undefined) {
      return [
        {
          ...envelope(),
          kind: 'session_initialized',
          agentConversationId: sessionId,
          ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
          ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        },
      ];
    }
    return [];
  }

  if (type === 'assistant' || type === 'user') {
    const message = raw.message;
    if (typeof message !== 'object' || message === null) return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    const events: NormalizedAgentEvent[] = [];
    for (const block of content as RawContentBlock[]) {
      if (typeof block !== 'object' || block === null) continue;
      if (type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim() !== '') {
          events.push({
            ...envelope(),
            kind: 'assistant_message_completed',
            text: block.text,
          });
        }
      } else if (type === 'assistant' && block.type === 'tool_use') {
        events.push({
          ...envelope(),
          kind: 'tool_call_started',
          toolCallId: block.id ?? 'unknown',
          name: block.name ?? 'unknown',
          inputSummary: summarizeInput(block.input),
        });
      } else if (type === 'user' && block.type === 'tool_result') {
        events.push({
          ...envelope(),
          kind: 'tool_call_completed',
          toolCallId: block.tool_use_id ?? 'unknown',
          output: contentToText(block.content),
          isError: block.is_error === true,
        });
      }
    }
    return events;
  }

  if (type === 'result') {
    const events: NormalizedAgentEvent[] = [];
    const usage = raw.usage;
    if (typeof usage === 'object' && usage !== null) {
      const usageRecord = usage as { input_tokens?: unknown; output_tokens?: unknown };
      events.push({
        ...envelope(),
        kind: 'usage',
        inputTokens:
          typeof usageRecord.input_tokens === 'number' ? usageRecord.input_tokens : 0,
        outputTokens:
          typeof usageRecord.output_tokens === 'number' ? usageRecord.output_tokens : 0,
        ...(typeof raw.total_cost_usd === 'number'
          ? { costUsd: raw.total_cost_usd }
          : {}),
      });
    }
    if (raw.is_error === true) {
      events.push({
        ...envelope(),
        kind: 'agent_error',
        message:
          typeof raw.result === 'string' ? raw.result : String(raw.subtype ?? 'error'),
      });
    }
    events.push({
      ...envelope(),
      kind: 'turn_completed',
      ...(typeof raw.subtype === 'string' ? { stopReason: raw.subtype } : {}),
    });
    return events;
  }

  return [];
}
