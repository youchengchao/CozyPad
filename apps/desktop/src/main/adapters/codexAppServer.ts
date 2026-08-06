import type { NormalizedAgentEvent } from '@cozypad/contracts';

export const CODEX_RAW_EVENT_VERSION = 'codex-app-server-v2';

/**
 * Every JSON-RPC method that blocks a Codex turn until CozyPad replies.
 * The service registers these as pending controls and this adapter must emit
 * a card for each one: a method registered but never rendered leaves the turn
 * waiting forever on a reply no card can send, which is why the list lives in
 * one place. Names come from `codex app-server generate-ts` (v2).
 */
export const CODEX_CONTROL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
] as const;

export interface CodexParseContext {
  localSessionId: string;
  agentConversationId?: string;
  nextSequence(): number;
  nextEventId(): string;
  now(): string;
  /**
   * Paths from each fileChange item/started, kept for the approval request
   * that follows: FileChangeRequestApprovalParams carries only an opaque
   * itemId, so without this the card cannot say which files are touched.
   */
  fileChangePaths?: Map<string, string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function itemEvents(
  lifecycle: 'started' | 'completed',
  item: Record<string, unknown>,
  envelope: () => Omit<NormalizedAgentEvent, 'kind'>,
  context: CodexParseContext,
): NormalizedAgentEvent[] {
  const itemId = stringValue(item.id) ?? 'unknown';
  const itemType = item.type;
  if (itemType === 'agentMessage') {
    if (lifecycle === 'started') {
      return [{ ...envelope(), kind: 'assistant_message_started' }];
    }
    const text = stringValue(item.text);
    return text === undefined
      ? []
      : [{ ...envelope(), kind: 'assistant_message_completed', text }];
  }

  if (itemType === 'commandExecution') {
    if (lifecycle === 'started') {
      return [
        {
          ...envelope(),
          kind: 'tool_call_started',
          toolCallId: itemId,
          name: 'Shell',
          inputSummary: display({ command: item.command, cwd: item.cwd }),
        },
      ];
    }
    return [
      {
        ...envelope(),
        kind: 'tool_call_completed',
        toolCallId: itemId,
        output: display(item.aggregatedOutput),
        isError: item.status === 'failed' || item.status === 'declined',
      },
    ];
  }

  if (itemType === 'fileChange') {
    if (lifecycle === 'started') {
      const paths = Array.isArray(item.changes)
        ? item.changes.flatMap((change) =>
            isRecord(change) && typeof change.path === 'string' ? [change.path] : [],
          )
        : [];
      if (paths.length > 0) {
        (context.fileChangePaths ??= new Map()).set(itemId, paths);
      }
      return [
        {
          ...envelope(),
          kind: 'tool_call_started',
          toolCallId: itemId,
          name: 'ApplyPatch',
          inputSummary: display({ paths }),
        },
      ];
    }
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const diffs = changes.flatMap((change) => {
      if (!isRecord(change) || typeof change.path !== 'string') return [];
      const diff = typeof change.diff === 'string' ? change.diff : '';
      const lines = diff.split('\n');
      return [
        {
          ...envelope(),
          kind: 'file_diff' as const,
          path: change.path,
          additions: lines.filter(
            (line) => line.startsWith('+') && !line.startsWith('+++'),
          ).length,
          deletions: lines.filter(
            (line) => line.startsWith('-') && !line.startsWith('---'),
          ).length,
          diff,
        },
      ];
    });
    return [
      {
        ...envelope(),
        kind: 'tool_call_completed',
        toolCallId: itemId,
        output: display(item.changes),
        isError: item.status === 'failed' || item.status === 'declined',
      },
      ...diffs,
    ];
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
    const name =
      itemType === 'mcpToolCall'
        ? `${display(item.server)}/${display(item.tool)}`
        : display(item.tool);
    if (lifecycle === 'started') {
      return [
        {
          ...envelope(),
          kind: 'tool_call_started',
          toolCallId: itemId,
          name: name || itemType,
          inputSummary: display(item.arguments),
        },
      ];
    }
    return [
      {
        ...envelope(),
        kind: 'tool_call_completed',
        toolCallId: itemId,
        output: display(item.result ?? item.contentItems ?? item.error),
        isError: item.status === 'failed' || item.success === false,
      },
    ];
  }

  if (itemType === 'webSearch' && lifecycle === 'started') {
    return [
      {
        ...envelope(),
        kind: 'tool_call_started',
        toolCallId: itemId,
        name: 'WebSearch',
        inputSummary: display(item.query ?? item.action),
      },
    ];
  }
  if (itemType === 'webSearch' && lifecycle === 'completed') {
    return [
      {
        ...envelope(),
        kind: 'tool_call_completed',
        toolCallId: itemId,
        output: display(item.action),
        isError: false,
      },
    ];
  }
  return [];
}

function questionEvents(
  rawId: string | number,
  params: Record<string, unknown>,
  envelope: () => Omit<NormalizedAgentEvent, 'kind'>,
): NormalizedAgentEvent[] {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.flatMap((question, index) => {
    const base = {
      ...envelope(),
      kind: 'question_requested' as const,
      questionId: `${String(rawId)}:${index}`,
    };
    // Codex is blocked on this request whether or not the card can render
    // it, so a question CozyPad cannot represent still becomes a card —
    // marked unrepresentable, showing the raw content, offering decline
    // (SPEC 3.4.6). Dropping it left the turn waiting on nothing.
    if (!isRecord(question) || typeof question.question !== 'string') {
      return [
        {
          ...base,
          prompt: display(question) || 'Unreadable question payload',
          options: [],
          unrepresentable: true,
        },
      ];
    }
    const prompt =
      typeof question.header === 'string' && question.header !== ''
        ? `${question.header}: ${question.question}`
        : question.question;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== 'string') return [];
          return [
            {
              label: option.label,
              ...(typeof option.description === 'string'
                ? { description: option.description }
                : {}),
            },
          ];
        })
      : [];
    if (options.length < 2 || options.length > 6) {
      // Free-form input (options null) or an option count the card cannot
      // hold. Keep any raw options visible alongside the question text.
      return [
        {
          ...base,
          prompt:
            question.options == null
              ? prompt
              : `${prompt}\n${display(question.options)}`,
          options: [],
          unrepresentable: true,
        },
      ];
    }
    return [{ ...base, prompt, options }];
  });
}

