import type { AgyRecoveredTurn } from '@cozypad/contracts';

/** Retry gaps after AGY returns to its prompt; its SQLite write can lag the TUI. */
export const AGY_TRANSCRIPT_SYNC_DELAYS_MS = [0, 200, 600, 1_500, 3_000] as const;

export function normalizeAgyTranscriptPrompt(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

/** Select only the canonical reply belonging to the prompt just submitted. */
export function canonicalAgyAssistantText(
  turns: readonly AgyRecoveredTurn[],
  expectedPrompt: string,
): string | null {
  const expected = normalizeAgyTranscriptPrompt(expectedPrompt);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (normalizeAgyTranscriptPrompt(turn.prompt) !== expected) continue;
    return turn.assistantText.trim() === '' ? null : turn.assistantText;
  }
  return null;
}