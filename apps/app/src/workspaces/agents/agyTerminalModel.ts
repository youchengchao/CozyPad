import type { AgentSessionStatus } from '@cozypad/contracts';
import { recogniseAgyScreen } from './agyScreens';

export type AgySurfaceMode =
  | 'booting'
  | 'welcome'
  | 'prompt'
  | 'running'
  | 'approval'
  /** The agent asked the user to pick an answer — a decision, not a permission. */
  | 'question'
  | 'suggestions'
  | 'menu'
  | 'viewer'
  | 'error'
  | 'closed';

export type AgyNavigationKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageUp'
  | 'pageDown'
  | 'home'
  | 'end'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'interrupt';

export interface AgyScreenOption {
  label: string;
  selected: boolean;
  lineIndex: number;
  shortcut?: string;
  /** Present only when this row came from AGY's live slash-command menu. */
  command?: string;
}

export interface AgyScreenModel {
  mode: AgySurfaceMode;
  title: string;
  statusText: string;
  bodyLines: string[];
  options: AgyScreenOption[];
  selectedIndex: number;
  promptLineIndex: number;
  promptHint: string;
  approvalCommand?: string;
  fingerprint: string;
  rawLines: string[];
}

const ANSI_PATTERN =
  /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -\/]*[@-~]|\u001b[@-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f])/gu;
const BORDER_PREFIX = /^[\s│┃┆┊╎╏╭╮╰╯┌┐└┘├┤┬┴┼─━═]*/u;
const BORDER_SUFFIX = /[\s│┃┆┊╎╏╭╮╰╯┌┐└┘├┤┬┴┼─━═]*$/u;
const SELECTED_MARKERS = new Set(['>', '❯', '›', '→', '●', '◉', '◆']);
const GENERIC_OPTION_PATTERN =
  /^\s*(>|❯|›|→|●|◉|○|◯|◆|◇|•|\[[ xX]\]|\([ xX]\))\s+(.+?)\s*$/u;
const SHORTCUT_OPTION_PATTERN =
  /^\s*(?:\[|\()?([a-zA-Z0-9])(?:\]|\))\s+(.+?)\s*$/u;
/** `1. Yes` — AGY answers its sandbox and permission cards by typed digit. */
/**
 * `1. Yes` / `> 1. 種子 (Seed)` — a numbered choice, possibly carrying the
 * focus marker. Without the marker branch the focused row never matched, the
 * required 1-first run never formed, and an interactive question rendered as
 * plain text with no buttons at all.
 */
const NUMBERED_OPTION_PATTERN = /^\s*([>❯›→]\s+)?([1-9])[.)]\s+(\S.*?)\s*$/u;
const SLASH_OPTION_PATTERN =
  /^\s*(>|❯|›|→|●|◉|○|◯|◆|◇|•|[-*])?\s*(\/[A-Za-z][\w.-]*)(?:\s+(.*\S))?\s*$/u;
const INPUT_PATTERN = /^\s*(?:>|❯|›|→)\s*(.*)$/u;
// Block glyphs are here because AGY's start screen draws its logo out of them.
const SEPARATOR_PATTERN = /^[\s│┃┆┊╎╏╭╮╰╯┌┐└┘├┤┬┴┼─━═*_▀▄█▌▐░▒▓]+$/u;
/**
 * A rule that spans the window and separates turns — as opposed to the short
 * `──────` AGY renders for a markdown horizontal rule inside a reply.
 */
const TURN_SEPARATOR_PATTERN = /^\s*[─━═-]{40,}\s*$/u;
// Only work indicators count. A cancel keybinding hint does not: AGY prints
// `esc to cancel` under its idle slash menu too, and treating that as activity
// froze the composer as soon as the user typed `/`.
const RUNNING_PATTERN =
  /\b(thinking|working|running|executing|searching|reading|writing|editing|generating|analy[sz]ing|planning|processing|fetching|loading|streaming|signing in|authenticating|initializing|starting)\b/iu;
