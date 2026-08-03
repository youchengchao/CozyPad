import { describe, expect, it } from 'vitest';
import {
  agyKeySequence,
  agyOptionSelectionSequence,
  agyPromptSequence,
  deriveAgyScreenModel,
  extractAgyAssistantText,
  isAgyComposerEditable,
  isStaleAgyReplyCandidate,
  mayScrapeAgyReply,
  normalizeAgyScreenLines,
} from '../src/workspaces/agents/agyTerminalModel';
import { MODEL_PICKER_HIGH, QUOTA_REPORT } from './fixtures/agyScreens';

describe('mayScrapeAgyReply', () => {
  it('never lets a slash command grow a reply bubble', () => {
    // Its screen — a picker, a report — is answered by the typed overlay;
    // scraping it showed the same content twice.
    expect(mayScrapeAgyReply('/usage', ['Some plain reply text'])).toBe(false);
    expect(mayScrapeAgyReply('  /model', ['Some plain reply text'])).toBe(false);
  });

  it('keeps overlay screens out of whatever turn happens to be latest', () => {
    expect(mayScrapeAgyReply('train the model', QUOTA_REPORT)).toBe(false);
    expect(mayScrapeAgyReply('train the model', MODEL_PICKER_HIGH)).toBe(false);
  });

  it('scrapes ordinary reply frames', () => {
    expect(
      mayScrapeAgyReply('train the model', [
        '> train the model',
        'Working through the training script now.',
      ]),
    ).toBe(true);
  });

  it('does not copy the previous reply into a newly submitted turn', () => {
    const staleFrame = [
      '> first request',
      'The first answer.',
      '',
      '> ',
    ];
    expect(mayScrapeAgyReply('second request', staleFrame)).toBe(false);
    expect(mayScrapeAgyReply('second request', staleFrame, 'Partial second answer')).toBe(
      true,
    );
  });
});

describe('isStaleAgyReplyCandidate', () => {
  it('rejects a previous answer only during the empty first frame of a running turn', () => {
    expect(
      isStaleAgyReplyCandidate('old answer', ['old answer'], true),
    ).toBe(true);
    expect(
      isStaleAgyReplyCandidate('old answer', ['old answer'], false),
    ).toBe(false);
    expect(
      isStaleAgyReplyCandidate('old answer', ['old answer'], true, 'new partial'),
    ).toBe(false);
  });
});

