import { describe, expect, it } from 'vitest';
import {
  isExactSlashCommand,
  navigatePromptHistory,
  normalizeSlashCommandName,
} from '../src/workspaces/agents/ChatComposer';

describe('normalizeSlashCommandName', () => {
  it('keeps slash command names without a leading slash', () => {
    expect(normalizeSlashCommandName('compact')).toBe('compact');
  });

  it('removes every leading slash so the composer adds exactly one', () => {
    expect(normalizeSlashCommandName('/compact')).toBe('compact');
    expect(normalizeSlashCommandName('//compact')).toBe('compact');
  });

  it('distinguishes a partial command from an exact command', () => {
    const command = { name: '/compact', description: 'Compact context' };

    expect(isExactSlashCommand('/com', command)).toBe(false);
    expect(isExactSlashCommand('/compact', command)).toBe(true);
    expect(isExactSlashCommand('//compact', command)).toBe(false);
  });

});

describe('navigatePromptHistory', () => {
  const history = ['first prompt', 'second prompt', 'latest prompt'];

  it('recalls older prompts and stops at the oldest one', () => {
    expect(navigatePromptHistory(history, null, '', 'previous')).toEqual({
      index: 2,
      value: 'latest prompt',
    });
    expect(navigatePromptHistory(history, 2, '', 'previous')).toEqual({
      index: 1,
      value: 'second prompt',
    });
    expect(navigatePromptHistory(history, 0, '', 'previous')).toEqual({
      index: 0,
      value: 'first prompt',
    });
  });

  it('moves forward and restores the draft after the newest prompt', () => {
    expect(navigatePromptHistory(history, 1, 'unfinished', 'next')).toEqual({
      index: 2,
      value: 'latest prompt',
    });
    expect(navigatePromptHistory(history, 2, 'unfinished', 'next')).toEqual({
      index: null,
      value: 'unfinished',
    });
  });

  it('does nothing when there is no history or navigation has not started', () => {
    expect(navigatePromptHistory([], null, '', 'previous')).toBeNull();
    expect(navigatePromptHistory(history, null, '', 'next')).toBeNull();
  });
});