// Real tool rows are `● ListDir(/home)` / `○ Schedule(32s: …)`. Requiring the
// call shape keeps radio buttons, which reuse ●/○, from reading as activity.
const TOOL_ACTIVITY_PATTERN = /^\s*[●○◐◑◒◓◉]\s+[A-Za-z][\w.-]*\(/mu;
/** One tool row, captured so it can become a card rather than a line of text. */
const TOOL_ROW_PATTERN = /^\s*([●○◐◑◒◓◉])\s+([A-Za-z][\w.-]*)\((.*)$/u;
/** `▸ Thought for 3s, 740 tokens`, whose next line is the summary title. */
const THINKING_PATTERN = /^\s*[▸▾▶▼]?\s*Thought for\s+(.+?)\s*$/iu;
const EXPAND_HINT_PATTERN = /\s*\(ctrl\+o to expand\)\s*$/iu;
const APPROVAL_PATTERN =
  /permission|approval|required access|allow once|allow always|approve|authorize|run this command|execute this command|do you want to (?:allow|run|proceed)|\byes\b.*\bno\b/iu;
const ERROR_PATTERN =
  /(^|\s)(error|failed|failure|fatal|panic|unauthorized|forbidden|quota exceeded|not authenticated|login required)(:|\s|$)/iu;
const PANEL_PATTERN =
  /\b(settings|configuration|permissions|sessions|resume|model picker|select model|switch model|agents|subagents|artifact|review|diff|code search|keybindings|mcp servers?)\b/iu;
const KEY_HINT_PATTERN =
  /(?:↑|↓|←|→|arrow|enter\s+(?:to\s+)?select|tab\s+(?:to\s+)?complete|esc\s+(?:to\s+)?(?:cancel|close|stop)|ctrl\+[a-z]|page\s*(?:up|down)|pgup|pgdown)/iu;
/**
 * AGY's persistent footer. Depending on width it renders as
 * `? for shortcuts                    Gemini 3.6 Flash · high` or, once the
 * hint scrolls away, as the bare model/effort tag. Neither is ever a reply.
 */
const FOOTER_PATTERN =
  /^\?\s*for shortcuts\b|^(?:gemini|claude|gpt|grok|llama|antigravity)[\w.\s()+-]*·\s*\w+$/iu;
/** The start-screen banner: `▄▀▀▄  Antigravity CLI 1.1.9` and its account rows. */
const BRAND_PATTERN = /\b(?:agy|antigravity cli)\b\s*v?\d+(?:\.\d+)*\s*$/iu;
const KEY_HINT_GLOBAL =
  /(?:↑|↓|←|→|arrow|enter\s+(?:to\s+)?select|tab\s+(?:to\s+)?complete|esc\s+(?:to\s+)?(?:cancel|close|stop)|ctrl\+[a-z]|page\s*(?:up|down)|pgup|pgdown)/giu;
/** The braille spinner row, e.g. `⡿  Generating...`. */
const SPINNER_PATTERN =
  /^[⠀-⣿⠿⣷⣯⣟⡿⢿⣻⣽\s]*(?:generating|thinking|working|loading|processing)\s*(?:…|\.{2,})?\s*$/iu;

export function stripTerminalControls(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

export function normalizeAgyScreenLines(lines: readonly string[]): string[] {
  const normalized = lines.map((line) =>
    stripTerminalControls(line)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/u, ''),
  );
  while (normalized.length > 0 && normalized[0]?.trim() === '') normalized.shift();
  while (normalized.length > 0 && normalized.at(-1)?.trim() === '') normalized.pop();
  return normalized;
}

function withoutBox(line: string): string {
  return line.replace(BORDER_PREFIX, '').replace(BORDER_SUFFIX, '').trim();
}

function parseOptions(lines: readonly string[]): AgyScreenOption[] {
  const options: AgyScreenOption[] = [];
  const matchedLines = new Set<number>();
  // AGY marks every past user turn in its transcript with the same `>` it uses
  // for a selected row, so markers alone cannot mean "selectable". Every real
  // AGY chooser — trust gate, slash menu, model picker — also paints a
  // navigation hint, and a plain transcript never does. Without that hint the
  // whole conversation history would turn into a menu of fake commands.
  const selectable = lines.some((line) => KEY_HINT_PATTERN.test(withoutBox(line)));

  lines.forEach((rawLine, lineIndex) => {
    const line = withoutBox(rawLine);
    const slash = selectable ? line.match(SLASH_OPTION_PATTERN) : null;
    if (slash !== null) {
      const marker = slash[1];
      const command = slash[2]!;
      const description = slash[3]?.trim();
      options.push({
        label: description === undefined ? command : `${command} ${description}`,
        command,
        selected: marker !== undefined && SELECTED_MARKERS.has(marker),
        lineIndex,
      });
      matchedLines.add(lineIndex);
      return;
    }

    const match = selectable ? line.match(GENERIC_OPTION_PATTERN) : null;
    if (match !== null) {
      const marker = match[1]!;
      const label = match[2]!.trim();
      if (/^[A-Za-z][\w.-]*\(/u.test(label)) return;
      if (label !== '' && !SEPARATOR_PATTERN.test(label)) {
        options.push({
          label,
          selected:
            SELECTED_MARKERS.has(marker) || /x/iu.test(marker),
          lineIndex,
        });
        matchedLines.add(lineIndex);
      }
      return;
    }

    const shortcut = line.match(SHORTCUT_OPTION_PATTERN);
    if (
      shortcut !== null &&
      /allow|approve|deny|reject|cancel|continue|always|once/iu.test(shortcut[2]!)
    ) {
      options.push({
        label: shortcut[2]!.trim(),
        selected: false,
        lineIndex,
        shortcut: shortcut[1]!,
      });
      matchedLines.add(lineIndex);
    }
  });

  // A permission card is a numbered list you answer by typing the digit:
  //   Do you want to proceed?
  //   1. Yes
  //   2. Yes, and run without sandbox restrictions
  //   3. No
  // It carries no arrow-key hint, so it needs its own detection — otherwise the
  // card renders with no buttons and the fallback answers `y`, which AGY
  // ignores. Demanding a run that starts at 1 under a question keeps ordinary
  // numbered prose out.
  if (!options.some((option) => option.shortcut !== undefined)) {
    const run: AgyScreenOption[] = [];
    let runStart = -1;
    for (const [lineIndex, rawLine] of lines.entries()) {
      const line = withoutBox(rawLine);
      if (line === '') continue;
      const match = line.match(NUMBERED_OPTION_PATTERN);
      if (match !== null && Number(match[2]) === run.length + 1) {
        if (run.length === 0) runStart = lineIndex;
        run.push({
          label: match[3]!.trim(),
          selected: match[1] !== undefined,
          lineIndex,
          shortcut: match[2]!,
        });
        continue;
      }
      if (run.length >= 2) break;
      run.length = 0;
      runStart = -1;
    }
    // Questions arrive in the user's language; a full-width `？` ends one just
    // as surely as the ASCII mark.
    const question = lines
      .slice(Math.max(0, runStart - 5), Math.max(0, runStart))
      .some((line) => /[?？]$/u.test(withoutBox(line)));
    if (run.length >= 2 && question) {
      // The run IS the question's answer set. Marker rows collected before it
      // — the `>`-prefixed echo of the user's own prompt, the focused answer
      // row picked up a second time — are furniture around the card, and
      // offering them as answers made the user's own words clickable.
      for (let index = options.length - 1; index >= 0; index -= 1) {
        if (options[index]!.command === undefined) options.splice(index, 1);
      }
      for (const option of run) {
        options.push(option);
        matchedLines.add(option.lineIndex);
      }
    }
  }

  // The echo of what the user is typing (`  /mo`, `❯ /mo`) sits right above
  // AGY's real suggestions and must never be offered as one — clicking it
  // would re-insert the half-typed text. Real rows carry a description; the
  // echo is a bare command that other rows extend.
  for (let index = options.length - 1; index >= 0; index -= 1) {
    const option = options[index]!;
    if (option.command === undefined || option.label !== option.command) continue;
    const isDraft = options.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.command !== undefined &&
        candidate.command.startsWith(option.command!),
    );
    if (isDraft || options.filter((candidate) => candidate.command !== undefined).length === 1) {
      options.splice(index, 1);
    }
  }

  for (let index = options.length - 1; index >= 0; index -= 1) {
    const option = options[index]!;
    const isBottomInput =
      option.command === undefined &&
      // A numbered answer is a real choice wherever it sits on screen.
      option.shortcut === undefined &&
      option.selected &&
      option.lineIndex >= lines.length - 2 &&
      lines.slice(0, option.lineIndex).some((line) => withoutBox(line).endsWith('?'));
    if (isBottomInput) options.splice(index, 1);
  }

  // Some TUIs only decorate the selected row. Collect its adjacent indented rows.
  const selectedLine = options.find((option) => option.selected)?.lineIndex;
  if (selectedLine !== undefined) {
    const collectPlainOption = (lineIndex: number): boolean => {
      const rawLine = lines[lineIndex];
      if (rawLine === undefined || rawLine.trim() === '' || matchedLines.has(lineIndex)) {
        return false;
      }
      const line = withoutBox(rawLine);
      if (!/^\s{2,}\S/u.test(rawLine) || SEPARATOR_PATTERN.test(line)) return false;
      if (/[:.!?]$/u.test(line) || line.length > 96 || KEY_HINT_PATTERN.test(line)) return false;
      options.push({ label: line, selected: false, lineIndex });
      matchedLines.add(lineIndex);
      return true;
    };
    for (let index = selectedLine - 1; index >= 0 && collectPlainOption(index); index -= 1) {
      // Walk the contiguous option group above the selected row.
    }
    for (
      let index = selectedLine + 1;
      index < lines.length && collectPlainOption(index);
      index += 1
    ) {
      // Walk the contiguous option group below the selected row.
    }
  }

  return options.sort((left, right) => left.lineIndex - right.lineIndex);
}

function isChromeLine(line: string): boolean {
  const trimmed = withoutBox(line);
  if (trimmed === '' || SEPARATOR_PATTERN.test(trimmed)) return true;
  if (/^(?:agy|antigravity cli)(?:\s+v?\d|\s+native|\s+-|$)/iu.test(trimmed)) {
    return true;
  }
  // The logo sits on the same row as the version, so this cannot be anchored.
  if (BRAND_PATTERN.test(trimmed)) return true;
  if (FOOTER_PATTERN.test(trimmed) || SPINNER_PATTERN.test(trimmed)) return true;
  if (KEY_HINT_PATTERN.test(trimmed)) return true;
  return false;
}

/**
 * The live input row is the one with nothing but chrome below it. AGY prefixes
 * every past user turn with the same `>`, and while it works the newest output
 * lands underneath them — so "is anything still being written below this row"
 * is what separates the cursor from history.
 */
function findPromptLineIndex(lines: readonly string[], options: readonly AgyScreenOption[]): number {
  const optionLines = new Set(options.map((option) => option.lineIndex));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (optionLines.has(index)) continue;
    const line = withoutBox(lines[index]!);
    if (!INPUT_PATTERN.test(line)) continue;
    const onlyChromeBelow = lines
      .slice(index + 1)
      .every((below, offset) => !optionLines.has(index + 1 + offset) && isChromeLine(below));
    if (onlyChromeBelow) return index;
  }
  return -1;
}

function findPromptHint(lines: readonly string[], promptLineIndex: number): string {
  if (promptLineIndex >= 0) {
    const input = withoutBox(lines[promptLineIndex]!).match(INPUT_PATTERN)?.[1]?.trim();
    if (input !== undefined && input !== '') return 'Message AGY';
    for (let index = promptLineIndex - 1; index >= 0; index -= 1) {
      const candidate = withoutBox(lines[index]!);
      if (candidate === '' || SEPARATOR_PATTERN.test(candidate)) continue;
      if (candidate.endsWith('?')) return candidate;
      break;
    }
  }
  if (/what would you like/iu.test(lines.join('\n'))) {
    return 'Describe what you want AGY to do';
  }
  return 'Message AGY';
}

function findApprovalCommand(lines: readonly string[]): string | undefined {
  const commandLabel = lines.findIndex((line) =>
    /^\s*(?:command|shell command)\s*:?\s*$/iu.test(withoutBox(line)),
  );
  if (commandLabel >= 0) {
    const candidate = lines
      .slice(commandLabel + 1)
      .map(withoutBox)
      .find((line) => line !== '');
    if (candidate !== undefined) return candidate.replace(/^[$>]\s*/u, '');
  }
  const shellLine = lines.map(withoutBox).find((line) => /^[$`]\s*\S/u.test(line));
  return shellLine?.replace(/^[$`]\s*/u, '').replace(/`$/u, '');
}

function titleFor(lines: readonly string[], mode: AgySurfaceMode): string {
  if (mode === 'approval') return 'AGY needs your approval';
  if (mode === 'question') {
    // The question itself is the best title the card can carry.
    const question = [...lines]
      .reverse()
      .map(withoutBox)
      .find((line) => /[?？]$/u.test(line) && line.length <= 120);
    return question ?? 'AGY asked a question';
  }
  if (mode === 'running') return 'AGY is working';
  if (mode === 'error') return 'AGY reported a problem';
  if (mode === 'welcome') return 'What would you like to do?';
  const heading = lines.map(withoutBox).find((line) => {
    return (
      line.length >= 3 &&
      line.length <= 72 &&
      !isChromeLine(line) &&
      !INPUT_PATTERN.test(line) &&
      !GENERIC_OPTION_PATTERN.test(line) &&
      !KEY_HINT_PATTERN.test(line)
    );
  });
  if (heading !== undefined) return heading;
  if (mode === 'menu' || mode === 'viewer') return 'Choose an option';
  return 'AGY';
}

export function deriveAgyScreenModel(
  inputLines: readonly string[],
  closed = false,
): AgyScreenModel {
  const lines = normalizeAgyScreenLines(inputLines);
  const joined = lines.join('\n');
  const options = parseOptions(lines);
  const parsedOptionLines = new Set(options.map((option) => option.lineIndex));
  // Mode is decided from content only: option rows and persistent chrome say
  // nothing about what AGY is doing. Hints are stripped per fragment, not per
  // line, because AGY prints them beside real status (`Thinking…  Esc to
  // cancel`) as well as alone under an idle menu.
  const stateText = lines
    .filter((_line, index) => !parsedOptionLines.has(index))
    .map((line) => {
      const trimmed = withoutBox(line);
      if (FOOTER_PATTERN.test(trimmed)) return '';
      return trimmed.replace(KEY_HINT_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
    })
    .join('\n');
  const selectedIndex = options.findIndex((option) => option.selected);
  const promptLineIndex = findPromptLineIndex(lines, options);
  const hasPrompt = promptLineIndex >= 0;
  const hasSlashSuggestions = options.some((option) => option.command !== undefined);
  // Judge approvals and errors from prose only, and never while the slash menu
  // is open: its own rows say things like `/permissions  Manage tool
  // permissions`, which otherwise turns every `/`-autocomplete into a fake
  // approval card and takes the composer away mid-word.
  const keyedChoices = options.some((option) => option.shortcut !== undefined);
  // An approval is a *permission* gate and is recognised by its prose. A
  // numbered list under a question is the agent asking the user to decide —
  // same keys, entirely different intent, so it must not be framed as AGY
  // asking to be allowed to do something.
  const hasApproval = !hasSlashSuggestions && APPROVAL_PATTERN.test(stateText);
  const hasQuestion = !hasSlashSuggestions && !hasApproval && keyedChoices;
  const hasRunning =
    RUNNING_PATTERN.test(stateText) || TOOL_ACTIVITY_PATTERN.test(stateText);
  const hasActiveSpinner = lines.some((line) =>
    SPINNER_PATTERN.test(withoutBox(line)),
  );
  const hasError = !hasSlashSuggestions && ERROR_PATTERN.test(stateText);
  const hasPanel = PANEL_PATTERN.test(joined);
  const hasAgyBrand = /\b(?:agy|antigravity cli)\b/iu.test(joined);
  const hasWelcomeHeader =
    /(?:\bagy\b.*\bnative cli\b)|(?:\bantigravity cli\b.*\b(?:welcome|version|v?\d))/iu.test(
      joined,
    );
  const hasWelcomeChoice = options.some((option) =>
    /start (?:a |new )?(?:task|conversation)|resume (?:a )?(?:conversation|session)/iu.test(
      option.label,
    ),
  );

  let mode: AgySurfaceMode;
  if (closed) mode = 'closed';
  else if (lines.length === 0) mode = 'booting';
  // An open autocomplete outranks activity: the user is mid-word, and taking
  // the composer away to show a "working" state is what made `/` unusable.
  else if (hasSlashSuggestions) mode = 'suggestions';
  // AGY keeps its empty input row painted while tools are running. The
  // transient spinner is the authoritative sign that the row is not idle yet;
  // it must outrank the prompt without letting old tool rows latch the session
  // in a running state after the spinner disappears.
  else if (hasActiveSpinner) mode = 'running';
  // A live input row is proof AGY is idle and waiting — it paints one for no
  // other state. It has to outrank every keyword heuristic below, because
  // those read the whole transcript: one reply mentioning an "error" or a
  // "permission" used to latch the composer shut for the rest of the session,
  // including right after a turn was cancelled.
  else if (hasPrompt) mode = 'prompt';
  else if (hasApproval) mode = 'approval';
  else if (hasQuestion) mode = 'question';
  else if (hasError) mode = 'error';
  else if (hasRunning) mode = 'running';
  else if (options.length > 0 && hasWelcomeHeader && hasWelcomeChoice && !hasPrompt) {
    mode = 'welcome';
  }
  else if (options.length > 0 && hasPanel) mode = 'viewer';
  else if (options.length > 0) mode = hasAgyBrand && !hasPrompt ? 'welcome' : 'menu';
  else if (hasPanel && !hasPrompt) mode = 'viewer';
  else mode = hasPrompt ? 'prompt' : hasAgyBrand ? 'welcome' : 'prompt';

  const optionLines = new Set(options.map((option) => option.lineIndex));
  const bodyLines = lines.filter((line, index) => {
    if (optionLines.has(index) || isChromeLine(line)) return false;
    if (index === promptLineIndex) return false;
    return true;
  });

  const statusText =
    mode === 'closed'
      ? 'CLI session closed'
      : mode === 'booting'
        ? 'Connecting to AGY…'
        : mode === 'running'
          ? lines.find((line) => RUNNING_PATTERN.test(line))?.trim() ?? 'Working…'
          : mode === 'approval'
            ? 'Waiting for your decision'
            : mode === 'question'
              ? 'Waiting for your choice'
              : mode === 'error'
                ? 'Action required'
                : 'Ready';

  return {
    mode,
    title: titleFor(lines, mode),
    statusText,
    bodyLines,
    options,
    selectedIndex,
    promptLineIndex,
    promptHint: findPromptHint(lines, promptLineIndex),
    approvalCommand: mode === 'approval' ? findApprovalCommand(lines) : undefined,
    fingerprint: `${mode}\n${lines.join('\n')}`,
    rawLines: lines,
  };
}

function comparablePromptLine(line: string): string {
  return withoutBox(line).replace(/^\s*(?:>|❯|›|→)\s*/u, '').trim();
}

function cleanAssistantLine(line: string): string | null {
  const clean = withoutBox(line).replace(/^✓\s*/u, '').trimEnd();
  if (clean === '' || SEPARATOR_PATTERN.test(clean)) return '';
  if (isChromeLine(clean) || KEY_HINT_PATTERN.test(clean)) return null;
  if (INPUT_PATTERN.test(clean)) return null;
  if (/^selected\s*:/iu.test(clean)) return null;
  if (/^what would you like .*\?$/iu.test(clean)) return null;
  if (SPINNER_PATTERN.test(clean)) return null;
  if (/^(?:press esc|type \/)(?:…|\.{3})?$/iu.test(clean)) return null;
  // Tool rows look like option rows but are transcript content — they carry
  // what the agent actually did and belong in the reply, as cards.
  if (TOOL_ROW_PATTERN.test(clean)) return clean;
  if (SLASH_OPTION_PATTERN.test(clean)) return null;
  // `•` is how AGY renders a markdown list item — reply content, not a
  // selectable row. Dropping it with the radio glyphs ate whole explanation
  // lists out of the middle of answers.
  const generic = clean.match(GENERIC_OPTION_PATTERN);
  if (generic !== null && generic[1] !== '•') return null;
  return clean;
}

/**
 * Whether the current frame may become reply text for this turn.
 *
 * A slash command is a control action: whatever it draws — a picker, a report,
 * a pager — is presentation, answered by the typed overlay or the status line.
 * Scraping that screen into a bubble showed the same content twice, once as
 * raw terminal text and once properly. The overlay check covers the other
 * direction: a picker opened by keyboard mid-turn must not leak its rows into
 * whichever turn happens to be latest.
 */
export function mayScrapeAgyReply(
  prompt: string,
  lines: readonly string[],
  previous = '',
): boolean {
  if (prompt.trimStart().startsWith('/')) return false;
  if (recogniseAgyScreen(lines) !== null) return false;
  // Immediately after Enter, xterm can still contain the previous turn for a
  // frame. Falling back to the last block in that frame copied the previous
  // answer into the brand-new bubble. Wait until AGY has echoed this prompt;
  // after the first chunk, `previous` keeps long replies scrapeable even once
  // their prompt has scrolled above the 40-row viewport.
  if (previous !== '') return true;
  const wanted = prompt.replace(/\s+/gu, '');
  return lines.some((line) => {
    if (!INPUT_PATTERN.test(withoutBox(line))) return false;
    const comparable = comparablePromptLine(line);
    const seen = comparable.replace(/\s+/gu, '');
    return (
      comparable === prompt ||
      comparable.endsWith(prompt) ||
      (seen.length >= 4 && wanted.startsWith(seen))
    );
  });
}

/**
 * AGY briefly redraws the new prompt above the previous answer before its
 * spinner/tool rows arrive. That frame is valid terminal content but not a
 * valid answer for the new local turn.
 */
export function isStaleAgyReplyCandidate(
  candidate: string,
  earlierReplies: readonly string[],
  running: boolean,
  current = '',
): boolean {
  if (!running || current !== '' || candidate === '') return false;
  const normalized = candidate.trim();
  return earlierReplies.some(
    (reply) => reply !== '' && reply.trim() === normalized,
  );
}

/**
 * Convert the hidden terminal's latest screen into one clean assistant message.
 * The terminal remains the source of truth, but its chrome and key hints never
 * become chat content.
 */
export function extractAgyAssistantText(
  model: AgyScreenModel,
  prompt: string,
  previous = '',
): string {
  const lines = model.rawLines;
  // Everything from the input block down is chrome, never reply text.
  let end = model.promptLineIndex >= 0 ? model.promptLineIndex : lines.length;
  if (end > 0 && TURN_SEPARATOR_PATTERN.test(lines[end - 1] ?? '')) end -= 1;

  const condense = (value: string): string => value.replace(/\s+/gu, '');
  const wanted = condense(prompt);
  let start = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (!INPUT_PATTERN.test(withoutBox(lines[index]!))) continue;
    const comparable = comparablePromptLine(lines[index]!);
    const seen = condense(comparable);
    if (
      comparable !== prompt &&
      !comparable.endsWith(prompt) &&
      !(seen.length >= 4 && wanted.startsWith(seen))
    ) {
      continue;
    }
    // A prompt wider than the window wraps onto the rows beneath it. Those
    // rows carry no `>`, so without following the echo to its end they read
    // as the agent's first words and the reply opened with the user's own
    // question echoed back.
    let cursor = index + 1;
    let accumulated = seen;
    while (cursor < end && accumulated.length < wanted.length) {
      const next = condense(withoutBox(lines[cursor]!));
      if (next === '' || !wanted.startsWith(accumulated + next)) break;
      accumulated += next;
      cursor += 1;
    }
    start = cursor;
    break;
  }
  if (start < 0) {
    // A reply longer than the window pushes its own prompt echo off the top.
    // Falling back to the last turn block keeps long answers visible instead of
    // rendering an empty bubble, which is what "no response" looked like.
    start = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (TURN_SEPARATOR_PATTERN.test(lines[index]!)) {
        start = index + 1;
        break;
      }
    }
    // Nothing above the first turn yet: skip the start-screen banner so the
    // account and model rows do not open the conversation.
    if (start === 0 && BRAND_PATTERN.test(withoutBox(lines[0] ?? ''))) {
      const blank = lines.findIndex((line, index) => index > 0 && line.trim() === '');
      if (blank > 0) start = blank;
    }
  }

  // Rows recognised as selectable options are answered through the option
  // card; repeating them as reply text showed the same choices twice — and
  // the focused row, carrying the `>` marker, vanished from that copy anyway.
  const optionLines = new Set(model.options.map((option) => option.lineIndex));
  const cleaned: string[] = [];
  for (let index = start; index < end; index += 1) {
    if (optionLines.has(index)) continue;
    const next = cleanAssistantLine(lines[index]!);
    if (next === null) continue;
    if (next === '' && (cleaned.length === 0 || cleaned.at(-1) === '')) continue;
    if (next !== '' && next === cleaned.at(-1)) continue;
    cleaned.push(next);
  }
  while (cleaned.at(-1) === '') cleaned.pop();
  const candidate = cleaned.join('\n').trim();
  if (candidate === '') return previous;
  if (previous !== '' && candidate.length < previous.length && previous.startsWith(candidate)) {
    return previous;
  }
  return candidate;
}

export function isAgyComposerEditable(
  connection: 'connecting' | 'connected' | 'closed' | 'error',
  sessionStatus: AgentSessionStatus,
  mode: AgySurfaceMode,
  draft: string,
): boolean {
  if (connection !== 'connected' || sessionStatus === 'exited' || mode === 'closed') {
    return false;
  }
  // A full-screen redraw after `/`, `/m`, ... must never steal the composer.
  if (draft !== '') return true;
  return mode === 'prompt' || mode === 'suggestions' || mode === 'booting';
}

const KEY_SEQUENCES: Record<AgyNavigationKey, string> = {
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  home: '\u001b[H',
  end: '\u001b[F',
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  interrupt: '\u0003',
};

export function agyKeySequence(key: AgyNavigationKey): string {
  return KEY_SEQUENCES[key];
}

export function agyOptionSelectionSequence(
  selectedIndex: number,
  targetIndex: number,
  shortcut?: string,
  confirmKey: 'enter' | 'tab' = 'enter',
): string {
  if (shortcut !== undefined) return shortcut;
  const start = selectedIndex >= 0 ? selectedIndex : 0;
  const difference = targetIndex - start;
  const key = difference < 0 ? KEY_SEQUENCES.up : KEY_SEQUENCES.down;
  return key.repeat(Math.abs(difference)) + KEY_SEQUENCES[confirmKey];
}

/**
 * Predict where the highlight lands so the menu answers a keypress at once
 * instead of waiting for a remote repaint. It stops at the ends rather than
 * wrapping: AGY only shows a window onto a longer list ("↓ 30 more"), and
 * pressing past the edge is what makes it scroll the rest into view.
 */
export function nextSuggestionIndex(
  current: number,
  count: number,
  direction: 'up' | 'down',
): number {
  if (count <= 0) return 0;
  const clamped = Math.min(Math.max(current, 0), count - 1);
  return direction === 'down'
    ? Math.min(clamped + 1, count - 1)
    : Math.max(clamped - 1, 0);
}

export type AgyReplyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; meta: string; title: string }
  | { kind: 'tool'; name: string; detail: string; status: 'running' | 'completed' };

