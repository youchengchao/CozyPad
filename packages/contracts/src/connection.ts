import { z } from 'zod';

export const ConnectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  /** 是否已有記憶的密碼（derived；密碼本身永不離開 main process）。 */
  hasPassword: z.boolean().optional(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

/** 新增／編輯 profile 的單向 payload；password 只送往 main，不會回流。 */
export const ConnectionProfileDraftSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  password: z.string().optional(),
  rememberPassword: z.boolean().default(false),
});
export type ConnectionProfileDraft = z.infer<typeof ConnectionProfileDraftSchema>;

export const DeleteProfileRequestSchema = z.object({
  profileId: z.string().min(1),
});
export type DeleteProfileRequest = z.infer<typeof DeleteProfileRequestSchema>;

export const ConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'error',
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ConnectRequestSchema = z.object({
  profileId: z.string().min(1),
});
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

export const ConnectionStateChangedSchema = z.object({
  profileId: z.string().min(1),
  state: ConnectionStateSchema,
  error: z.string().optional(),
});
export type ConnectionStateChanged = z.infer<typeof ConnectionStateChangedSchema>;
