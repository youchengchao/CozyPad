/**
 * The wire shapes emitted by `agy -p <text> --output-format stream-json`.
 *
 * Every field here was observed in a real run on 2026-08-07 (agy on Windows);
 * the recordings live in `tests/fixtures/`. There is no speculative field left:
 * `AgyToolInfo.error` was the last one, and `turn-tool-error.ndjson` is now a
 * verbatim recording of two tools that executed and then failed.
 *
 * Nothing in this module trusts the wire: agy is a separate process on a
 * private, undocumented output format, so every field is optional and every
 * reader narrows before use.
 */

/** `state` on a step. Anything unrecognised is carried through as a string. */
export type AgyStepState = 'ACTIVE' | 'DONE' | 'ERROR' | (string & {});

/**
 * `step_type` on a step.
 *
 * `error_message` is **not** in the docs/ACP-MIGRATION.md table — it was found
 * by recording, and it carries no text whatsoever (no `text_delta`, no message
 * field). It marks a tool call agy *refused before running*: the two recordings
 * that contain it have no tool step for the refused call, while the recording
 * where tools genuinely failed (`turn-tool-error.ndjson`) has no
 * `error_message` step at all. See MAPPING notes in mapper.ts.
 */
export type AgyStepType =
  | 'user_input'
  | 'unknown'
  | 'agent_response'
  | 'tool'
  | 'checkpoint'
  | 'error_message'
  | 'system_message'
  | (string & {});

export interface AgyUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly thinking_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly total_tokens?: number;
}

export interface AgyToolInfo {
  readonly name?: string;
  readonly parameters?: Record<string, unknown>;
  /**
   * What the tool actually produced — the only place agy reports a tool's
   * result. Present on the DONE step and absent when the tool produced nothing
   * (an empty `list_dir` sends no `output` key at all, which is why the first
   * recording missed this field entirely). Dropping it renders a tool card that
   * says "completed" with a blank body.
   *
   * Observed as a plain string: `"alpha.txt\nbeta.txt"` from `list_dir`, and a
   * console's raw bytes from `run_command`.
   */
  readonly output?: string;
  /**
   * Observed 2026-08-07 on a tool that executed and failed: `read_url_content`
   * against a closed port gave `{"type":"TOOL_ERROR","message":"Failed to fetch
   * document content at http://127.0.0.1:9/"}`. `type` has only ever been
   * `"TOOL_ERROR"`, so it is not narrowed to a union.
   *
   * Note the scope: this is the tool *failing*, not the tool being *refused*.
   * agy rejects a malformed call (a path that does not exist) before execution
   * and then emits no tool step at all — see `turn-tool-output.ndjson`.
   */
  readonly error?: { readonly type?: string; readonly message?: string };
}

export interface AgyStep {
  readonly conversation_id?: string;
  /**
   * The correlation key for a tool call: the ACTIVE and the DONE/ERROR step of
   * one tool share a `step_index` (observed: both were index 3). agy issues no
   * separate tool-call id, so ACP `toolCallId` is derived from this.
   */
  readonly step_index?: number;
  readonly state?: AgyStepState;
  readonly step_type?: AgyStepType;
  /**
   * A genuine incremental delta, not a running total: one recorded
   * `agent_response` arrived as ACTIVE `"0\n"` then DONE `"\n"`.
   */
  readonly text_delta?: string;
  readonly tool_name?: string;
  readonly duration_seconds?: number;
  readonly tool_info?: AgyToolInfo;
  readonly usage?: AgyUsage;
}

export interface AgyInitEvent {
  readonly event: 'init';
  /** Observed at the top level, not inside `init`. */
  readonly conversation_id?: string;
  readonly init?: {
    readonly cwd?: string;
    readonly tools?: readonly string[];
    /** Observed value: `"always-proceed"` — print mode never asks. */
    readonly permission_mode?: string;
    readonly conversation_id?: string;
  };
}

export interface AgyStepUpdateEvent {
  readonly event: 'step_update';
  readonly step_update?: AgyStep;
}

export interface AgyResultEvent {
  readonly event: 'result';
  readonly result?: {
    readonly conversation_id?: string;
    /**
     * Observed values: `"SUCCESS"` and `"ERROR"`, and nothing else so far.
     *
     * `"ERROR"` does **not** mean the turn failed. It is set when any tool
     * errored during the turn, even one agy recovered from: the recording in
     * `turn-tool-error.ndjson` ran all five requested steps and answered in
     * full, and still reports `"ERROR"`. See `stopReasonFor` in mapper.ts.
     */
    readonly status?: string;
    /** The whole turn's text, concatenated. */
    readonly response?: string;
    /**
     * Present only alongside `status: "ERROR"`, and observed to be a *copy of
     * the last failed tool's message* rather than a turn-level fault: in
     * `turn-tool-error.ndjson` it repeats the `manage_task` error verbatim,
     * `tool_info.error.message` and all. It is therefore deliberately not
     * mapped — the tool card already carries it, and re-emitting it would
     * report one failure twice.
     */
    readonly error?: string;
    readonly duration_seconds?: number;
    readonly num_turns?: number;
    readonly usage?: AgyUsage;
  };
}

export interface AgyUnknownEvent {
  readonly event: string;
}

export type AgyEvent =
  | AgyInitEvent
  | AgyStepUpdateEvent
  | AgyResultEvent
  | AgyUnknownEvent;

/**
 * Parse one NDJSON line. Returns `undefined` for a blank line or anything that
 * is not a JSON object with a string `event` — a malformed line must never
 * abort a turn, so the caller reports it as a diagnostic and keeps reading.
 */
export function parseAgyLine(line: string): AgyEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { event } = parsed as { event?: unknown };
  if (typeof event !== 'string') return undefined;
  return parsed as AgyEvent;
}

/**
 * Incremental newline splitter for a stdout stream.
 *
 * A chunk boundary can land mid-line, so partial text is held until its
 * newline arrives. `flush` yields whatever is left when the stream ends —
 * agy's final line is not always newline-terminated.
 */
export class NdjsonLineSplitter {
  #buffer = '';

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
    }
    return lines;
  }

  flush(): string[] {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest.trim() === '' ? [] : [rest];
  }
}