/**
 * Split a reply into the pieces a chat UI can render distinctly: prose, the
 * agent's collapsed reasoning, and each tool it ran.
 *
 * The CLI paints all three as lines in one scroll region. Rendering that region
 * as a single markdown blob is what made tool calls and reasoning read as
 * garbled prose in the middle of an answer.
 */
export function segmentAgyReply(text: string): AgyReplyBlock[] {
  const blocks: AgyReplyBlock[] = [];
  const prose: string[] = [];
  const flush = (): void => {
    const joined = prose.join('\n').trim();
    prose.length = 0;
    if (joined !== '') blocks.push({ kind: 'text', text: joined });
  };

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const tool = line.match(TOOL_ROW_PATTERN);
    if (tool !== null) {
      flush();
      const detail = tool[3]!
        .replace(EXPAND_HINT_PATTERN, '')
        .replace(/\)\s*$/u, '')
        .trim();
      blocks.push({
        kind: 'tool',
        name: tool[2]!,
        detail,
        status: tool[1] === '●' ? 'completed' : 'running',
      });
      continue;
    }
    const thinking = line.match(THINKING_PATTERN);
    if (thinking !== null) {
      flush();
      // The line underneath is the one-line summary AGY shows collapsed.
      const next = lines[index + 1]?.trim() ?? '';
      const titled = next !== '' && !TOOL_ROW_PATTERN.test(next) &&
        !THINKING_PATTERN.test(next);
      if (titled) index += 1;
      blocks.push({
        kind: 'thinking',
        meta: thinking[1]!,
        title: titled ? next : '',
      });
      continue;
    }
    prose.push(line);
  }
  flush();
  return blocks;
}

