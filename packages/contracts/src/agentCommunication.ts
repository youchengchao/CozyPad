import { z } from 'zod';
import {
  AgentInteractionModeSchema,
  AgentKindSchema,
  AgentSessionSummarySchema,
  ChatItemSchema,
} from './chat';

export const RemoteHostEnvironmentSchema = z.object({
  osName: z.string().min(1),
  distribution: z.string().min(1).optional(),
  kernelRelease: z.string().min(1).optional(),
  architecture: z.string().min(1).optional(),
  loginShell: z.string().min(1).optional(),
});
export type RemoteHostEnvironment = z.infer<typeof RemoteHostEnvironmentSchema>;

export const AgentLaunchModeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(['normal', 'elevated', 'dangerous']),
});
export type AgentLaunchMode = z.infer<typeof AgentLaunchModeSchema>;

export const AgentInstallationSchema = z.object({
  agentKind: AgentKindSchema,
  installed: z.boolean(),
  executablePath: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  installationScope: z.enum(['user', 'system', 'unknown']).optional(),
  environment: RemoteHostEnvironmentSchema.optional(),
  supportsStructuredOutput: z.boolean(),
  supportsResume: z.boolean(),
  supportsInteractiveApproval: z.boolean(),
  supportsDangerouslySkipPermissions: z.boolean().optional(),
  launchModes: z.array(AgentLaunchModeSchema).default([]),
  detail: z.string().optional(),
});
export type AgentInstallation = z.infer<typeof AgentInstallationSchema>;

export const AgentDetectionRequestSchema = z.object({
  profileId: z.string().min(1),
  agentKind: AgentKindSchema,
});
export type AgentDetectionRequest = z.infer<typeof AgentDetectionRequestSchema>;

export const AgentSessionListRequestSchema = z.object({
  profileId: z.string().min(1),
});
export type AgentSessionListRequest = z.infer<typeof AgentSessionListRequestSchema>;

export const CreateAgentSessionRequestSchema = z.object({
  profileId: z.string().min(1),
  agentKind: AgentKindSchema,
  cwd: z.string().trim().min(1),
  interactionMode: AgentInteractionModeSchema.optional(),
  title: z.string().trim().min(1).max(160).optional(),
  launchMode: z.string().trim().min(1).optional(),
  /** @deprecated Read only for persisted callers created before launchMode. */
  permissionMode: z.enum(['prompt', 'dangerouslySkip']).optional(),
});
export type CreateAgentSessionRequest = z.infer<typeof CreateAgentSessionRequestSchema>;

export const RenameAgentSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
});
export type RenameAgentSessionRequest = z.infer<typeof RenameAgentSessionRequestSchema>;

export const AgentSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type AgentSessionRequest = z.infer<typeof AgentSessionRequestSchema>;

export const AgentTerminalOpenRequestSchema = AgentSessionRequestSchema.extend({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type AgentTerminalOpenRequest = z.infer<
  typeof AgentTerminalOpenRequestSchema
>;

export const MAX_AGENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const AgentAttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().min(0).max(MAX_AGENT_ATTACHMENT_BYTES),
  remotePath: z.string().min(1),
});
export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;

export const UploadAgentAttachmentRequestSchema = AgentSessionRequestSchema.extend({
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(160).default('application/octet-stream'),
  dataBase64: z
    .string()
    .max(Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4 + 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});
export type UploadAgentAttachmentRequest = z.infer<
  typeof UploadAgentAttachmentRequestSchema
>;

/**
 * A turn recovered from the agent's own conversation store, used to restore
 * the visible transcript after a session is revived across an app restart.
 */
export const AgyRecoveredTurnSchema = z.object({
  prompt: z.string(),
  assistantText: z.string(),
});
export type AgyRecoveredTurn = z.infer<typeof AgyRecoveredTurnSchema>;

export const AgyTranscriptSchema = z.object({
  turns: z.array(AgyRecoveredTurnSchema).max(200),
});
export type AgyTranscript = z.infer<typeof AgyTranscriptSchema>;

export const SendAgentMessageRequestSchema = AgentSessionRequestSchema.extend({
  text: z.string().trim(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
}).superRefine((request, context) => {
  if (request.text === '' && request.attachmentIds.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'A message needs text or at least one attachment',
      path: ['text'],
    });
  }
});
export type SendAgentMessageRequest = z.infer<typeof SendAgentMessageRequestSchema>;

export const ResolveAgentApprovalRequestSchema = AgentSessionRequestSchema.extend({
  itemId: z.string().min(1),
  resolution: z.enum(['allowed', 'denied']),
});
export type ResolveAgentApprovalRequest = z.infer<
  typeof ResolveAgentApprovalRequestSchema
>;

export const AnswerAgentQuestionRequestSchema = AgentSessionRequestSchema.extend({
  itemId: z.string().min(1),
  optionIndex: z.number().int().min(0),
});
export type AnswerAgentQuestionRequest = z.infer<
  typeof AnswerAgentQuestionRequestSchema
>;

export const AgentSessionBundleSchema = z.object({
  session: AgentSessionSummarySchema,
  items: z.array(ChatItemSchema),
});
export type AgentSessionBundle = z.infer<typeof AgentSessionBundleSchema>;

export const AgentSessionChangedEventSchema = z.object({
  session: AgentSessionSummarySchema,
});
export type AgentSessionChangedEvent = z.infer<
  typeof AgentSessionChangedEventSchema
>;

export const AgentSessionDeletedEventSchema = z.object({
  sessionId: z.string().min(1),
  agentKind: AgentKindSchema,
});
export type AgentSessionDeletedEvent = z.infer<
  typeof AgentSessionDeletedEventSchema
>;

/** 完整 timeline snapshot；renderer 直接 replace，避免 delta 重播造成重複卡片。 */
export const AgentTimelineChangedEventSchema = z.object({
  sessionId: z.string().min(1),
  items: z.array(ChatItemSchema),
});
export type AgentTimelineChangedEvent = z.infer<
  typeof AgentTimelineChangedEventSchema
>;

export const AgentCommunicationErrorEventSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type AgentCommunicationErrorEvent = z.infer<
  typeof AgentCommunicationErrorEventSchema
>;
