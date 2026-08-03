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

interface RawQuestionOption {
  label?: unknown;
  description?: unknown;
}

interface RawQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
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

function parseQuestions(toolCallId: string, input: unknown) {
  if (typeof input !== 'object' || input === null) return [];
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.flatMap((rawQuestion: RawQuestion, index) => {
    if (typeof rawQuestion !== 'object' || rawQuestion === null) return [];
    if (typeof rawQuestion.question !== 'string') return [];
    if (!Array.isArray(rawQuestion.options)) return [];
    const options = rawQuestion.options.flatMap((option: RawQuestionOption) => {
      if (typeof option !== 'object' || option === null) return [];
      if (typeof option.label !== 'string' || option.label.trim() === '') return [];
      return [
        {
          label: option.label,
          ...(typeof option.description === 'string'
            ? { description: option.description }
            : {}),
        },
      ];
    });
    if (options.length < 2 || options.length > 6) return [];
    return [
      {
        questionId: `${toolCallId}:${index}`,
        prompt:
          typeof rawQuestion.header === 'string' && rawQuestion.header.trim() !== ''
            ? `${rawQuestion.header}: ${rawQuestion.question}`
            : rawQuestion.question,
        options,
      },
    ];
  });
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
      const slashCommands = Array.isArray(raw.slash_commands)
        ? raw.slash_commands.filter(
            (command): command is string =>
              typeof command === 'string' && command.trim() !== '',
          )
        : undefined;
      return [
        {
          ...envelope(),
          kind: 'session_initialized',
          agentConversationId: sessionId,
          ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
          ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
          ...(slashCommands === undefined ? {} : { slashCommands }),
        },
      ];
    }
    return [];
  }

  if (type === 'stream_event') {
    const streamEvent = raw.event;
    if (typeof streamEvent !== 'object' || streamEvent === null) return [];
    const eventRecord = streamEvent as Record<string, unknown>;
    if (eventRecord.type === 'content_block_start') {
      const contentBlock = eventRecord.content_block;
      if (
        typeof contentBlock === 'object' &&
        contentBlock !== null &&
        (contentBlock as { type?: unknown }).type === 'text'
      ) {
        return [{ ...envelope(), kind: 'assistant_message_started' }];
      }
    }
    if (eventRecord.type === 'content_block_delta') {
      const delta = eventRecord.delta;
      if (
        typeof delta === 'object' &&
        delta !== null &&
        (delta as { type?: unknown }).type === 'text_delta' &&
        typeof (delta as { text?: unknown }).text === 'string'
      ) {
        return [
          {
            ...envelope(),
            kind: 'assistant_text_delta',
            text: (delta as { text: string }).text,
          },
        ];
      }
    }
    return [];
  }

  if (type === 'control_request') {
    const request = raw.request;
    if (typeof request !== 'object' || request === null) return [];
    const requestRecord = request as Record<string, unknown>;
    if (requestRecord.subtype !== 'can_use_tool') return [];
    const approvalId =
      typeof raw.request_id === 'string'
        ? raw.request_id
        : typeof raw.id === 'string'
          ? raw.id
          : undefined;
    if (approvalId === undefined) return [];
    const toolName =
      typeof requestRecord.tool_name === 'string'
        ? requestRecord.tool_name
        : 'unknown tool';
    if (toolName === 'AskUserQuestion') {
      return parseQuestions(approvalId, requestRecord.input).map((question) => ({
        ...envelope(),
        kind: 'question_requested' as const,
        ...question,
      }));
    }
    return [
      {
        ...envelope(),
        kind: 'approval_requested',
        approvalId,
        command: `${toolName} ${summarizeInput(requestRecord.input)}`.trim(),
        riskSummary: `Claude requests permission to use ${toolName}`,
      },
    ];
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
        const toolCallId = block.id ?? 'unknown';
        events.push({
          ...envelope(),
          kind: 'tool_call_started',
          toolCallId,
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
