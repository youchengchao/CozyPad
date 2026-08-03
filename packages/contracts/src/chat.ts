import { z } from 'zod';

export const AgentKindSchema = z.enum(['claude', 'codex', 'agy']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/** SPEC_V3 5.2 的 session 狀態。 */
export const AgentSessionStatusSchema = z.enum([
  'starting',
  'ready',
  'running',
  'waiting_approval',
  'disconnected',
  'exited',
  'error',
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const AgentInteractionModeSchema = z.enum(['chat', 'terminal']);
export type AgentInteractionMode = z.infer<typeof AgentInteractionModeSchema>;

export const AgentSessionSummarySchema = z.object({
  id: z.string().min(1),
  agentKind: AgentKindSchema,
  title: z.string().min(1),
  host: z.string().min(1),
  project: z.string().min(1),
  cwd: z.string().min(1),
  interactionMode: AgentInteractionModeSchema.optional(),
  status: AgentSessionStatusSchema,
  unread: z.number().int().min(0).default(0),
  slashCommands: z.array(z.string().trim().min(1)).default([]),
  slashCommandDescriptions: z.record(z.string(), z.string()).optional(),
  slashCommandBehaviors: z
    .record(z.string(), z.enum(['insert', 'submit', 'picker']))
    .optional(),
  updatedAt: z.string(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

const chatItemBase = {
  id: z.string().min(1),
  timestamp: z.string(),
};

export const ChatMessageItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  streaming: z.boolean().optional(),
});
export type ChatMessageItem = z.infer<typeof ChatMessageItemSchema>;

export const ToolCallItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('tool_call'),
  name: z.string().min(1),
  summary: z.string(),
  status: z.enum(['running', 'completed', 'error']),
  output: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ToolCallItem = z.infer<typeof ToolCallItemSchema>;

export const FileDiffItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('file_diff'),
  path: z.string().min(1),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  diff: z.string(),
});
export type FileDiffItem = z.infer<typeof FileDiffItemSchema>;

export const ApprovalItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('approval'),
  command: z.string().min(1),
  cwd: z.string().min(1),
  riskSummary: z.string(),
  resolution: z.enum(['pending', 'allowed', 'denied']).default('pending'),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;

export const UsageItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('usage'),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type UsageItem = z.infer<typeof UsageItemSchema>;

export const QuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** Agent 問答機制：agent 丟出選項，使用者點選後回傳（類 Claude AskUserQuestion）。 */
export const QuestionItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('question'),
  prompt: z.string().min(1),
  options: z.array(QuestionOptionSchema).min(2).max(6),
  selectedIndex: z.number().int().min(0).nullable().default(null),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const ChatItemSchema = z.discriminatedUnion('kind', [
  ChatMessageItemSchema,
  ToolCallItemSchema,
  FileDiffItemSchema,
  ApprovalItemSchema,
  UsageItemSchema,
  QuestionItemSchema,
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;

export interface SlashCommand {
  name: string;
  description: string;
  behavior?: 'insert' | 'submit' | 'picker';
}
