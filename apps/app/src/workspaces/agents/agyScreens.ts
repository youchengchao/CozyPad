/**
 * Typed models for AGY's interactive overlays.
 *
 * The surface used to flatten every overlay — model picker, session list,
 * permission editor — into one generic option list, which lost whole
 * dimensions of each screen (the effort gauge became a line of text, a
 * conversation's step count and age became part of its title).
 *
 * Each screen here is recognised from its own layout and parsed into the shape
 * its UI actually needs. Every recogniser is written against a real captured
 * screen in `tests/fixtures/agyScreens.ts`; nothing here is designed from
 * documentation, which is known to lag the CLI.
 */

/** A key AGY itself advertises in the footer of an overlay. */
export interface AgyKeyHint {
  /** As printed: `↑/↓`, `f2`, `ctrl+delete`. */
  label: string;
  /** As printed: `Navigate`, `Rename`, `Page`. */
  action: string;
}

export interface AgyScreenCommon {
  keys: AgyKeyHint[];
}

export interface AgyModelChoice {
  label: string;
  /** The trailing qualifier AGY appends, e.g. `Thinking`, `Medium`. */
  qualifier?: string;
  /** Marked `(current)` — the model the session is actually using. */
  current: boolean;
  focused: boolean;
  index: number;
}

/**
 * The reasoning-effort control. AGY draws it as a track of level markers:
 * `◉` is the selected level, `●` a level below it, `○` a level above.
 */
export interface AgyEffortGauge {
  levels: string[];
  selectedIndex: number;
  description?: string;
}

export interface AgyModelPickerScreen extends AgyScreenCommon {
  kind: 'modelPicker';
  title: string;
  models: AgyModelChoice[];
  /** Absent for models that expose no effort variants. */
  effort?: AgyEffortGauge;
}

export interface AgySessionRow {
  title: string;
  /** Blank when the conversation has no workspace, or when AGY drops the column. */
  workspace?: string;
  steps?: number;
  /** As printed: `5h ago`, `Jul 30`. */
  age?: string;
  focused: boolean;
  index: number;
}

export interface AgySessionPickerScreen extends AgyScreenCommon {
  kind: 'sessionPicker';
  rows: AgySessionRow[];
  tabs: { label: string; active: boolean }[];
  /** What the user has typed into the search row, empty when untouched. */
  search: string;
}

export interface AgyScopeChoice {
  label: string;
  focused: boolean;
  index: number;
}

export interface AgyPermissionScopeScreen extends AgyScreenCommon {
  kind: 'permissionScopes';
  title: string;
  prompt: string;
  scopes: AgyScopeChoice[];
  /** The explanation AGY shows for the focused scope. */
  description?: string;
}

export interface AgyContextSegment {
  label: string;
  /** As printed: `0 tokens`, `1.0M`. */
  amount: string;
  percent: number;
}

export interface AgyContextReportScreen extends AgyScreenCommon {
  kind: 'contextReport';
  title: string;
  /** `Gemini 3.6 Flash (High) · 0/1.0M tokens` */
  summary: string;
  usedPercent: number;
  segments: AgyContextSegment[];
  related: string[];
}

export interface AgyAgentChoice {
  label: string;
  description?: string;
  active: boolean;
  focused: boolean;
  index: number;
}

export interface AgyAgentPickerScreen extends AgyScreenCommon {
  kind: 'agentPicker';
  title: string;
  agents: AgyAgentChoice[];
}

export interface AgyQuotaLimit {
  /** `Weekly Limit`, `Five Hour Limit`. */
  label: string;
  /** The filled proportion, 0–100. */
  percent: number;
  /** `98% remaining · Refreshes in 45h 28m`, or `Quota available`. */
  note: string;
}

export interface AgyQuotaGroup {
  /** `GEMINI MODELS` */
  name: string;
  /** `Gemini Flash, Gemini Pro` */
  members?: string;
  limits: AgyQuotaLimit[];
}

export interface AgyQuotaReportScreen extends AgyScreenCommon {
  kind: 'quotaReport';
  title: string;
  account?: string;
  groups: AgyQuotaGroup[];
  footnote?: string;
}

export type AgyTypedScreen =
  | AgyModelPickerScreen
  | AgySessionPickerScreen
  | AgyPermissionScopeScreen
  | AgyContextReportScreen
  | AgyQuotaReportScreen
  | AgyAgentPickerScreen;

