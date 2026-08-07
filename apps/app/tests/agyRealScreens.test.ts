import { describe, expect, it } from 'vitest';
import {
  agyOptionSelectionSequence,
  agySurfaceSessionStatus,
  deriveAgyScreenModel,
  extractAgyAssistantText,
  isAgyComposerEditable,
  isAgyFooterRow,
  mayScrapeAgyReply,
  mirrorAgyDraft,
  nextSuggestionIndex,
  segmentAgyReply,
} from '../src/workspaces/agents/agyTerminalModel';

/**
 * Screens captured from real AGY 1.1.9 sessions — remote over SSH, and local
 * through a 120x40 pseudo-console. They are kept verbatim (blank rows, wrapped
 * status footer, logo art and all; only the account address is redacted)
 * because every regression here came from a screen that looked "obviously"
 * parseable in isolation but not as the CLI actually paints it.
 */
const START_SCREEN = [
  '',
  '      ▄▀▀▄        Antigravity CLI 1.1.9',
  '     ▀▀▀▀▀▀       user@example.com (Google AI Pro)',
  '    ▀▀▀▀▀▀▀▀      Gemini 3.6 Flash (High)',
  '   ▄▀▀    ▀▀▄     ~/work',
  '  ▄▀▀      ▀▀▄',
  '',
  '────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────',
  '? for shortcuts                          Gemini 3.6 Flash · hig',
];

const TRUST_GATE = [
  'Accessing workspace:',
  '',
  'C:\\Users\\example\\work',
  '',
  'Do you trust the contents of this project?',
  '',
  'Antigravity CLI requires permission to read, edit, and execute files here.',
  '',
  '> Yes, I trust this folder',
  '  No, exit',
  '',
  '  ↑/↓ Navigate · enter Confirm',
  '                                         Gemini 3.6 Flash · hig',
];

const TRANSCRIPT = [
  '',
  '      ▄▀▀▄        Antigravity CLI 1.1.9',
  '     ▀▀▀▀▀▀       user@example.com (Google AI Pro)',
  '    ▀▀▀▀▀▀▀▀      Gemini 3.6 Flash (High)',
  '   ▄▀▀    ▀▀▄     ~/work',
  '  ▄▀▀      ▀▀▄',
  '',
  '────────────────────────────────────────────────────────────',
  '> who are you',
  '',
  '  I am Antigravity, powered by Gemini 3.6 Flash. How can I help you today?',
  '',
  '────────────────────────────────────────────────────────────',
  '> Reply with exactly PONG42 and nothing else.',
  '',
  '  PONG42',
  '',
  '────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────',
  '? for shortcuts                          Gemini 3.6 Flash · hig',
];
const MODEL_PICKER = [
  '────────────────────────────────────────────────────────────────────────────',
  '>',
  '─────────────────────────────────────── (Google AI Pro)─────────────────────',
  '? for shortcuts                                                            G',
  '',
  '',
  'Switch Model',
  '  Gemini 3.6 Flash',
  '> Gemini 3.5 Flash             (current)',
  '  Gemini 3.1 Pro',
  '  Claude Sonnet 4.6 (Thinking)',
  '  Claude Opus 4.6 (Thinking)',
  '  GPT-OSS 120B (Medium)',
  '',
  '  Effort  ◂        ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸',
  '                  low          medium          high',
  '            Deepest reasoning for complex problems — slower but strongest',
  '',
  'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back',
];

const SLASH_MO = [
  '────────────────────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                                            G',
  '',
  '  /mo',
  '',
  '> /model               Set a model',
  '  /permissions         Manage tool permissions',
  '  /teamwork-preview    Invoke a team of agents to autonomously tackle large',
  '  /agy-customizations  Comprehensive guide and reference for the Antigravity',
  '',
  '  ↑/↓ Navigate · enter Select · tab Complete',
  'esc to cancel',
];

const TOOLS_RUNNING = [
  '────────────────────────────────────────────────────────────',
  '> Inspect this directory carefully and keep working',
  '',
  '● ListDir(/home/devbox)',
  '○ Schedule(32s: Timer finished. 30 seconds have passed.)',
  '● ListDir(/home/devbox/attendance-remote)',
  '',
  '  I am inspecting the directory and waiting.',
  '',
  '───────────────────────────────────────────────────────────',
  '⡿  Generating...',
  '───────────────────────────────────────────────────────────',
  '? for shortcuts                                            G',
];

