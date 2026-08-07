import { describe, expect, it } from 'vitest';
import {
  AGY_TRANSCRIPT_SYNC_DELAYS_MS,
  canonicalAgyAssistantText,
  normalizeAgyTranscriptPrompt,
} from '../src/workspaces/agents/agyTranscriptSync';

describe('AGY canonical transcript sync', () => {
  it('matches the submitted prompt after newline normalization', () => {
    expect(normalizeAgyTranscriptPrompt('  first\r\nsecond  ')).toBe('first\nsecond');
    expect(
      canonicalAgyAssistantText(
        [{ prompt: 'first\nsecond', assistantText: '```mermaid\nA-->B\n```' }],
        'first\r\nsecond',
      ),
    ).toBe('```mermaid\nA-->B\n```');
  });

  it('rejects unrelated or incomplete transcript turns', () => {
    expect(
      canonicalAgyAssistantText(
        [{ prompt: 'another prompt', assistantText: 'private reply' }],
        'expected prompt',
      ),
    ).toBeNull();
    expect(
      canonicalAgyAssistantText(
        [{ prompt: 'expected prompt', assistantText: '' }],
        'expected prompt',
      ),
    ).toBeNull();
  });

  it('allows enough retries for a delayed local store flush', () => {
    expect(AGY_TRANSCRIPT_SYNC_DELAYS_MS.reduce<number>((sum, delay) => sum + delay, 0)).toBe(
      5_300,
    );
  });
});