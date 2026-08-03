import { describe, expect, it } from 'vitest';
import { buildClaudeStreamingArgv } from '../src/command';

describe('buildClaudeStreamingArgv', () => {
  it('uses print mode for bidirectional stream-json sessions', () => {
    expect(buildClaudeStreamingArgv()).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ]);
  });

  it('resumes a bound conversation when reviving a session', () => {
    expect(
      buildClaudeStreamingArgv({ resumeConversationId: 'conv-42' }),
    ).toEqual(expect.arrayContaining(['--resume', 'conv-42']));
    expect(buildClaudeStreamingArgv()).not.toContain('--resume');
  });

  it('passes through Claude-specific permission mode names', () => {
    expect(buildClaudeStreamingArgv({ permissionMode: 'acceptEdits' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits']),
    );
    expect(buildClaudeStreamingArgv({ permissionMode: 'plan' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'plan']),
    );
  });
});