/**
 * What the chat header shows. Model and effort ride on AGY's persistent
 * footer so they are always current; the usage figures only exist on the
 * screens that report them, so they are remembered from the last time the
 * user opened one rather than invented.
 */
export interface AgyStatus {
  model?: string;
  effort?: string;
  contextUsedPercent?: number;
  contextSummary?: string;
  limits?: { label: string; remainingPercent: number; note?: string }[];
}

/** `? for shortcuts        Gemini 3.6 Flash · hig` — the trailing tag is the state. */
const STATUS_FOOTER =
  /(?:^|\s{2,})((?:gemini|claude|gpt|grok|llama)[\w.\s()+-]*?)\s*·\s*(\w+)\s*$/iu;
/** `Gemini 3.6 Flash (High) · 0/1.0M tokens` on the context screen. */
const CONTEXT_SUMMARY = /^(.+?)\s+·\s+(\S+)\s+tokens\s*$/u;
/** `Weekly Limit` followed by `98% remaining · Refreshes in 51h 54m`. */
const LIMIT_HEADING = /^([\w\s-]*?limit)\s*$/iu;
const LIMIT_REMAINING = /^(\d+(?:\.\d+)?)%\s+remaining(?:\s*·\s*(.+))?$/iu;

/**
 * Read whatever status the current screen happens to carry. Returns only the
 * fields it can see, so a caller can merge successive screens without an
 * absent field wiping a known one.
 */
export function readAgyStatus(lines: readonly string[]): AgyStatus {
  const status: AgyStatus = {};
  for (const line of lines) {
    const footer = STATUS_FOOTER.exec(line);
    if (footer !== null) {
      status.model = condense(footer[1]!);
      status.effort = footer[2]!;
    }
  }

  const context = recogniseAgyScreen(lines);
  if (context?.kind === 'contextReport') {
    const summary = CONTEXT_SUMMARY.exec(context.summary);
    if (summary !== null) {
      status.model = condense(summary[1]!).replace(/\s*\(([^)]+)\)\s*$/u, (_, effort) => {
        status.effort = String(effort).toLowerCase();
        return '';
      });
      status.contextSummary = `${summary[2]!} tokens`;
    }
    const free = context.segments.find((segment) => /free/iu.test(segment.label));
    status.contextUsedPercent =
      free === undefined ? context.usedPercent : Math.round((100 - free.percent) * 10) / 10;
  }

  if (context?.kind === 'quotaReport') {
    status.limits = context.groups.flatMap((group) => {
      const groupLabel = group.name
        .toLowerCase()
        .replace(/\s+models?$/u, '')
        .replace(/\s+and\s+/u, ' / ')
        .replace(/(^|\s|\/)\p{L}/gu, (letter) => letter.toUpperCase())
        .replace(/\bGpt\b/gu, 'GPT');
      return group.limits.map((limit) => {
        const remaining = LIMIT_REMAINING.exec(limit.note);
        return {
          label: `${groupLabel} · ${limit.label}`,
          remainingPercent:
            remaining === null
              ? Math.round(limit.percent)
              : Number.parseFloat(remaining[1]!),
          note:
            remaining?.[2] === undefined
              ? limit.note
              : condense(remaining[2]),
        };
      });
    });
    return status;
  }

  const limits: AgyStatus['limits'] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = LIMIT_HEADING.exec(condense(lines[index] ?? ''));
    if (heading === null) continue;
    for (let ahead = index + 1; ahead < Math.min(index + 4, lines.length); ahead += 1) {
      const remaining = LIMIT_REMAINING.exec(condense(lines[ahead] ?? ''));
      if (remaining === null) continue;
      limits.push({
        label: condense(heading[1]!),
        remainingPercent: Number.parseFloat(remaining[1]!),
        ...(remaining[2] === undefined ? {} : { note: condense(remaining[2]) }),
      });
      break;
    }
  }
  if (limits.length > 0) status.limits = limits;

  return status;
}

const KEYBOARD_ROW = /^\s*Keyboard:\s*(.+)$/u;
/**
 * A footer that lists keys without the `Keyboard:` prefix. Anchored on a
 * recognisable key token followed by a capitalised action, so ordinary prose
 * containing a `·` is not mistaken for a key list.
 */
const BARE_KEY_ROW =
  /^\s*(?:↑\/↓|←\/→|esc|enter|tab|shift\+\w+|ctrl\+\w+|pgup|pgdown|f\d+|[a-z]\/[a-z])\s+[A-Z]\S*(?:\s+\S+)*\s*·\s/u;
