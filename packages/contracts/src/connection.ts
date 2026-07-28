import { z } from 'zod';

export const ConnectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

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
