import { z } from 'zod';

/** SSH host key 首次信任／變更警告（SPEC.md 6.1 已知缺口、SPEC_V3 13）。 */
export const HostKeyPromptEventSchema = z.object({
  requestId: z.string().min(1),
  profileId: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int(),
  keyType: z.string(),
  fingerprintSha256: z.string().min(1),
  status: z.enum(['new', 'changed']),
  previousFingerprint: z.string().optional(),
});
export type HostKeyPromptEvent = z.infer<typeof HostKeyPromptEventSchema>;

export const HostKeyDecisionSchema = z.object({
  requestId: z.string().min(1),
  accept: z.boolean(),
});
export type HostKeyDecision = z.infer<typeof HostKeyDecisionSchema>;