/** `↑/↓ Navigate`, `ctrl+delete Delete`, `enter Select / Toggle`. */
const KEY_HINT = /(\S+)\s+([A-Z][^·]*?)(?=\s{2,}|\s*·|$)/gu;
const FOCUS_ROW = /^\s*>\s+(\S.*)$/u;
const PLAIN_ROW = /^\s{2,}(\S.*)$/u;

function condense(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * AGY prints the keys each overlay supports in its own footer, so the UI can
 * show exactly what this version accepts instead of hard-coding a list that
 * silently drifts.
 */
export function parseAgyKeyHints(lines: readonly string[]): AgyKeyHint[] {
  const hints: AgyKeyHint[] = [];
  for (const line of lines) {
    // Two layouts exist: a `Keyboard:` row, and a bare `·`-separated row such
    // as `↑/↓ Scroll · pgup/pgdown Page · esc Close`.
    const prefixed = line.match(KEYBOARD_ROW);
    const source =
      prefixed !== null ? prefixed[1]! : BARE_KEY_ROW.test(line) ? condense(line) : null;
    if (source === null) continue;
    for (const match of source.matchAll(KEY_HINT)) {
      hints.push({ label: match[1]!, action: condense(match[2]!) });
    }
  }
  return hints;
}

function sectionIndex(lines: readonly string[], heading: RegExp): number {
  return lines.findIndex((line) => heading.test(line.trim()));
}

function parseModelPicker(lines: readonly string[]): AgyModelPickerScreen | null {
  const start = sectionIndex(lines, /^Switch Model$/u);
  if (start < 0) return null;

  const models: AgyModelChoice[] = [];
  const byKey = new Map<string, AgyModelChoice>();
  let effortRow = -1;
  // The list ends at its first trailing blank line. Some pickers have no
  // Effort row after it (the focused model's effort is part of its name), and
  // without this stop the scan ran on to the bottom of the screen, reading the
  // status footer — and any stale row a partial redraw left behind — as models.
  let listEnded = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*Effort\s/u.test(line)) {
      effortRow = index;
      break;
    }
    if (line.trim() === '') {
      if (models.length > 0) listEnded = true;
      continue;
    }
    if (listEnded) continue;
    const focused = FOCUS_ROW.exec(line);
    const plain = PLAIN_ROW.exec(line);
    const label = focused?.[1] ?? plain?.[1];
    if (label === undefined) continue;
    const text = condense(label);
    const current = /\(current\)\s*$/u.test(text);
    const stripped = text.replace(/\s*\(current\)\s*$/u, '');
    const qualifier = stripped.match(/\(([^)]+)\)\s*$/u)?.[1];
    const name =
      qualifier === undefined ? stripped : stripped.replace(/\s*\([^)]+\)\s*$/u, '');
    // AGY lists each model once; a second appearance is the redraw's leftover
    // of the same row at its old position. Its marks still describe the model.
    const key = `${name}|${qualifier ?? ''}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.current ||= current;
      existing.focused ||= focused !== null;
      continue;
    }
    const model: AgyModelChoice = {
      label: name,
      ...(qualifier === undefined ? {} : { qualifier }),
      current,
      focused: focused !== null,
      index: models.length,
    };
    byKey.set(key, model);
    models.push(model);
  }
  if (models.length === 0) return null;

  let effort: AgyEffortGauge | undefined;
  if (effortRow >= 0) {
    const markers = [...(lines[effortRow] ?? '')].filter((glyph) =>
      '◉●○'.includes(glyph),
    );
    const levels = condense(lines[effortRow + 1] ?? '').split(' ').filter(Boolean);
    const selectedIndex = markers.indexOf('◉');
    if (levels.length > 0 && selectedIndex >= 0) {
      const description = condense(lines[effortRow + 2] ?? '');
      effort = {
        levels,
        selectedIndex,
        ...(description === '' ? {} : { description }),
      };
    }
  }

  return {
    kind: 'modelPicker',
    title: 'Switch Model',
    models,
    ...(effort === undefined ? {} : { effort }),
    keys: parseAgyKeyHints(lines),
  };
}

/** `Request For Platform Assistance   usagework   14 steps   5h ago` */
const SESSION_ROW = /^(.*?)\s{2,}(?:(\S.*?)\s{2,})?(\d+)\s+steps?\s{2,}(\S.*?)\s*$/u;

function parseSessionPicker(lines: readonly string[]): AgySessionPickerScreen | null {
  const heading = sectionIndex(lines, /^Conversations$/u);
  if (heading < 0) return null;

  const tabRow = lines[heading - 2] ?? '';
  const tabs = condense(tabRow)
    .replace(/\(tab to cycle\)/iu, '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((label, index) => ({ label, active: index === 0 && / CLI/u.test(tabRow) }));

  const searchRow = condense(lines[heading + 1] ?? '');
  const search = /^type to search\.*$/iu.test(searchRow) ? '' : searchRow;

  const rows: AgySessionRow[] = [];
  for (let index = heading + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (KEYBOARD_ROW.test(line) || line.trim() === '') continue;
    const focused = line.trimStart().startsWith('>');
    const body = line.replace(/^\s*>?\s*/u, '');
    const match = SESSION_ROW.exec(body);
    if (match === null) continue;
    rows.push({
      title: condense(match[1]!),
      ...(match[2] === undefined ? {} : { workspace: condense(match[2]) }),
      steps: Number.parseInt(match[3]!, 10),
      age: condense(match[4]!),
      focused,
      index: rows.length,
    });
  }
  if (rows.length === 0) return null;

  return {
    kind: 'sessionPicker',
    rows,
    tabs,
    search,
    keys: parseAgyKeyHints(lines),
  };
}

function parsePermissionScopes(
  lines: readonly string[],
): AgyPermissionScopeScreen | null {
  const start = sectionIndex(lines, /^Permission Config Editor$/u);
  if (start < 0) return null;
  const prompt = lines
    .slice(start + 1)
    .map(condense)
    .find((line) => line.endsWith(':'));

  const scopes: AgyScopeChoice[] = [];
  let description: string | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (KEYBOARD_ROW.test(line)) break;
    const focused = FOCUS_ROW.exec(line);
    const plain = PLAIN_ROW.exec(line);
    const label = focused?.[1] ?? plain?.[1];
    if (label === undefined) continue;
    const text = condense(label);
    if (text.endsWith(':')) continue;
    // The trailing explanation of the focused scope reads as a sentence.
    if (scopes.length > 0 && /\s/u.test(text) && text.split(' ').length > 4) {
      description = text;
      continue;
    }
    scopes.push({ label: text, focused: focused !== null, index: scopes.length });
  }
  if (scopes.length === 0) return null;

  return {
    kind: 'permissionScopes',
    title: 'Permission Config Editor',
    prompt: prompt ?? 'Select a config scope to edit:',
    scopes,
    ...(description === undefined ? {} : { description }),
    keys: parseAgyKeyHints(lines),
  };
}

/**
 * `◉ User messages: 0 tokens (0.0%)` / `□ Free space: 1.0M (100.0%)`. The
 * marker is optional because stripping the decorative block grid on the left
 * also consumes a legend bullet that happens to use the same glyph.
 */
const CONTEXT_SEGMENT = /^[◉□●○]?\s*(.+?):\s+(\S+(?:\s+\S+)*?)\s+\(([\d.]+)%\)\s*$/u;

function parseContextReport(lines: readonly string[]): AgyContextReportScreen | null {
  const start = lines.findIndex((line) => /Context Usage\s*$/u.test(line));
  if (start < 0) return null;

  const segments: AgyContextSegment[] = [];
  let summary = '';
  let usedPercent = Number.NaN;
  let related: string[] = [];

  for (const line of lines.slice(start + 1)) {
    // The block grid on the left is decoration; only its right column carries data.
    const right = condense(line.replace(/^[\s□◼◻▪▫]+/u, ''));
    if (right === '') continue;
    if (/^Related:/u.test(right)) {
      related = right
        .replace(/^Related:\s*/u, '')
        .split(/\s*·\s*/u)
        .filter(Boolean);
      continue;
    }
    const segment = CONTEXT_SEGMENT.exec(right);
    if (segment !== null) {
      segments.push({
        label: segment[1]!,
        amount: segment[2]!,
        percent: Number.parseFloat(segment[3]!),
      });
      continue;
    }
    const percentOnly = right.match(/^\(([\d.]+)%\)$/u);
    if (percentOnly !== null) {
      usedPercent = Number.parseFloat(percentOnly[1]!);
      continue;
    }
    if (summary === '' && /tokens/u.test(right)) summary = right;
  }
  if (segments.length === 0) return null;

  return {
    kind: 'contextReport',
    title: 'Context Usage',
    summary,
    usedPercent: Number.isNaN(usedPercent) ? 0 : usedPercent,
    segments,
    related,
    keys: parseAgyKeyHints(lines),
  };
}

/** `> ● default  Default agent` */
const AGENT_ROW = /^\s*(>)?\s*([●○])\s+(\S+)(?:\s{2,}(.*\S))?\s*$/u;

function parseAgentPicker(lines: readonly string[]): AgyAgentPickerScreen | null {
  const start = sectionIndex(lines, /^Available Agents$/u);
  if (start < 0) return null;

  const agents: AgyAgentChoice[] = [];
  for (const line of lines.slice(start + 1)) {
    if (KEYBOARD_ROW.test(line)) break;
    const match = AGENT_ROW.exec(line);
    if (match === null) continue;
    agents.push({
      label: match[3]!,
      ...(match[4] === undefined ? {} : { description: condense(match[4]) }),
      active: match[2] === '●',
      focused: match[1] !== undefined,
      index: agents.length,
    });
  }
  if (agents.length === 0) return null;

  return {
    kind: 'agentPicker',
    title: 'Available Agents',
    agents,
    keys: parseAgyKeyHints(lines),
  };
}

/** `GEMINI MODELS`, `CLAUDE AND GPT MODELS` — the group headings. */
const QUOTA_GROUP = /^[A-Z][A-Z\s&]+$/u;
const QUOTA_MEMBERS = /^Models within this group:\s*(.+)$/u;
/** `[█████░] 97.79%` */
const QUOTA_BAR = /^\[[^\]]*\]\s+([\d.]+)%\s*$/u;

function parseQuotaReport(lines: readonly string[]): AgyQuotaReportScreen | null {
  const start = lines.findIndex((line) => /Models & Quota\s*$/u.test(line));
  if (start < 0) return null;

  const groups: AgyQuotaGroup[] = [];
  let account: string | undefined;
  const footnote: string[] = [];
  let pendingLabel: string | null = null;

  for (const raw of lines.slice(start + 1)) {
    const line = condense(raw);
    if (line === '') continue;

    const quoted = raw.match(/│(.*)$/u);
    if (quoted !== null) {
      footnote.push(condense(quoted[1]!));
      continue;
    }
    const owner = line.match(/^Account:\s*(.+)$/u);
    if (owner !== null) {
      account = owner[1]!;
      continue;
    }
    const members = line.match(QUOTA_MEMBERS);
    if (members !== null) {
      const group = groups.at(-1);
      if (group !== undefined) group.members = members[1]!;
      continue;
    }
    if (QUOTA_GROUP.test(line)) {
      groups.push({ name: line, limits: [] });
      continue;
    }
    if (/limit$/iu.test(line)) {
      pendingLabel = line;
      continue;
    }
    const bar = line.match(QUOTA_BAR);
    if (bar !== null && pendingLabel !== null) {
      groups.at(-1)?.limits.push({
        label: pendingLabel,
        percent: Number.parseFloat(bar[1]!),
        note: '',
      });
      pendingLabel = null;
      continue;
    }
    // The line after a bar explains it: remaining budget, or `Quota available`.
    const limit = groups.at(-1)?.limits.at(-1);
    if (limit !== undefined && limit.note === '' && !KEYBOARD_ROW.test(raw)) {
      limit.note = line;
    }
  }
  if (groups.length === 0) return null;

  return {
    kind: 'quotaReport',
    title: 'Models & Quota',
    ...(account === undefined ? {} : { account }),
    groups,
    ...(footnote.length === 0 ? {} : { footnote: footnote.join(' ') }),
    keys: parseAgyKeyHints(lines),
  };
}

const RECOGNISERS = [
  parseModelPicker,
  parseSessionPicker,
  parsePermissionScopes,
  parseContextReport,
  parseQuotaReport,
  parseAgentPicker,
] as const;

/**
 * Identify which overlay, if any, the screen is showing.
 *
 * Recognition is driven by the screen itself rather than by the last slash
 * command: AGY raises some of these on its own (a permission request mid-turn)
 * and others have keyboard entry points, so a command can only ever be a hint.
 */
export function recogniseAgyScreen(
  lines: readonly string[],
): AgyTypedScreen | null {
  for (const recognise of RECOGNISERS) {
    const screen = recognise(lines);
    if (screen !== null) return screen;
  }
  return null;
}
