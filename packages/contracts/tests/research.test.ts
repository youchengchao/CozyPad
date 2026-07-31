import { describe, expect, it } from 'vitest';
import {
  InvalidRunTransitionError,
  RESEARCH_RUN_TRANSITIONS,
  RunHeartbeatSchema,
  isTerminalRunState,
  validateRunTransition,
} from '../src/research';

describe('validateRunTransition', () => {
  it('allows every declared transition', () => {
    for (const [from, targets] of Object.entries(RESEARCH_RUN_TRANSITIONS)) {
      for (const to of targets) {
        expect(() => validateRunTransition(from, to)).not.toThrow();
      }
    }
  });

  it('is idempotent for same-state writes, including terminal states', () => {
    expect(() => validateRunTransition('completed', 'completed')).not.toThrow();
    expect(() => validateRunTransition('running', 'running')).not.toThrow();
  });

  it('rejects transitions out of terminal states with a hint', () => {
    expect(() => validateRunTransition('completed', 'running')).toThrow(
      /terminal state/,
    );
  });

  it('rejects undeclared transitions and names the source', () => {
    try {
      validateRunTransition('draft', 'running', 'runner');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRunTransitionError);
      expect(String(error)).toContain('source=runner');
      expect(String(error)).toContain("allowed from 'draft'");
    }
  });

  it('rejects unknown states', () => {
    expect(() => validateRunTransition('zombie', 'running')).toThrow(/unknown state/);
  });

  it('lost can be reconciled back to running but never straight to completed', () => {
    expect(() => validateRunTransition('lost', 'running')).not.toThrow();
    expect(() => validateRunTransition('lost', 'completed')).toThrow();
  });

  it('failed can only requeue', () => {
    expect(() => validateRunTransition('failed', 'queued')).not.toThrow();
    expect(() => validateRunTransition('failed', 'running')).toThrow();
  });
});

describe('terminal states', () => {
  it('only completed and cancelled are terminal', () => {
    expect(isTerminalRunState('completed')).toBe(true);
    expect(isTerminalRunState('cancelled')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(false);
    expect(isTerminalRunState('lost')).toBe(false);
  });
});

describe('RunHeartbeatSchema', () => {
  it('accepts a live heartbeat and a lost-pid heartbeat', () => {
    expect(
      RunHeartbeatSchema.parse({
        runId: 'run-1',
        at: '2026-07-29T12:00:00Z',
        pid: 41233,
        elapsedSeconds: 120,
      }).pid,
    ).toBe(41233);
    expect(
      RunHeartbeatSchema.parse({
        runId: 'run-1',
        at: '2026-07-29T12:00:05Z',
        pid: null,
        elapsedSeconds: 125,
      }).pid,
    ).toBeNull();
  });
});
