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
  /** SPEC 1445: which side completes each command — CozyPad or the Agent. */
  slashCommandOwners: z
    .record(z.string(), z.enum(['cozypad', 'agent']))
    .optional(),
  /** SPEC 3.4.5: the header states whether a native conversation is bound. */
  conversationBound: z.boolean().optional(),
  /**
   * SPEC 3.4.5: how the last Resume relates to the native conversation —
   * continued the bound one, assumed a guessed one (SPEC 278: say so), or
   * started a new one.
   */
  resumeContinuity: z.enum(['continued', 'new', 'assumed']).optional(),
  updatedAt: z.string(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

const chatItemBase = {
  id: z.string().min(1),
  timestamp: z.string(),
};

/**
 * A session-owned file that was delivered with a user turn. The path remains
 * part of the transcript metadata so the renderer can lazily restore image
 * previews after an app restart without embedding multi-megabyte base64 data
 * in the session store.
 */
export const ChatAttachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().min(0),
  remotePath: z.string().min(1),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatMessageItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  streaming: z.boolean().optional(),
  /** SPEC 1321: the generation ended before this message received its End. */
  interrupted: z.boolean().optional(),
  attachments: z.array(ChatAttachmentSchema).max(10).optional(),
});
export type ChatMessageItem = z.infer<typeof ChatMessageItemSchema>;

export const ToolCallItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('tool_call'),
  name: z.string().min(1),
  summary: z.string(),
  /** `unknown`: the generation ended without reporting a result (SPEC 1323). */
  status: z.enum(['running', 'completed', 'error', 'unknown']),
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
  /** Which machine would run it (SPEC 2.9 requires the card to say). */
  machine: z.string().optional(),
  riskSummary: z.string(),
  /** `expired`: the execution generation that asked ended before an answer. */
  resolution: z.enum(['pending', 'allowed', 'denied', 'expired']).default('pending'),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;

export const UsageItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('usage'),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type UsageItem = z.infer<typeof UsageItemSchema>;

/**
 * A CozyPad-authored marker in the timeline — e.g. the boundary after a
 * Resume that did not continue the native conversation (SPEC 275-278). It is
 * visually distinct from agent output so the timeline never impersonates
 * agent memory.
 */
export const NoticeItemSchema = z.object({
  ...chatItemBase,
  kind: z.literal('notice'),
  text: z.string().min(1),
});
export type NoticeItem = z.infer<typeof NoticeItemSchema>;

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
  /** Empty only for unrepresentable questions, which render raw + decline. */
  options: z.array(QuestionOptionSchema).min(0).max(6),
  selectedIndex: z.number().int().min(0).nullable().default(null),
  /** Groups the questions of one agent request (SPEC 3.4.6 multi-question). */
  batchId: z.string().optional(),
  /** CozyPad cannot render this question type; raw content is in `prompt`. */
  unrepresentable: z.boolean().optional(),
  /** The whole request was declined by the user. */
  declined: z.boolean().optional(),
  /** The asking execution generation ended before every question was answered. */
  expired: z.boolean().optional(),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const ChatItemSchema = z.discriminatedUnion('kind', [
  ChatMessageItemSchema,
  ToolCallItemSchema,
  FileDiffItemSchema,
  ApprovalItemSchema,
  UsageItemSchema,
  QuestionItemSchema,
  NoticeItemSchema,
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;

export interface SlashCommand {
  name: string;
  description: string;
  behavior?: 'insert' | 'submit' | 'picker';
  /** Who completes it: CozyPad locally, or the Agent (SPEC 1445). */
  owner?: 'cozypad' | 'agent';
}