export function parseCodexAppServerLine(
  line: string,
  context: CodexParseContext,
): NormalizedAgentEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  const envelope = () => ({
    eventId: context.nextEventId(),
    sequence: context.nextSequence(),
    localSessionId: context.localSessionId,
    agentKind: 'codex' as const,
    ...(context.agentConversationId === undefined
      ? {}
      : { agentConversationId: context.agentConversationId }),
    timestamp: context.now(),
    rawEventVersion: CODEX_RAW_EVENT_VERSION,
  });

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) throw new Error('not an object');
    raw = parsed;
  } catch {
    return [
      {
        ...envelope(),
        kind: 'agent_error',
        message: `unparseable Codex app-server line: ${trimmed.slice(0, 120)}`,
      },
    ];
  }

  const result = isRecord(raw.result) ? raw.result : undefined;
  const responseThread = result !== undefined && isRecord(result.thread)
    ? result.thread
    : undefined;
  const responseThreadId = responseThread === undefined
    ? undefined
    : stringValue(responseThread.id);
  if (responseThreadId !== undefined) {
    context.agentConversationId = responseThreadId;
    return [
      {
        ...envelope(),
        kind: 'session_initialized',
        agentConversationId: responseThreadId,
        slashCommands: ['compact', 'diff', 'review', 'status'],
      },
    ];
  }
  if (isRecord(raw.error) && typeof raw.error.message === 'string') {
    return [{ ...envelope(), kind: 'agent_error', message: raw.error.message }];
  }

  const method = raw.method;
  const params = isRecord(raw.params) ? raw.params : {};
  if (method === 'thread/started' && isRecord(params.thread)) {
    const threadId = stringValue(params.thread.id);
    if (threadId === undefined) return [];
    context.agentConversationId = threadId;
    return [
      {
        ...envelope(),
        kind: 'session_initialized',
        agentConversationId: threadId,
        slashCommands: ['compact', 'diff', 'review', 'status'],
      },
    ];
  }
  if (method === 'item/started' || method === 'item/completed') {
    if (!isRecord(params.item)) return [];
    return itemEvents(
      method === 'item/started' ? 'started' : 'completed',
      params.item,
      envelope,
      context,
    );
  }
  if (
    method === 'item/agentMessage/delta' &&
    typeof params.delta === 'string'
  ) {
    return [{ ...envelope(), kind: 'assistant_text_delta', text: params.delta }];
  }
  if (
    method === 'item/commandExecution/outputDelta' &&
    typeof params.itemId === 'string' &&
    typeof params.delta === 'string'
  ) {
    return [
      {
        ...envelope(),
        kind: 'tool_call_updated',
        toolCallId: params.itemId,
        update: params.delta,
      },
    ];
  }
  if (
    (method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval') &&
    (typeof raw.id === 'string' || typeof raw.id === 'number')
  ) {
    const network = isRecord(params.networkApprovalContext)
      ? params.networkApprovalContext
      : undefined;
    // A permissions request carries a profile, not a command. Rendering the
    // requested profile verbatim is deliberate: the fields are additive per
    // Codex version, and showing the raw request is the only claim that stays
    // true across all of them.
    const fileChangePaths =
      method === 'item/fileChange/requestApproval' &&
      typeof params.itemId === 'string'
        ? context.fileChangePaths?.get(params.itemId)
        : undefined;
    const command =
      network !== undefined
        ? `Network access: ${display(network.protocol)}://${display(network.host)}`
        : method === 'item/permissions/requestApproval'
          ? display(params.permissions ?? params) || method
          : fileChangePaths !== undefined && fileChangePaths.length > 0
            ? fileChangePaths.join('\n')
            : method === 'item/fileChange/requestApproval' &&
                stringValue(params.grantRoot) !== undefined
              ? `Write access under ${stringValue(params.grantRoot)}`
              : display(params.command ?? params.itemId ?? method);
    return [
      {
        ...envelope(),
        kind: 'approval_requested',
        approvalId: String(raw.id),
        command,
        riskSummary:
          stringValue(params.reason) ??
          (method === 'item/fileChange/requestApproval'
            ? 'Codex requests permission to modify files'
            : method === 'item/permissions/requestApproval'
              ? 'Codex requests additional sandbox permissions'
              : 'Codex requests permission to execute this command'),
      },
    ];
  }
  if (
    method === 'item/tool/requestUserInput' &&
    (typeof raw.id === 'string' || typeof raw.id === 'number')
  ) {
    return questionEvents(raw.id, params, envelope);
  }
  if (
    method === 'thread/tokenUsage/updated' &&
    isRecord(params.tokenUsage) &&
    isRecord(params.tokenUsage.last)
  ) {
    // SPEC 1225: usage is displayed whenever the agent reports it. `last`
    // is the current turn's breakdown (generate-ts v2 ThreadTokenUsage).
    const last = params.tokenUsage.last;
    if (
      typeof last.inputTokens !== 'number' ||
      typeof last.outputTokens !== 'number'
    ) {
      return [];
    }
    return [
      {
        ...envelope(),
        kind: 'usage',
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
      },
    ];
  }
  if (method === 'warning' && typeof params.message === 'string') {
    return [{ ...envelope(), kind: 'activity', label: params.message }];
  }
  if (method === 'error' && isRecord(params.error)) {
    return [
      {
        ...envelope(),
        kind: 'agent_error',
        message: stringValue(params.error.message) ?? display(params.error),
      },
    ];
  }
  if (method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : {};
    const events: NormalizedAgentEvent[] = [];
    if (turn.status === 'failed' && isRecord(turn.error)) {
      events.push({
        ...envelope(),
        kind: 'agent_error',
        message: stringValue(turn.error.message) ?? display(turn.error),
      });
    }
    events.push({
      ...envelope(),
      kind: 'turn_completed',
      ...(typeof turn.status === 'string' ? { stopReason: turn.status } : {}),
    });
    return events;
  }
  return [];
}
