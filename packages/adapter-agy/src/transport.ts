/**
 * The transport seam.
 *
 * docs/ACP-MIGRATION.md settles on two ways to drive agy: `cli`
 * (`-p --output-format stream-json`, simple and safe, no per-call approval) and
 * `connect` (the local language server — faster, real approvals, structured
 * diffs, but a private fail-open API). Only `cli` exists today.
 *
 * The seam is drawn at *already-mapped ACP events*, not at raw agy lines, on
 * purpose. `connect` speaks protobuf-shaped trajectory steps, not NDJSON, so a
 * line-level seam would force it to fake a wire format. Emitting
 * {@link AgyTurnEvent} instead means each transport owns its own mapping and the
 * ACP surface in `agent.ts` never learns which one is underneath — which is the
 * whole point of putting the private-API bet behind one boundary.
 */
import type { AcpSessionUpdate, AcpStopReason, AgyDiagnostic } from './mapper.js';

export type AgyTransportKind = 'cli' | 'connect';

export interface AgyTurnRequest {
  /** The user's prompt, already flattened from ACP content blocks. */
  readonly prompt: string;
  readonly cwd: string;
  /**
   * Every workspace root beyond {@link cwd} this turn may see.
   *
   * Not optional, and that is the point. agy 1.1.11 **ignores the process cwd**,
   * confirmed by isolating the two levers one per run (2026-08-07, two agy
   * calls, Sonnet; `tests/fixtures/proveWorkspace.mjs`): with the spawn cwd set
   * to the workspace and no `--add-dir`, agy echoed that directory back as
   * `init.cwd` and then ran `list_dir` in `~/.gemini/antigravity-cli/scratch`,
   * answering "The directory is empty" with exit 0 and `status: SUCCESS`. With
   * only `--add-dir` and a deliberately wrong cwd, it read the right directory.
   * The workspace is therefore something a transport must be *told* on every
   * turn, not something it can forget to ask for; `cli` passes each entry (and
   * `cwd`) as a `--add-dir`.
   *
   * Two sources merge here: the session's ACP `additionalDirectories`, and the
   * directories holding files named by `resource_link` prompt blocks.
   */
  readonly additionalDirectories: readonly string[];
  /**
   * `null` on a session's first turn. On later turns this is the id agy handed
   * back on `init`, and the transport must use it to continue the conversation
   * (for `cli`, that is `--conversation <id>`).
   */
  readonly conversationId: string | null;
  /**
   * The model this turn must run on, or `null` for "the client never picked one".
   *
   * Not optional, and for the same reason {@link additionalDirectories} is not:
   * forgetting it is silent. agy persists a model in
   * `~/.gemini/antigravity-cli/settings.json` and uses it whenever `--model` is
   * absent, so a turn with no model pinned runs on whatever the user last chose
   * **in another tool** — measured as `Gemini 3.6 Flash (Low)` on this machine
   * while every recorded fixture in this package was taken on Sonnet. A CV
   * experiment that cannot say which model produced a result is not a
   * verification, and nothing in the wire output names the model either.
   *
   * `null` is therefore a value a transport must *report*, not one it may
   * quietly resolve: see `AGY_MODEL_META_KEY` in `agent.ts`.
   */
  readonly model: string | null;
  /** Aborting must stop the turn and make it finish with `cancelled`. */
  readonly signal?: AbortSignal;
}

/** One model agy can be asked for: the `--model` id, and its display name. */
export interface AgyModel {
  /** The value `--model` takes, e.g. `claude-sonnet-4-6`. */
  readonly id: string;
  /** What agy calls it, e.g. `Claude Sonnet 4.6 (Thinking)`. */
  readonly name: string;
}

/**
 * What a transport can tell the client about model choice.
 *
 * This exists so `session/new` can hand back a real ACP `configOptions` list
 * instead of a hard-coded one. The `cli` transport fills it from `agy models`;
 * `connect` will fill it from `GetCascadeModelConfigData`, which carries the
 * same ids plus quota and context limits.
 */
export interface AgyModelCatalog {
  /** Empty is legal, and means "ask the diagnostics why". */
  readonly models: readonly AgyModel[];
  /**
   * The model agy uses when `--model` is absent, as far as the transport can
   * tell. `id` is `null` when the persisted setting names a model the catalog
   * does not list — reporting the name we found beats inventing an id.
   */
  readonly persistedDefault: { readonly id: string | null; readonly name: string } | null;
  /** Why the list is short or the default unknown. Logged, and reported in `_meta`. */
  readonly diagnostics: readonly string[];
}

export type AgyTurnEvent =
  /** agy named the conversation; the caller stores it for the next turn. */
  | { readonly type: 'conversation'; readonly conversationId: string }
  | { readonly type: 'update'; readonly update: AcpSessionUpdate }
  /** Something unmodelled came over the wire. For logs, never for the client. */
  | { readonly type: 'diagnostic'; readonly diagnostic: AgyDiagnostic }
  | { readonly type: 'end'; readonly stopReason: AcpStopReason };

export interface AgyTransport {
  readonly kind: AgyTransportKind;
  /**
   * The models this transport can pin, for the client to choose from.
   *
   * Required rather than optional: an absent method would mean a transport
   * author who forgot it ships a session with no model picker and no complaint,
   * which is the defect this method exists to close. A transport that genuinely
   * cannot enumerate models returns an empty list *with a diagnostic saying so*.
   *
   * Implementations should cache — the client may open many sessions and this
   * costs a subprocess and a network round trip on the `cli` path.
   */
  listModels(): Promise<AgyModelCatalog>;
  /**
   * Run one turn. The iterable ends after the `end` event; the implementation
   * is responsible for cleaning up its process or connection either way.
   */
  runTurn(request: AgyTurnRequest): AsyncIterable<AgyTurnEvent>;
  /** Release anything held across turns. `cli` holds nothing; `connect` will. */
  dispose(): Promise<void>;
}
