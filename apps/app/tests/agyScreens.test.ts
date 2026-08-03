import { describe, expect, it } from 'vitest';
import {
  parseAgyKeyHints,
  readAgyStatus,
  recogniseAgyScreen,
  type AgyModelPickerScreen,
  type AgySessionPickerScreen,
} from '../src/workspaces/agents/agyScreens';
import {
  AGENT_PICKER,
  CONTEXT_REPORT,
  HOME,
  MODEL_PICKER_HIGH,
  MODEL_PICKER_MEDIUM,
  MODEL_PICKER_OTHER_MODEL,
  PERMISSION_SCOPES,
  QUOTA_REPORT,
  SESSION_PICKER,
} from './fixtures/agyScreens';

describe('AGY overlay recognition', () => {
  it('reads the keys each overlay advertises instead of assuming them', () => {
    // Hard-coding these would drift the moment AGY changes a binding.
    expect(parseAgyKeyHints(MODEL_PICKER_HIGH)).toEqual([
      { label: '↑/↓', action: 'Navigate' },
      { label: '←/→', action: 'Effort' },
      { label: 'enter', action: 'Select' },
      { label: 'esc', action: 'Go Back' },
    ]);
    expect(parseAgyKeyHints(SESSION_PICKER)).toEqual(
      expect.arrayContaining([
        { label: 'f2', action: 'Rename' },
        { label: 'ctrl+delete', action: 'Delete' },
        { label: 'tab', action: 'Switch Tab' },
      ]),
    );
  });

  it('leaves an ordinary conversation screen unrecognised', () => {
    // The generic surface must keep handling anything without an overlay.
    expect(recogniseAgyScreen(HOME)).toBeNull();
  });

  describe('model picker', () => {
    it('separates the model list from the effort gauge', () => {
      const screen = recogniseAgyScreen(MODEL_PICKER_HIGH) as AgyModelPickerScreen;

      expect(screen.kind).toBe('modelPicker');
      expect(screen.models.map((model) => model.label)).toEqual([
        'Gemini 3.6 Flash',
        'Gemini 3.5 Flash',
        'Gemini 3.1 Pro',
        'Claude Sonnet 4.6',
        'Claude Opus 4.6',
        'GPT-OSS 120B',
      ]);
      // `(current)` and `(Thinking)` are data, not part of the name.
      expect(screen.models[0]).toMatchObject({ current: true, focused: true });
      expect(screen.models[3]?.qualifier).toBe('Thinking');
      expect(screen.effort).toMatchObject({
        levels: ['low', 'medium', 'high'],
        selectedIndex: 2,
        description: 'Deepest reasoning for complex problems — slower but strongest',
      });
    });

    it('tracks the gauge position as the level changes', () => {
      const medium = recogniseAgyScreen(MODEL_PICKER_MEDIUM) as AgyModelPickerScreen;

      expect(medium.effort?.selectedIndex).toBe(1);
      expect(medium.effort?.description).toBe(
        'Balanced speed and reasoning quality for most tasks',
      );
    });

    it('follows the focused model, whose effort is its own', () => {
      const moved = recogniseAgyScreen(
        MODEL_PICKER_OTHER_MODEL,
      ) as AgyModelPickerScreen;

      expect(moved.models[1]).toMatchObject({
        label: 'Gemini 3.5 Flash',
        focused: true,
        current: false,
      });
      expect(moved.models[0]).toMatchObject({ current: true, focused: false });
      // Moving the cursor showed that model's stored effort, not the previous one.
      expect(moved.effort?.selectedIndex).toBe(0);
    });

    it('lists each model once, whatever a partial redraw left on screen', () => {
      // Captured shape from a live session with a Claude model current: no
      // Effort row after the list, a stale copy of a row below it, and the
      // persistent status footer further down.
      const screen = recogniseAgyScreen([
        'Switch Model',
        '',
        '  Gemini 3.6 Flash',
        '  Gemini 3.5 Flash',
        '  Gemini 3.1 Pro',
        '  Claude Sonnet 4.6 (Thinking) (current)',
        '  Claude Opus 4.6 (Thinking)',
        '> GPT-OSS 120B (Medium)',
        '  Claude Sonnet 4.6 (Thinking)',
        '',
        'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back',
        '',
        '                                             Claude Sonnet 4.6 · thinking ',
      ]) as AgyModelPickerScreen;

      expect(screen.models.map((model) => model.label)).toEqual([
        'Gemini 3.6 Flash',
        'Gemini 3.5 Flash',
        'Gemini 3.1 Pro',
        'Claude Sonnet 4.6',
        'Claude Opus 4.6',
        'GPT-OSS 120B',
      ]);
      // The stale duplicate's marks still land on the one real row.
      expect(screen.models[3]).toMatchObject({
        label: 'Claude Sonnet 4.6',
        qualifier: 'Thinking',
        current: true,
      });
      expect(screen.models[5]).toMatchObject({
        label: 'GPT-OSS 120B',
        focused: true,
      });
    });
  });

  it('breaks a conversation row into its columns', () => {
    const screen = recogniseAgyScreen(SESSION_PICKER) as AgySessionPickerScreen;

    expect(screen.kind).toBe('sessionPicker');
    expect(screen.rows[0]).toMatchObject({
      title: 'Request For Platform Assistance',
      steps: 8,
      age: '5h ago',
      focused: true,
    });
    // Step count and age used to end up glued onto the title.
    expect(screen.rows[0]?.title).not.toContain('steps');
    expect(screen.rows[2]).toMatchObject({
      title: 'Git Usage Documentation Path',
      workspace: 'usagework',
      steps: 14,
    });
    expect(screen.search).toBe('');
    expect(screen.tabs.map((tab) => tab.label)).toEqual(['CLI', 'Antigravity']);
  });

  it('reads the permission scope stage with its explanation', () => {
    const screen = recogniseAgyScreen(PERMISSION_SCOPES);

    expect(screen).toMatchObject({
      kind: 'permissionScopes',
      prompt: 'Select a config scope to edit:',
      description: 'Rules that apply only to this project (highest priority)',
    });
    expect(
      screen?.kind === 'permissionScopes'
        ? screen.scopes.map((scope) => scope.label)
        : [],
    ).toEqual(['Project', 'Shared with Antigravity', 'Global']);
  });

  it('turns context usage into numbers a chart can use', () => {
    const screen = recogniseAgyScreen(CONTEXT_REPORT);

    expect(screen?.kind).toBe('contextReport');
    if (screen?.kind !== 'contextReport') return;
    expect(screen.summary).toContain('0/1.0M tokens');
    expect(screen.segments.map((segment) => segment.label)).toEqual([
      'User messages',
      'Agent responses',
      'Tool calls',
      'Free space',
    ]);
    expect(screen.segments.at(-1)).toMatchObject({
      amount: '1.0M',
      percent: 100,
    });
    expect(screen.related).toEqual(['/artifact', '/skill', '/rewind']);
  });

  it('reads the quota report as groups with real numbers', () => {
    const screen = recogniseAgyScreen(QUOTA_REPORT);

    // Rendered as text this became a wall of broken bar glyphs in a bubble.
    expect(screen?.kind).toBe('quotaReport');
    if (screen?.kind !== 'quotaReport') return;
    expect(screen.account).toBe('user@example.com');
    expect(screen.groups.map((group) => group.name)).toEqual([
      'GEMINI MODELS',
      'CLAUDE AND GPT MODELS',
    ]);
    expect(screen.groups[0]?.members).toBe('Gemini Flash, Gemini Pro');
    expect(screen.groups[0]?.limits).toEqual([
      {
        label: 'Weekly Limit',
        percent: 97.79,
        note: '98% remaining · Refreshes in 45h 28m',
      },
      {
        label: 'Five Hour Limit',
        percent: 98.23,
        note: '98% remaining · Refreshes in 2h 8m',
      },
    ]);
    expect(screen.groups[1]?.limits[0]).toMatchObject({
      percent: 100,
      note: 'Quota available',
    });
    expect(screen.footnote).toContain('models share a weekly limit');
  });

  it('offers the quota screen its own scroll keys', () => {
    expect(parseAgyKeyHints(QUOTA_REPORT)).toEqual(
      expect.arrayContaining([
        { label: '↑/↓', action: 'Scroll' },
        { label: 'esc', action: 'Close' },
      ]),
    );
  });

  describe('status line', () => {
    it('reads model and effort from the footer every screen carries', () => {
      expect(readAgyStatus(HOME)).toMatchObject({
        model: 'Gemini 3.6 Flash',
        effort: 'hig',
      });
    });

    it('takes context usage from the screen that reports it', () => {
      const status = readAgyStatus(CONTEXT_REPORT);

      expect(status.model).toBe('Gemini 3.6 Flash');
      expect(status.effort).toBe('high');
      expect(status.contextSummary).toBe('0/1.0M tokens');
      // Derived from free space, which is what the screen actually states.
      expect(status.contextUsedPercent).toBe(0);
    });

    it('reads both rate limits from a quota report', () => {
      const status = readAgyStatus([
        '  Models & Quota',
        '',
        '  Weekly Limit',
        '  [█████████████████████████████████████████████████░] 98.13%',
        '  98% remaining · Refreshes in 51h 54m',
        '',
        '  Five Hour Limit',
        '  [████████████████████████████████████████████████░░] 96.10%',
        '  96% remaining · Refreshes in 1h 31m',
      ]);

      expect(status.limits).toEqual([
        {
          label: 'Weekly Limit',
          remainingPercent: 98,
          note: 'Refreshes in 51h 54m',
        },
        {
          label: 'Five Hour Limit',
          remainingPercent: 96,
          note: 'Refreshes in 1h 31m',
        },
      ]);
    });

    it('keeps quota groups in the compact status labels', () => {
      expect(readAgyStatus(QUOTA_REPORT).limits?.map((limit) => limit.label)).toEqual([
        'Gemini · Weekly Limit',
        'Gemini · Five Hour Limit',
        'Claude / GPT · Weekly Limit',
        'Claude / GPT · Five Hour Limit',
      ]);
    });

    it('reports only what a screen shows, so merging never erases a field', () => {
      // The model picker says nothing about quota; returning zeros here would
      // blank the header every time the user opened it.
      const status = readAgyStatus(MODEL_PICKER_HIGH);

      expect(status.limits).toBeUndefined();
      expect(status.contextUsedPercent).toBeUndefined();
    });
  });

  it('marks which agent is active', () => {
    const screen = recogniseAgyScreen(AGENT_PICKER);

    expect(screen?.kind).toBe('agentPicker');
    if (screen?.kind !== 'agentPicker') return;
    expect(screen.agents[0]).toMatchObject({
      label: 'default',
      description: 'Default agent',
      active: true,
      focused: true,
    });
  });
});
