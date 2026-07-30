import { z } from 'zod';

export const AuthenticationMethodSchema = z.enum(['password', 'privateKey']);
export type AuthenticationMethod = z.infer<typeof AuthenticationMethodSchema>;

export const ConnectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  /** Profiles created before key authentication existed remain password profiles. */
  authMethod: AuthenticationMethodSchema.default('password'),
  /** 是否已有記憶的密碼（derived；密碼本身永不離開 main process）。 */
  hasPassword: z.boolean().optional(),
  /** Whether a private key is currently available in secure or transient storage. */
  hasPrivateKey: z.boolean().optional(),
  /** True only when the active credential is persisted in OS-protected storage. */
  credentialPersisted: z.boolean().optional(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

/**
 * One-way profile payload. Secrets only travel toward the privileged bridge and
 * are never returned to the renderer. rememberPassword is accepted as a
 * backwards-compatible input alias but is normalized to rememberCredential.
 */
export const ConnectionProfileDraftSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    authMethod: AuthenticationMethodSchema.default('password'),
    password: z.string().max(4096).optional(),
    privateKey: z.string().max(131_072).optional(),
    passphrase: z.string().max(4096).optional(),
    rememberCredential: z.boolean().optional(),
    rememberPassword: z.boolean().optional(),
  })
  .transform(({ rememberPassword, rememberCredential, ...draft }) => ({
    ...draft,
    rememberCredential: rememberCredential ?? rememberPassword ?? false,
  }));
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
