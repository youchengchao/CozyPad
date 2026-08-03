import { z } from 'zod';

export const TerminalOpenRequestSchema = z.object({
  profileId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalOpenRequest = z.infer<typeof TerminalOpenRequestSchema>;

export const TerminalOpenedSchema = z.object({
  terminalId: z.string().min(1),
  /**
   * Bounded terminal output captured before the renderer attached. The
   * sequence lets a subscriber discard live events that are also present in
   * this replay.
   */
  replayDataBase64: z.string().optional(),
  replayThroughSequence: z.number().int().nonnegative().optional(),
});
export type TerminalOpened = z.infer<typeof TerminalOpenedSchema>;

export const TerminalInputSchema = z.object({
  terminalId: z.string().min(1),
  dataBase64: z.string(),
});
export type TerminalInput = z.infer<typeof TerminalInputSchema>;

export const TerminalResizeRequestSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;

export const TerminalCloseRequestSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalCloseRequest = z.infer<typeof TerminalCloseRequestSchema>;

export const TerminalOutputEventSchema = z.object({
  terminalId: z.string().min(1),
  dataBase64: z.string(),
  sequence: z.number().int().nonnegative().optional(),
});
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>;

export const TerminalClosedEventSchema = z.object({
  terminalId: z.string().min(1),
  exitCode: z.number().int().nullable().optional(),
  reason: z.string().optional(),
});
export type TerminalClosedEvent = z.infer<typeof TerminalClosedEventSchema>;
