import { z } from 'zod';
import { AgentKindSchema } from './chat';

/** SPEC_V3 §7.1：所有 adapter 必須輸出的一致事件。共同 envelope 欄位。 */
const envelope = {
  eventId: z.string().min(1),
  sequence: z.number().int().min(0),
  localSessionId: z.string().min(1),
  agentKind: AgentKindSchema,
  agentConversationId: z.string().optional(),
  timestamp: z.string(),
  rawEventVersion: z.string().optional(),
};

function event<K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({ ...envelope, kind: z.literal(kind), ...shape });
}

export const NormalizedAgentEventSchema = z.discriminatedUnion('kind', [
  /**
   * adapter 取得 conversation ID 的初始化事件（SPEC_V3 §5.3 步驟 3-4）；
   * conversation ID 走 envelope 的 agentConversationId 欄位。
   */
  event('session_initialized', {
    model: z.string().optional(),
    cwd: z.string().optional(),
    slashCommands: z.array(z.string().min(1)).optional(),
  }),
  event('user_message', { text: z.string() }),
  event('assistant_message_started', {}),
  event('assistant_text_delta', { text: z.string() }),
  event('assistant_message_completed', { text: z.string() }),
  event('activity', { label: z.string() }),
  event('tool_call_started', {
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    inputSummary: z.string(),
  }),
  event('tool_call_updated', { toolCallId: z.string().min(1), update: z.string() }),
  event('tool_call_completed', {
    toolCallId: z.string().min(1),
    output: z.string(),
    isError: z.boolean(),
  }),
  event('approval_requested', {
    approvalId: z.string().min(1),
    command: z.string(),
    riskSummary: z.string(),
  }),
  event('approval_resolved', {
    approvalId: z.string().min(1),
    resolution: z.enum(['allowed', 'denied']),
  }),
  event('question_requested', {
    questionId: z.string().min(1),
    prompt: z.string().min(1),
    /**
     * Empty options are only valid together with `unrepresentable`: the card
     * then shows the raw request and offers decline (SPEC 3.4.6) instead of
     * being silently dropped while the agent waits for an answer.
     */
    options: z
      .array(
        z.object({
          label: z.string().min(1),
          description: z.string().optional(),
        }),
      )
      .min(0)
      .max(6),
    unrepresentable: z.boolean().optional(),
  }),
  event('question_resolved', {
    questionId: z.string().min(1),
    selectedIndex: z.number().int().min(0),
  }),
  event('file_diff', {
    path: z.string().min(1),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    diff: z.string(),
  }),
  event('command_output', { output: z.string() }),
  event('usage', {
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.number().optional(),
  }),
  event('turn_completed', { stopReason: z.string().optional() }),
  event('agent_error', { message: z.string() }),
]);
export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;
export type NormalizedAgentEventKind = NormalizedAgentEvent['kind'];