describe('AGY terminal-to-UI model', () => {
  it('turns the native AGY welcome selection into clickable options', () => {
    const model = deriveAgyScreenModel([
      '\u001b[38;5;141mAGY 1.1.9\u001b[0m  Native CLI · /workspace',
      '',
      '\u001b[38;5;141m❯ Start a task\u001b[0m',
      '  Resume a conversation',
      '  Review settings',
      '',
      '↑/↓ move · Enter select · Ctrl+C exit',
    ]);

    expect(model.mode).toBe('welcome');
    expect(model.options.map((option) => option.label)).toEqual([
      'Start a task',
      'Resume a conversation',
      'Review settings',
    ]);
    expect(model.selectedIndex).toBe(0);
    expect(model.rawLines.join('\n')).not.toContain('\u001b');
  });

  it('turns an in-conversation multiple-choice question into keyed options', () => {
    // Shape captured from a live AGY question card: the focused row carries
    // the `>` marker, and the question ends with a full-width `？`.
    const model = deriveAgyScreenModel([
      '> 擬出個謎題讓我做選擇題',
      '',
      '? 我沒有生命，但會成長；我沒有肺，但需要空氣；我沒有嘴，但水會殺死我。我是什麼？',
      '',
      'Question',
      '',
      'Question 1/1: 我沒有生命，但會成長；我沒有肺，但需要空氣；我沒有嘴，但水會殺死我。我是什麼？',
      '',
      '> 1. 種子 (Seed)',
      '  2. 樹 (Tree)',
      '  3. 雲 (Cloud)',
      '  4. 影子 (Shadow)',
      '  5. Write-in...',
      '',
    ]);

    expect(model.options.map((option) => option.shortcut)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(model.options[0]).toMatchObject({
      label: '種子 (Seed)',
      selected: true,
    });
    // A decision put to the user — not AGY asking to be allowed something.
    expect(model.mode).toBe('question');

    // The card shows the choices; the reply bubble must not repeat them.
    const reply = extractAgyAssistantText(model, '擬出個謎題讓我做選擇題');
    expect(reply).toContain('我是什麼');
    expect(reply).not.toContain('樹 (Tree)');
    expect(reply).not.toContain('種子');
  });

  it('offers only the numbered answers, never the echo of the user prompt', () => {
    // With a navigation hint on screen the marker heuristics run too; the
    // `>`-prefixed echo of the user's own message must still not become a
    // clickable answer, and the focused row must not appear twice.
    const model = deriveAgyScreenModel([
      '> 出個謎題讓我做選擇題',
      '',
      '? 經典謎題：什麼東西早上用四條腿走路，中午用兩條腿走路，晚上用三條腿走路？',
      '',
      'Question 1/1: 經典謎題：什麼東西早上用四條腿走路，中午用兩條腿走路，晚上用三條腿走路？',
      '',
      '  1. 猩猩 (Chimpanzee)',
      '> 2. 人 (Human)',
      '  3. 變色龍 (Chameleon)',
      '  4. 時間 (Time)',
      '  5. Write-in...',
      '',
      '↑/↓ Navigate · enter Select · esc Cancel',
    ]);

    expect(model.options.map((option) => option.label)).toEqual([
      '猩猩 (Chimpanzee)',
      '人 (Human)',
      '變色龍 (Chameleon)',
      '時間 (Time)',
      'Write-in...',
    ]);
    expect(model.options[1]).toMatchObject({ selected: true, shortcut: '2' });
    expect(model.mode).toBe('question');
  });

  it('keeps bullet-point lists inside a reply', () => {
    const model = deriveAgyScreenModel([
      '> 出個謎題讓我做選擇題',
      '',
      '  恭喜你，答對了！',
      '',
      '  解析：',
      '  • 「早上」代表人的嬰兒時期，用手和腳爬行（四條腿）。',
      '  • 「中午」代表人的青年與中年時期（兩條腿）。',
      '',
      '────────────────────────────────────────────────────────────────',
      '>',
      '? for shortcuts                                  Gemini 3.5 Flash · medium',
    ]);

    const reply = extractAgyAssistantText(model, '出個謎題讓我做選擇題');
    expect(reply).toContain('• 「早上」');
    expect(reply).toContain('• 「中午」');
  });

  it('recognizes radio-style menus and preserves their selected row', () => {
    const model = deriveAgyScreenModel([
      'Select model',
      '○ Gemini Flash',
      '◉ Gemini Pro',
      '○ Auto',
      '',
      '↑/↓ Navigate · enter Select',
    ]);

    expect(model.mode).toBe('viewer');
    expect(model.options).toHaveLength(3);
    expect(model.selectedIndex).toBe(1);
  });

  it('does not treat model names containing Thinking as active work', () => {
    const model = deriveAgyScreenModel([
      'Switch Model',
      '  Gemini 3.6 Flash',
      '> Gemini 3.5 Flash (current)',
      '  Claude Sonnet 4.6 (Thinking)',
      '  Claude Opus 4.6 (Thinking)',
      '',
      'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back',
    ]);

    expect(model.mode).toBe('viewer');
    expect(model.options.map((option) => option.label)).toContain(
      'Claude Sonnet 4.6 (Thinking)',
    );
  });

  it('recognizes a real CLI permission card and extracts its command', () => {
    const model = deriveAgyScreenModel([
      'Permission required',
      'AGY wants to run this command',
      'Command:',
      'npm test',
      '',
      '[y] Allow once',
      '[n] Deny',
    ]);

    expect(model.mode).toBe('approval');
    expect(model.approvalCommand).toBe('npm test');
    expect(model.statusText).toBe('Waiting for your decision');
    expect(model.options.map((option) => option.shortcut)).toEqual(['y', 'n']);
  });

  it('keeps AGY slash autocomplete as an interactive suggestion surface', () => {
    const model = deriveAgyScreenModel([
      'What would you like AGY to work on?',
      '> /mo',
      '  /model  Select the active model',
      '  /memory  Open memory controls',
      'Tab to complete · ↑↓ to navigate',
    ]);

    expect(model.mode).toBe('suggestions');
    expect(model.options.map((option) => option.command)).toEqual([
      '/model',
      '/memory',
    ]);
    expect(model.options[0]?.selected).toBe(false);
  });

  it('distinguishes streaming work from an idle prompt', () => {
    expect(
      deriveAgyScreenModel(['AGY', 'Thinking…', 'Esc to cancel']).mode,
    ).toBe('running');
    expect(
      deriveAgyScreenModel(['AGY', 'What should I work on?', '> ']).mode,
    ).toBe('prompt');
  });

  it('treats live tool rows as running until the bottom prompt returns', () => {
    expect(
      deriveAgyScreenModel(['AGY', '> inspect files', '● ListDir(/workspace)']).mode,
    ).toBe('running');
    expect(
      deriveAgyScreenModel([
        'AGY',
        '> inspect files',
        '● ListDir(/workspace)',
        '',
        '> ',
      ]).mode,
    ).toBe('prompt');
  });

  it('lets a live spinner outrank AGY\'s persistent empty input row', () => {
    expect(
      deriveAgyScreenModel([
        'AGY',
        '> inspect files',
        'ListDir(/workspace)',
        'Generating...',
        '> ',
      ]).mode,
    ).toBe('running');
  });

  it('extracts the active tools after a previous turn during a live redraw', () => {
    const prompt =
      'Inspect this directory carefully and keep working for at least 30 seconds before replying.';
    const model = deriveAgyScreenModel([
      '  ⎿  Model set to Gemini 3.6 Flash (Low)',
      '',
      '────────────────────────────────────────────────────────────',
      '> Reply with exactly FIRST_TOKEN',
      '',
      '  FIRST_TOKEN',
      '',
      '────────────────────────────────────────────────────────────',
      `> ${prompt}`,
      '',
      '● ListDir(D:/CozyPad)',
      '● Schedule(30s: 30 seconds have elapsed.) (ctrl+o to expand)',
      '⣻  Generating...',
      '└ Tip: Use /fork to branch the conversation from an earlier point.',
      '────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────',
      'esc to cancel · Gemini 3.6 Flash · low',
    ]);

    expect(model.mode).toBe('running');
    expect(extractAgyAssistantText(model, prompt)).not.toContain('FIRST_TOKEN');
    expect(extractAgyAssistantText(model, prompt)).toContain('ListDir');
  });

  it('does not mistake typed prompt text for a blocking menu option', () => {
    const model = deriveAgyScreenModel([
      'AGY 1.1.9',
      'What would you like AGY to work on?',
      '> fix the failing test',
    ]);

    expect(model.mode).toBe('prompt');
    expect(model.options).toEqual([]);
    expect(model.promptLineIndex).toBe(2);
  });

  it('removes terminal controls without erasing Unicode UI labels', () => {
    expect(
      normalizeAgyScreenLines(['\u001b[2J\u001b[H\u001b[35m❯ 開始任務\u001b[0m']),
    ).toEqual(['❯ 開始任務']);
  });

  it('encodes all navigation directions and interruption exactly', () => {
    expect(agyKeySequence('up')).toBe('\u001b[A');
    expect(agyKeySequence('down')).toBe('\u001b[B');
    expect(agyKeySequence('left')).toBe('\u001b[D');
    expect(agyKeySequence('right')).toBe('\u001b[C');
    expect(agyKeySequence('interrupt')).toBe('\u0003');
  });

  it('moves from the CLI-selected option before pressing Enter', () => {
    expect(agyOptionSelectionSequence(2, 0)).toBe('\u001b[A\u001b[A\r');
    expect(agyOptionSelectionSequence(0, 2)).toBe('\u001b[B\u001b[B\r');
    expect(agyOptionSelectionSequence(0, 1, 'y')).toBe('y');
    expect(agyOptionSelectionSequence(0, 2, undefined, 'tab')).toBe(
      '\u001b[B\u001b[B\t',
    );
  });

  it('uses bracketed paste for multi-character and multiline prompts', () => {
    expect(agyPromptSequence('fix it')).toBe(
      '\u001b[200~fix it\u001b[201~\r',
    );
    expect(agyPromptSequence('a\nb')).toBe(
      '\u001b[200~a\nb\u001b[201~\r',
    );
    expect(agyPromptSequence('/usage', false)).toBe('/usage\r');
  });

  it('keeps the composer editable while a slash redraw temporarily looks blocking', () => {
    expect(isAgyComposerEditable('connected', 'ready', 'viewer', '/')).toBe(true);
    expect(isAgyComposerEditable('connected', 'ready', 'running', '/mo')).toBe(true);
    expect(isAgyComposerEditable('connected', 'ready', 'viewer', '')).toBe(false);
  });

  it('extracts only the answer and never exposes terminal navigation chrome', () => {
    const model = deriveAgyScreenModel([
      'AGY 1.1.9  Native CLI',
      '❯ explain the change',
      '',
      '✓ The change is complete.',
      'It now keeps the PTY hidden.',
      '',
      '↑/↓ move · Enter select · Ctrl+C exit',
      '❯ ',
    ]);

    const text = extractAgyAssistantText(model, 'explain the change');
    expect(text).toBe('The change is complete.\nIt now keeps the PTY hidden.');
    expect(text).not.toMatch(/↑|↓|Ctrl\+C|Enter select/u);
  });
});