const ANSWERED = [
  '────────────────────────────────────────────────────────────',
  '> Reply with exactly COZYPAD_TOKEN_42',
  '',
  '  COZYPAD_TOKEN_42',
  '',
  '────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────',
  '? for shortcuts                                            G',
];

/**
 * AGY 1.1.10 answering `hi` on Claude Opus 4.6, captured after the reply had
 * finished. Claude models spell their reasoning effort as `(Thinking)` inside
 * the model name instead of after a `·`, so this footer looks unlike every
 * Gemini frame above — and that one difference was enough to leave the surface
 * stuck in `running` with the Stop button lit and a caret blinking.
 */
const CLAUDE_ANSWERED = [
  '────────────────────────────────────────────────────────────────────────────',
  '> Hi',
  '',
  '▸ Thought for 2s',
  "The user is just saying hi. I'll respond with a friendly greeting.",
  '',
  '  Hey! 👋 How can I help you today?',
  '',
  '  Tip: Use /context to see what files are in the conversation.',
  '',
  '────────────────────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────────────────────',
  'esc to cancel                                     Claude Opus 4.6 (Thinking)',
];

/**
 * An ordinary answer that outgrew the 40-row window: by the time this frame
 * was painted, the `> 我回應你…` echo had scrolled off the top and only the
 * live, empty input row remains. Captured from the user's session on
 * 2026-08-07, where this turn rendered as no reply at all.
 */
const OUTGREW_WINDOW_PROMPT =
  '我回應你"我回應你"OK, fair""是正確的嗎? 還是有道地的講法';
const OUTGREW_WINDOW = [
  '  #### 3. 覺得真的很好笑',
  '',
  '  • "That\'s a good one!" （這個有笑點／這句好笑！）',
  '  • "LOL" / "Haha, good one."',
  '  ──────',
  '  總結：',
  '  你原本說的 "OK, fair" 完全沒有問題！如果想讓句型更完整一點，下次也可以',
  '  直接說 "Fair enough!" 或 "I\'ll give you that." 哦！',
  '',
  '────────────────────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                   Claude Opus 4.6 (Thinking)',
];

/** A `/usage` reply long enough that its own `> /usage` echo scrolled away. */
const LONG_REPLY = [
  '  Models & Quota',
  '',
  '  Account: user@example.com',
  '',
  '  GEMINI MODELS',
  '',
  '  Weekly Limit',
  '  [█████████████████████████████████████████████████░] 98.13%',
  '  98% remaining · Refreshes in 51h 54m',
  '',
  '  ──────',
  '',
  '  Within each group, models share a weekly limit and a 5-hour limit.',
  '',
  '────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────',
  '? for shortcuts                          Gemini 3.6 Flash · hig',
];