export interface AgyDraftMirror {
  /** What the remote input line will hold afterwards. */
  remote: string;
  /** Bytes to write to the CLI; empty when nothing should be sent. */
  send: string;
}

/**
 * Decide what reaches the CLI when the composer text changes.
 *
 * An IME reports a change for every intermediate composition state, so
 * mirroring each one typed the entire 注音 trail into the remote prompt
 * (`ㄍㄟㄨㄛ給我一給我一ㄍㄛ…`). Nothing is sent while composing; the committed
 * text is then reconciled against the remote line in one step.
 */
export function mirrorAgyDraft(
  previousRemote: string,
  value: string,
  composing: boolean,
): AgyDraftMirror {
  if (composing) return { remote: previousRemote, send: '' };
  if (value === previousRemote) return { remote: previousRemote, send: '' };
  if (value.startsWith(previousRemote)) {
    return { remote: value, send: value.slice(previousRemote.length) };
  }
  if (previousRemote.startsWith(value)) {
    return {
      remote: value,
      send: '\u007f'.repeat(previousRemote.length - value.length),
    };
  }
  // Nothing in common: clear the line, then paste the replacement.
  return {
    remote: value,
    send: `\u001b\u001b${value === '' ? '' : `\u001b[200~${value}\u001b[201~`}`,
  };
}

export function agyPromptSequence(text: string, bracketedPaste = true): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (bracketedPaste && (normalized.includes('\n') || normalized.length > 1)) {
    return `\u001b[200~${normalized}\u001b[201~\r`;
  }
  return `${normalized}\r`;
}