describe('real AGY 1.1.9 screens', () => {
  describe("a Claude model's footer, whose effort has no `·` separator", () => {
    const model = deriveAgyScreenModel(CLAUDE_ANSWERED);

    it('reads as an idle prompt, not as work still in flight', () => {
      // `running` is what put the Stop button beside an untouched composer and
      // kept the streaming caret blinking under a finished answer.
      expect(model.mode).toBe('prompt');
      expect(agySurfaceSessionStatus('connected', 'ready', model.mode)).toBe('ready');
    });

    it('keeps the footer out of the reply', () => {
      const reply = extractAgyAssistantText(model, 'Hi');

      expect(reply).toContain('How can I help you today?');
      expect(reply).toContain('Tip: Use /context');
      expect(reply).not.toContain('esc to cancel');
      expect(reply).not.toContain('Claude Opus 4.6');
    });

    it('names the footer for what it is, whichever column survives', () => {
      expect(isAgyFooterRow('esc to cancel      Claude Opus 4.6 (Thinking)')).toBe(true);
      expect(isAgyFooterRow('? for shortcuts    Gemini 3.6 Flash · low')).toBe(true);
      expect(isAgyFooterRow('esc to cancel')).toBe(true);
      expect(isAgyFooterRow('Gemini 3.6 Flash · low')).toBe(true);
      // A model name on its own is a row of the model picker, not the footer.
      expect(isAgyFooterRow('  Claude Opus 4.6 (Thinking)')).toBe(false);
      // And prose that merely mentions the key stays in the answer.
      expect(isAgyFooterRow('Press esc to cancel insert mode.')).toBe(false);
    });

    it('collapses the reasoning behind its duration', () => {
      const blocks = segmentAgyReply(extractAgyAssistantText(model, 'Hi'));

      expect(blocks[0]).toMatchObject({
        kind: 'thinking',
        meta: '2s',
        title: "The user is just saying hi. I'll respond with a friendly greeting.",
      });
      expect(blocks[1]?.kind).toBe('text');
    });
  });

  describe('an answer that outgrew the window before its first scrape', () => {
    const model = deriveAgyScreenModel(OUTGREW_WINDOW);

    it('is scrapeable even though nothing has accumulated yet', () => {
      // `previous` is empty here — this is the first frame the turn would
      // accept. Refusing it because the echo had scrolled away is what left
      // the turn permanently blank while AGY had answered in full.
      expect(mayScrapeAgyReply(OUTGREW_WINDOW_PROMPT, model.rawLines, '')).toBe(
        true,
      );
    });

    it('still refuses a frame that is showing somebody else\'s turn', () => {
      // The protection that mattered: another prompt's echo on screen means
      // the visible answer belongs to that turn, not this one.
      expect(
        mayScrapeAgyReply('second request', [
          '> first request',
          '  The first answer.',
          '',
          '>',
        ]),
      ).toBe(false);
    });

    it('recovers the whole visible answer', () => {
      const reply = extractAgyAssistantText(model, OUTGREW_WINDOW_PROMPT);

      expect(reply).toContain('覺得真的很好笑');
      expect(reply).toContain('Fair enough!');
      expect(reply).not.toContain('for shortcuts');
      expect(reply).not.toContain('Claude Opus 4.6');
    });

    it('does not turn the answer\'s numbered headings into clickable options', () => {
      expect(model.options).toEqual([]);
      expect(model.mode).toBe('prompt');
    });
  });

  describe("AGY's own session notices", () => {
    // Printed by the CLI when the same conversation is opened twice. It is
    // never the model speaking, and as prose it read as the agent volunteering
    // a warning nobody asked for.
    const blocks = segmentAgyReply(
      [
        'Here is the answer you asked for.',
        '',
        '⚠ Conversation already open',
        '⎿  When you opened this conversation it was already open in another CLI',
        'instance on this machine. Sending messages from both may cause',
        'conflicts. Use /fork to continue here separately.',
        '',
      ].join('\n'),
    );

    it('becomes its own block instead of reply prose', () => {
      expect(blocks.map((block) => block.kind)).toEqual(['text', 'notice']);
      expect(blocks[0]).toMatchObject({
        kind: 'text',
        text: 'Here is the answer you asked for.',
      });
      expect(blocks[1]).toMatchObject({
        kind: 'notice',
        title: 'Conversation already open',
      });
    });

    it('keeps the wrapped detail together', () => {
      const notice = blocks[1];
      expect(notice?.kind === 'notice' && notice.detail).toContain(
        'already open in another CLI instance on this machine',
      );
      expect(notice?.kind === 'notice' && notice.detail).toContain(
        'Use /fork to continue here separately.',
      );
    });

    it("does not claim a reply's own warning sign", () => {
      // No `⎿` row under it, so this is the model writing, not the CLI.
      expect(
        segmentAgyReply(
          ['⚠ 注意：這個指令會刪除檔案', '請先確認備份存在。'].join('\n'),
        ),
      ).toEqual([
        {
          kind: 'text',
          text: '⚠ 注意：這個指令會刪除檔案\n請先確認備份存在。',
        },
      ]);
    });
  });

  it('still shows a reply whose prompt echo scrolled off the screen', () => {
    const model = deriveAgyScreenModel(LONG_REPLY);
    const text = extractAgyAssistantText(model, '/usage');

    // Returning '' here is what "the slash command shows nothing" looked like.
    expect(text).toContain('Models & Quota');
    expect(text).toContain('98% remaining');
    // A markdown rule inside the reply is not a turn boundary.
    expect(text).toContain('Within each group');
    expect(text).not.toContain('for shortcuts');
  });

  it('does not open a reply with the start-screen banner', () => {
    const model = deriveAgyScreenModel(START_SCREEN);

    expect(extractAgyAssistantText(model, 'anything')).toBe('');
  });

  it('opens on a ready prompt without turning the banner into content', () => {
    const model = deriveAgyScreenModel(START_SCREEN);

    expect(model.mode).toBe('prompt');
    expect(model.options).toEqual([]);
    expect(isAgyComposerEditable('connected', 'ready', model.mode, '')).toBe(true);
    expect(model.bodyLines.join('\n')).not.toContain('Antigravity CLI 1.1.9');
    expect(model.bodyLines.join('\n')).not.toContain('for shortcuts');
    expect(model.bodyLines.join('\n')).not.toContain('· hig');
  });

  it('makes the trust gate an approval with both answers clickable', () => {
    const model = deriveAgyScreenModel(TRUST_GATE);

    expect(model.mode).toBe('approval');
    expect(model.options.map((option) => option.label)).toEqual([
      'Yes, I trust this folder',
      'No, exit',
    ]);
    expect(model.selectedIndex).toBe(0);
  });

  it('never turns past turns in the transcript into selectable commands', () => {
    const model = deriveAgyScreenModel(TRANSCRIPT);

    // `> who are you` and `> Reply with…` are history, not a menu. Treating
    // them as options produced a slash list of invented commands as soon as
    // the conversation had any content in it.
    expect(model.options).toEqual([]);
    expect(model.mode).toBe('prompt');
    expect(
      extractAgyAssistantText(model, 'Reply with exactly PONG42 and nothing else.'),
    ).toBe('PONG42');
  });

  it('makes a numbered permission card answerable by its digits', () => {
    // Quoted from AGY's own sandbox documentation.
    const model = deriveAgyScreenModel([
      'AGY wants to run:',
      '  npm test',
      '',
      'Do you want to proceed?',
      '1. Yes',
      '2. Yes, and run without sandbox restrictions',
      '3. No',
    ]);

    expect(model.mode).toBe('approval');
    expect(model.options.map((option) => option.shortcut)).toEqual(['1', '2', '3']);
    expect(model.options[1]?.label).toBe('Yes, and run without sandbox restrictions');
    // Clicking a choice must type its digit, not a guessed y/n.
    expect(agyOptionSelectionSequence(-1, 2, model.options[2]?.shortcut)).toBe('3');
  });

  it('leaves an ordinary numbered list in a reply alone', () => {
    const model = deriveAgyScreenModel([
      '  Here is what I found:',
      '  1. The config is missing',
      '  2. The port is already bound',
      '',
      '────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────',
    ]);

    expect(model.options).toEqual([]);
    expect(model.mode).toBe('prompt');
  });

  it('does not echo a wrapped prompt back as the start of the reply', () => {
    const prompt = '給我一個互動問答並且說明每一個步驟的細節以及可能遇到的問題的解法';
    const model = deriveAgyScreenModel([
      '────────────────────────────────────────────────────────────',
      '> 給我一個互動問答並且說明每一個步驟的細節以及可能遇到的問題',
      '的解法',
      '',
      '  好的，以下是規劃：',
      '',
      '────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────',
    ]);

    // The wrapped second row carries no `>`, so it used to read as the agent's
    // opening words and the bubble started with the user's own question.
    expect(extractAgyAssistantText(model, prompt)).toBe('好的，以下是規劃：');
  });

  it('returns to a usable prompt after a cancelled turn', () => {
    // The transcript keeps every word the agent ever said. Judging the session
    // state from those words latched the composer shut: a reply that merely
    // mentioned an error or a permission left the UI stuck "working" forever,
    // most visibly right after Stop.
    const screen = [
      '────────────────────────────────────────────────────────────',
      '> 給我一個互動問答',
      '',
      '● ListDir(/home/user)',
      '  I hit an error while reading the config and asked for permission.',
      '',
      '────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────',
      '? for shortcuts                          Gemini 3.6 Flash · hig',
    ];
    const model = deriveAgyScreenModel(screen);

    expect(model.mode).toBe('prompt');
    expect(isAgyComposerEditable('connected', 'ready', model.mode, '')).toBe(true);
  });

  it('still reports running while no prompt has come back', () => {
    const model = deriveAgyScreenModel([
      '────────────────────────────────────────────────────────────',
      '> 給我一個互動問答',
      '',
      '● ListDir(/home/user)',
      '⡿  Running...',
    ]);

    expect(model.mode).toBe('running');
    expect(isAgyComposerEditable('connected', 'ready', model.mode, '')).toBe(false);
  });

  it('sends only committed text when typing with an IME', () => {
    // The intermediate states a Bopomofo IME reports while composing
    // 「給我一個互動問答」. Mirroring them typed the whole trail into the
    // remote prompt, so AGY received `ㄍㄟㄨㄛ給我一給我一ㄍㄛ…`.
    const composition = [
      'ㄍ',
      'ㄍㄟ',
      '給',
      '給ㄨ',
      '給我',
      '給我ㄧ',
      '給我一',
      '給我一ㄍㄛ',
      '給我一個',
      '給我一個ㄏㄨ',
      '給我一個互',
      '給我一個互ㄉㄨㄥ',
      '給我一個互動',
      '給我一個互動ㄨㄣ',
      '給我一個互動問',
      '給我一個互動問ㄉㄚ',
    ];
    const committed = '給我一個互動問答';

    let remote = '';
    let sent = '';
    for (const value of composition) {
      const step = mirrorAgyDraft(remote, value, true);
      remote = step.remote;
      sent += step.send;
    }
    expect(sent).toBe('');
    expect(remote).toBe('');

    const commit = mirrorAgyDraft(remote, committed, false);
    remote = commit.remote;
    sent += commit.send;

    expect(remote).toBe(committed);
    expect(sent).toBe(committed);
    expect(sent).not.toContain('ㄍ');
    expect(sent).not.toContain('ㄨ');
  });

  it('reconciles an edit that is not a pure append', () => {
    const cleared = mirrorAgyDraft('/model', '/mod', false);
    expect(cleared.send).toBe('\u007f\u007f');
    expect(cleared.remote).toBe('/mod');

    const replaced = mirrorAgyDraft('/mod', 'hello', false);
    expect(replaced.send).toBe('\u001b\u001b\u001b[200~hello\u001b[201~');

    const emptied = mirrorAgyDraft('hello', '', false);
    // Clearing is a backspace run over what is there, not a clear-and-paste.
    expect(emptied.send).toBe('\u007f'.repeat(5));
  });

  it('splits a reply into prose, reasoning and tool cards', () => {
    // The shapes AGY actually paints, from a real session.
    const blocks = segmentAgyReply(
      [
        '▸ Thought for 3s, 740 tokens',
        'Designing the Quiz Interface',
        '',
        '● ListDir(/home/devbox)',
        '○ Schedule(32s: Timer finished. 30 seconds have passed.)',
        '● Read(/home/devbox/README.md) (ctrl+o to expand)',
        '',
        '好的，以下是我的規劃：',
        '',
        '1. 先建立骨架',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      'thinking',
      'tool',
      'tool',
      'tool',
      'text',
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'thinking',
      meta: '3s, 740 tokens',
      title: 'Designing the Quiz Interface',
    });
    expect(blocks[1]).toMatchObject({
      kind: 'tool',
      name: 'ListDir',
      detail: '/home/devbox',
      status: 'completed',
    });
    // An unfinished call keeps its running state so the card can show it.
    expect(blocks[2]).toMatchObject({ name: 'Schedule', status: 'running' });
    // The keyboard hint belongs to the terminal, not to the card.
    expect(blocks[3]).toMatchObject({
      name: 'Read',
      detail: '/home/devbox/README.md',
    });
    expect(blocks[4]).toMatchObject({
      kind: 'text',
      text: '好的，以下是我的規劃：\n\n1. 先建立骨架',
    });
  });

  it('keeps a plain answer as a single block', () => {
    const blocks = segmentAgyReply('PONG42');
    expect(blocks).toEqual([{ kind: 'text', text: 'PONG42' }]);
  });

  it('turns visible AGY git output into diff and history cards', () => {
    const blocks = segmentAgyReply([
      'Changes completed.',
      'diff --git a/src/demo.ts b/src/demo.ts',
      'index d0a9731..d127c7f 100644',
      '--- a/src/demo.ts',
      '+++ b/src/demo.ts',
      '@@ -4,2 +4,2 @@ export interface GreetingOptions {',
      "-  if (!options.enabled) return 'Greeting disabled';",
      "+  if (!options.enabled) return 'Greeting is disabled';",
      '### Commit Line',
      '223f40f baseline',
    ].join('\n'));

    expect(blocks).toEqual([
      { kind: 'text', text: 'Changes completed.' },
      {
        kind: 'diff',
        diff: [
          'diff --git a/src/demo.ts b/src/demo.ts',
          'index d0a9731..d127c7f 100644',
          '--- a/src/demo.ts',
          '+++ b/src/demo.ts',
          '@@ -4,2 +4,2 @@ export interface GreetingOptions {',
          "-  if (!options.enabled) return 'Greeting disabled';",
          "+  if (!options.enabled) return 'Greeting is disabled';",
        ].join('\n'),
      },
      { kind: 'gitHistory', entries: ['223f40f baseline'] },
    ]);
  });

  it('offers the model picker rows as clickable choices', () => {
    const model = deriveAgyScreenModel(MODEL_PICKER);

    expect(model.mode).toBe('viewer');
    expect(model.options.map((option) => option.label)).toEqual([
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash             (current)',
      'Gemini 3.1 Pro',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ]);
    expect(model.selectedIndex).toBe(1);
  });

  it('keeps the composer usable while the slash menu is open', () => {
    const model = deriveAgyScreenModel(SLASH_MO);

    expect(model.mode).toBe('suggestions');
    expect(model.options.map((option) => option.command)).toEqual([
      '/model',
      '/permissions',
      '/teamwork-preview',
      '/agy-customizations',
    ]);
    expect(isAgyComposerEditable('connected', 'ready', model.mode, '/mo')).toBe(true);
  });

  it('walks the live suggestion list with the arrow keys', () => {
    const commands = deriveAgyScreenModel(SLASH_MO).options;
    expect(commands).toHaveLength(4);

    let index = 0;
    index = nextSuggestionIndex(index, commands.length, 'down');
    expect(commands[index]?.command).toBe('/permissions');
    index = nextSuggestionIndex(index, commands.length, 'down');
    expect(commands[index]?.command).toBe('/teamwork-preview');
    index = nextSuggestionIndex(index, commands.length, 'up');
    expect(commands[index]?.command).toBe('/permissions');

    // Held at the ends rather than wrapped, because the same keypress is also
    // sent to AGY: at the edge it scrolls its own window instead of jumping to
    // the far end of the list.
    expect(nextSuggestionIndex(0, commands.length, 'up')).toBe(0);
    expect(nextSuggestionIndex(3, commands.length, 'down')).toBe(3);
    // A stale index from a list that just shrank must not escape the array.
    expect(nextSuggestionIndex(99, 4, 'down')).toBe(3);
    expect(nextSuggestionIndex(0, 0, 'down')).toBe(0);
  });

  it('treats tool activity above an empty prompt as still running', () => {
    const model = deriveAgyScreenModel(TOOLS_RUNNING);

    expect(model.mode).toBe('running');
    expect(model.bodyLines.join('\n')).not.toContain('for shortcuts');
  });

  it('returns to a ready prompt once the answer is painted', () => {
    const model = deriveAgyScreenModel(ANSWERED);

    expect(model.mode).toBe('prompt');
    expect(
      extractAgyAssistantText(model, 'Reply with exactly COZYPAD_TOKEN_42'),
    ).toBe('COZYPAD_TOKEN_42');
  });
});
