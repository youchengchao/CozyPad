/**
 * The ACP agent surface.
 *
 * This class knows about sessions and the protocol; it does not know how agy is
 * driven. Everything process-shaped is behind {@link AgyTransport}, so adding
 * the `connect` transport later touches nothing in this file.
 *
 * The rule this file is written to: **never advertise a capability the
 * transport underneath does not have, and never drop something the client sent
 * without saying so.** Both halves of that had been broken in ways that produce
 * a confident wrong answer instead of a visible failure — a session that
 * answered about the wrong directory, prompt blocks that vanished, a
 * `loadSession` capability backed by resume semantics, and a permission policy
 * that was never consulted. Each site below says which one it is closing.
 */
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import type { AgyModelCatalog, AgyTransport } from './transport.js';

const SESSION_PREFIX = 'agy-';

/**
 * The `_meta` key carrying agy's conversation id across the ACP boundary.
 *
 * agy names the conversation on the first turn's `init` event, and
 * `--conversation <id>` is the only thing that continues it. ACP models no field
 * for a foreign conversation handle, so it rides the `_meta` extension point:
 * **out** on every session update and on every prompt response, **back in** on
 * `session/resume`. Without this the id lived only in the adapter's stderr log,
 * the client had nothing to persist, and resuming quietly opened a brand-new
 * agy conversation while reporting success.
 *
 * Namespaced, for the reason spelled out on {@link AGY_LIMITATIONS_META_KEY} —
 * and *more* urgently than that one, because this is the load-bearing key. It
 * used to be the bare string `conversationId`, which is a name any other agent's
 * extension could plausibly pick and a name a future spec field could take. A
 * collision here does not produce a type error or a dropped field; it produces a
 * resume that succeeds against **someone else's conversation**.
 */
export const AGY_CONVERSATION_META_KEY = 'cozypad.dev/agy-conversation-id';

/**
 * The bare key this adapter used to emit, still accepted on input.
 *
 * One version of compatibility, and input only: a client that persisted the old
 * key can still resume, and nothing this adapter emits carries it. Kept narrow
 * on purpose — accepting it forever is how the namespaced key stays decorative.
 */
export const AGY_CONVERSATION_META_KEY_LEGACY = 'conversationId';

/**
 * The `_meta` key reporting which model a session is pinned to.
 *
 * `session/update` and `PromptResponse` have no model field, and agy's wire
 * output never names the model either — so without this there is no point in
 * the whole exchange at which a client (or a log, or a CV experiment's record)
 * can say what produced an answer. It is reported on `session/new`,
 * `session/resume`, `session/set_config_option` and **every prompt response**,
 * pinned or not: "nothing was chosen, so agy used its own saved default" is the
 * case that most needs saying.
 *
 * It is also read **back in** on `session/resume` ({@link readModelMeta}), so a
 * client that persisted this block can restore the pin instead of silently
 * dropping to agy's default on the first turn after a reconnect.
 */
export const AGY_MODEL_META_KEY = 'cozypad.dev/agy-model';

/**
 * The `_meta` key reporting how much a `session/resume` was actually able to
 * check. See {@link AgyAgent.resumeSession}.
 */
export const AGY_RESUME_META_KEY = 'cozypad.dev/agy-resume';

/**
 * The `_meta` key under which `initialize` states what this adapter *cannot* do.
 *
 * ACP has no negative capabilities: there is no field that says "tool calls in
 * this session are never submitted to your permission policy". Silence there is
 * indistinguishable from "the agent simply never needed to ask", which is how a
 * third-party client's `--deny-all` ran against us with no effect and no
 * complaint — `session/request_permission` appears zero times in 23 recorded
 * transcripts, including turns where agy really executed `list_dir`.
 *
 * Namespaced so it cannot collide with a future spec field or another agent's
 * extension.
 */
export const AGY_LIMITATIONS_META_KEY = 'cozypad.dev/agy-limitations';

/**
 * The single ACP session mode the `cli` transport can be in.
 *
 * agy print mode reports `permission_mode: "always-proceed"` in its own `init`
 * event and answers its own approval questions inside the child process, before
 * anything reaches this adapter. Session modes are ACP's standard, *renderable*
 * channel for exactly this fact, so the limitation shows up in a client's UI
 * rather than only in a `_meta` bag a client may never read.
 *
 * There is deliberately no second mode to switch to. Offering one would be the
 * same defect in a new place: a control that appears to gate tools and does not.
 */
export const AGY_PERMISSION_MODE_ID = 'always-proceed';

const AGY_PERMISSION_NOTICE =
  'agy print mode reports permission_mode "always-proceed": it runs every tool ' +
  'without asking, inside its own process. This adapter therefore never sends ' +
  'session/request_permission, and a client permission policy cannot allow, deny ' +
  'or modify any tool call in this session.';

/**
 * What the workspace roots are, and — the part that keeps getting overstated —
 * what they are not.
 *
 * `cwd` and `additionalDirectories` are passed to agy as `--add-dir`, and that
 * is measurably what makes agy read the directory the client asked about. It is
 * an **inclusion** hint. It is not a sandbox, and no experiment in this
 * repository has ever tested it as one: every run measured "can agy find the
 * directory we named", none measured "will agy refuse a path we did not".
 *
 * The evidence runs the other way. `tests/fixtures/turn-tool-error.ndjson` is a
 * verbatim recording of one turn in which agy ran `cmd /c dir Z:\no-such-drive-here`,
 * grepped `~/.gemini/antigravity-cli/scratch` and fetched `http://127.0.0.1:9/` —
 * three paths outside the workspace, in a single turn, all executed. Combined
 * with `requestsPermission: false` there is no point at which a client could
 * have intervened.
 *
 * Stated as a negative capability for the same reason as the permission notice:
 * ACP has no field for "the roots I accepted are advisory", and silence there
 * reads as a guarantee.
 */
const AGY_WORKSPACE_NOTICE =
  'cwd and additionalDirectories are passed to agy as --add-dir, which is what ' +
  'makes agy read them. They do NOT confine it: agy runs shell commands, reads ' +
  'URLs and searches its own scratch directory outside those roots, and because ' +
  'no permission request is ever sent, a client cannot stop it. Treat the roots ' +
  'as "where to look", never as a sandbox boundary.';

/** What `initialize` states about the gaps in this transport. */
export const AGY_LIMITATIONS = {
  transport: 'cli',
  /** No `session/request_permission` is ever sent. See {@link AGY_PERMISSION_NOTICE}. */
  requestsPermission: false,
  permissionMode: AGY_PERMISSION_MODE_ID,
  /**
   * `session/load` must stream the whole conversation back. agy print mode
   * cannot dump a transcript, so this adapter advertises `session/resume`
   * instead — which is what it actually implements.
   */
  replaysHistory: false,
  /**
   * A new session pins no model until the client sets the `model` config option;
   * until then agy uses the model saved in its own settings, which another agy
   * client can change between turns. Stated here because "the agent did not
   * mention a model" is otherwise indistinguishable from "the model is fixed".
   */
  pinsModelByDefault: false,
  /**
   * The workspace roots are an inclusion hint, not a boundary. See
   * {@link AGY_WORKSPACE_NOTICE}; measured in `tests/fixtures/turn-tool-error.ndjson`.
   */
  confinesToWorkspace: false,
  /**
   * A model pin is **not** restored by `session/resume` on its own: the process
   * that held the choice is usually gone. The client can carry it back — see
   * {@link pinRestoreMetaKey} — and the resume report says which happened.
   */
  pinSurvivesResume: false,
  /**
   * Where to put the pin on `session/resume` to have it restored: the same
   * `_meta` block this adapter reports on every prompt response, either as
   * `{ modelId }` or as a bare id string.
   *
   * Carrying the block back **unpinned** — `{ pinned: false, modelId: null }`,
   * exactly as reported — is honoured as the instruction it is, and is not the
   * same as omitting the key. Omitting it lets a reconnect inherit whatever pin
   * this adapter process still holds for the session; sending it guarantees no
   * `--model`. See {@link readModelMeta}, where conflating the two produced a
   * response claiming a pin the client had just cleared.
   */
  pinRestoreMetaKey: AGY_MODEL_META_KEY,
  detail: AGY_PERMISSION_NOTICE,
  workspaceDetail: AGY_WORKSPACE_NOTICE,
} as const;

const AGY_SESSION_MODES: SessionModeState = {
  currentModeId: AGY_PERMISSION_MODE_ID,
  availableModes: [
    {
      id: AGY_PERMISSION_MODE_ID,
      name: 'Always proceed (no approval)',
      description: AGY_PERMISSION_NOTICE,
    },
  ],
};

/**
 * Protocol versions this agent actually speaks.
 *
 * `Math.min(params.protocolVersion, PROTOCOL_VERSION)` — what this used to do —
 * cannot express "I do not speak that". Asked for version 0 it answered
 * `protocolVersion: 0`, claiming to speak a version whose wire format this build
 * has never emitted, and the client then had no reason to disconnect. ACP's own
 * rule is the opposite: answer with the client's version *if supported*,
 * otherwise with the latest the agent supports, and let the client decide to
 * hang up.
 */
export const AGY_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/**
 * Read the conversation id out of an ACP `_meta` bag. Never trusts its shape.
 *
 * Returns which key it came from as well as the value, so the caller can log a
 * client that is still on the pre-namespace key instead of silently carrying it
 * forever.
 */
export function readConversationMeta(
  meta: unknown,
): { readonly conversationId: string; readonly key: string } | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const bag = meta as Record<string, unknown>;
  for (const key of [AGY_CONVERSATION_META_KEY, AGY_CONVERSATION_META_KEY_LEGACY]) {
    const value = bag[key];
    if (typeof value === 'string' && value !== '') return { conversationId: value, key };
  }
  return null;
}

/**
 * What a client's `_meta` said about the model pin.
 *
 * Three states, not two, and that distinction is the whole type. `absent` and
 * `unpinned` are opposite instructions — "I am not telling you anything about
 * the model" versus "do not pin one" — and collapsing them into a single `null`
 * is what let an explicit "not pinned" fall through a `??` chain into whatever
 * pin this process happened to be holding. See {@link readModelMeta}.
 */
export type AgyCarriedModelPin =
  /** The key was not there, or held nothing this function can read. */
  | { readonly kind: 'absent' }
  /** The client said, in so many words, that this session pins no model. */
  | { readonly kind: 'unpinned' }
  /** The client named a model to resume on. Not yet checked against the catalog. */
  | { readonly kind: 'pinned'; readonly modelId: string };

const CARRIED_PIN_ABSENT: AgyCarriedModelPin = { kind: 'absent' };
const CARRIED_PIN_UNPINNED: AgyCarriedModelPin = { kind: 'unpinned' };

/** A carried id, once it is known to be a string: sentinel, or a real pin. */
function carriedPinFromId(value: string): AgyCarriedModelPin {
  if (value === AGY_MODEL_UNPINNED_VALUE) return CARRIED_PIN_UNPINNED;
  // An empty string names no model and is not the sentinel: unreadable, so it
  // is not treated as an instruction either way.
  return value === '' ? CARRIED_PIN_ABSENT : { kind: 'pinned', modelId: value };
}

/**
 * Read a model pin back out of an ACP `_meta` bag. Never trusts its shape.
 *
 * The symmetric half of {@link AGY_MODEL_META_KEY}: this adapter reports the
 * pinned model on every response a client might persist, so a client that stores
 * that block and hands it back on `session/resume` is doing exactly what it does
 * with the conversation id. Without this, a resumed session was always unpinned
 * and a desktop that resumed and prompted ran on agy's persisted default — a
 * model another agy client can change between turns.
 *
 * **It returns three states because the client can say three things**, and this
 * function used to return two. `{ pinned: false, modelId: null }` — the block
 * `modelMeta()` emits for an unpinned session, and the one
 * `AGY_LIMITATIONS.pinRestoreMetaKey` tells clients to persist — came back as
 * the same `null` as an absent key. `AgyAgent.resumeSession` then read that
 * `null` as "the client said nothing" and fell through to the pin this process
 * still held, so a reconnect that faithfully carried "unpinned" was answered
 * with `pinned: true`, a picker whose `currentValue` agreed, and a `--model` in
 * the next turn's argv. Nothing failed; the experiment record was simply wrong
 * about what produced the answer, which is the one outcome this whole model
 * pipeline exists to prevent.
 *
 * Accepts what this adapter emits (`{ pinned, modelId }`) and a bare id string,
 * because both are plausible things to have stored. Two rules decide the rest:
 *
 * - **`modelId` outranks `pinned`.** Only `modelId` reaches argv; `pinned` is a
 *   description of it. So `{ pinned: true, modelId: null }` names no model and
 *   is read as unpinned rather than as licence to reuse an in-process pin. ACP
 *   types `_meta` as `additionalProperties: true`, so no schema validation will
 *   ever reject that shape — this rule is the only thing standing between it and
 *   a wrong record.
 * - **Unreadable is `absent`, never `unpinned`.** Garbage must not be able to
 *   drop a pin; falling back to what this process holds is at least attributable
 *   (the resume report calls it `in-process`).
 */
export function readModelMeta(meta: unknown): AgyCarriedModelPin {
  if (typeof meta !== 'object' || meta === null) return CARRIED_PIN_ABSENT;
  const carried = (meta as Record<string, unknown>)[AGY_MODEL_META_KEY];
  if (typeof carried === 'string') return carriedPinFromId(carried);
  if (typeof carried !== 'object' || carried === null || Array.isArray(carried)) {
    return CARRIED_PIN_ABSENT;
  }
  const block = carried as { modelId?: unknown; pinned?: unknown };
  if ('modelId' in block) {
    if (block.modelId === null) return CARRIED_PIN_UNPINNED;
    return typeof block.modelId === 'string'
      ? carriedPinFromId(block.modelId)
      : CARRIED_PIN_ABSENT;
  }
  // No `modelId` at all. A bare `pinned: false` is still a statement; anything
  // else in the bag is not one this function can act on.
  return block.pinned === false ? CARRIED_PIN_UNPINNED : CARRIED_PIN_ABSENT;
}

/**
 * The shape of an agy conversation id.
 *
 * agy names conversations with a UUID: every one of the 214 files in
 * `~/.gemini/antigravity-cli/conversations/` on this machine is
 * `<uuid>.db`, with zero exceptions, and every id in this package's recorded
 * fixtures matches too (`e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3`).
 *
 * This is a *shape* check and nothing more — it cannot tell a live conversation
 * from a deleted one. What it does catch is the case that used to read as
 * success: a typo, a truncated paste, or a client handing over an id from some
 * other agent entirely. Measured before this existed:
 * `session/resume { sessionId: 'nope-does-not-exist' }` returned OK and echoed
 * the string back as the conversation id, and the failure surfaced one prompt
 * later as an unrelated agy error.
 */
export const AGY_CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string could be an agy conversation id. Shape only; see the pattern. */
export function looksLikeAgyConversationId(value: string): boolean {
  return AGY_CONVERSATION_ID_PATTERN.test(value);
}

/** Where a resumed session's conversation id came from, and what that is worth. */
export type AgyConversationIdSource =
  /** This adapter process watched agy mint it on an `init` event. */
  | 'observed'
  /** The client sent it back in `_meta`. Shape-checked only. */
  | 'client-meta'
  /** The client named it as the ACP session id. Shape-checked only. */
  | 'session-id'
  /** The session exists but has had no turn, so there is no id to check. */
  | 'none';

/** One ACP session is one agy conversation. */
interface AgySession {
  readonly sessionId: string;
  readonly cwd: string;
  /** ACP `additionalDirectories`: extra workspace roots, `cwd` excluded. */
  readonly additionalDirectories: readonly string[];
  /** Assigned by agy on the first turn's `init` event; needed for `--conversation`. */
  conversationId: string | null;
  /** How {@link conversationId} was obtained, and therefore what it is worth. */
  conversationIdSource: AgyConversationIdSource;
  /**
   * The `--model` id this session's turns run on, or `null` for "the client
   * never chose", which means agy's own persisted default. Never resolved
   * behind the client's back; see {@link AGY_MODEL_META_KEY}.
   */
  model: string | null;
  /** Aborts the turn in flight, if any. */
  abort: AbortController | null;
}

/**
 * The id of the one session config option this adapter offers.
 *
 * ACP's answer to "let the user pick a model" is `session/set_config_option`
 * with a `category: "model"` select returned from `session/new` — the same
 * mechanism both other shipping ACP agents use. There is no `--model` field on
 * any request, so a client that wanted to choose had nothing to send, and this
 * adapter had nothing to read: `buildAgyArgv` never emitted `--model` at all.
 */
export const AGY_MODEL_CONFIG_ID = 'model';

/**
 * The `currentValue` meaning "no model was chosen".
 *
 * A real, selectable value rather than an absent one, because ACP requires
 * `currentValue` to name an option and because the state *is* meaningful: it is
 * the state in which the turn runs on whatever `~/.gemini/antigravity-cli/settings.json`
 * happens to hold, which another tool can change between two turns of the same
 * session. Making it visible in the picker is the point — a client that renders
 * the model selector now renders the words "not pinned".
 */
export const AGY_MODEL_UNPINNED_VALUE = 'agy-persisted-default';

export interface AgyAgentOptions {
  readonly transport: AgyTransport;
  /** Diagnostics and unmapped wire shapes. Defaults to dropping them. */
  readonly logger?: (message: string) => void;
  /** Injected so session ids are deterministic in tests. */
  readonly newSessionId?: () => string;
  /**
   * How long this layer holds a working catalog before asking the transport
   * again. See {@link AgyAgent.models} — this is a burst limiter, and it must
   * stay well under the transport's own refresh interval or it becomes the thing
   * that decides how stale the model list gets.
   */
  readonly modelCatalogTtlMs?: number;
}

/**
 * How long {@link AgyAgent} reuses a catalog before re-asking the transport.
 *
 * Short on purpose, and much shorter than `AgyCliTransportOptions.modelListTtlMs`
 * (10 minutes). Asking the transport again is a method call, not a subprocess:
 * the transport answers from its own cache and decides for itself whether a
 * refresh is due. One minute is enough to collapse the burst a client makes
 * (`session/new`, prompt, two `set_config_option`) into one call, and short
 * enough that the transport's refresh policy is what governs staleness.
 */
export const AGY_MODEL_CATALOG_TTL_MS = 60_000;

/**
 * The `_meta` fragment announcing a session's agy conversation id, spread into an
 * ACP payload. Empty until agy has named the conversation, so `_meta` is never
 * sent carrying a null.
 */
function conversationMeta(session: AgySession): { _meta?: Record<string, unknown> } {
  return session.conversationId === null
    ? {}
    : { _meta: { [AGY_CONVERSATION_META_KEY]: session.conversationId } };
}

/**
 * The `_meta` fragment stating which model a turn ran on — or that nothing was
 * chosen and agy picked for us.
 *
 * Always present, never conditional. "No model was pinned" is the reading that
 * a client, a log line and an experiment's record most need, and it is exactly
 * the one an omitted field cannot express.
 */
function modelMeta(session: AgySession, catalog: AgyModelCatalog): Record<string, unknown> {
  if (session.model !== null) {
    return {
      [AGY_MODEL_META_KEY]: {
        pinned: true,
        modelId: session.model,
        detail: `every turn in this session is launched with --model ${session.model}`,
      },
    };
  }
  const fallback = catalog.persistedDefault;
  return {
    [AGY_MODEL_META_KEY]: {
      pinned: false,
      modelId: null,
      agySavedDefault: fallback === null ? null : { id: fallback.id, name: fallback.name },
      detail:
        `no model was chosen, so no --model is passed and agy uses the model saved in ` +
        `its own settings` +
        (fallback === null
          ? ` (this adapter could not read which one that is)`
          : ` — currently "${fallback.name}"`) +
        `. Another tool can change that between two turns of this session; set ` +
        `configOption "${AGY_MODEL_CONFIG_ID}" for a run that can be reproduced.`,
    },
  };
}

/** What a `session/resume` response says about how much it could check. */
const RESUME_DETAIL: Record<AgyConversationIdSource, string> = {
  observed:
    'this adapter process watched agy mint this conversation id on an init event, ' +
    'so it named a real conversation at that moment. That is provenance, not a ' +
    'liveness check: agy print mode cannot be asked whether a conversation still ' +
    'exists without spending a turn, so nothing here proves it is still there',
  'client-meta':
    'the conversation id came from the client and has been checked for shape only. ' +
    'agy print mode offers no way to ask whether a conversation exists without ' +
    'spending a turn, so this resume is NOT proof the conversation is still there — ' +
    'the next prompt is what will find out',
  'session-id':
    'the ACP session id was itself taken as the agy conversation id, and has been ' +
    'checked for shape only. agy print mode offers no way to ask whether a ' +
    'conversation exists without spending a turn, so this resume is NOT proof the ' +
    'conversation is still there — the next prompt is what will find out',
  none:
    'this session has no agy conversation id yet because no turn has run in it; ' +
    'the next prompt starts a fresh agy conversation',
};

/**
 * Where the model pin a resumed session ended up with came from.
 *
 * Four values because there are four stories, and two of them end unpinned for
 * opposite reasons: the client asked for no pin, or there was no pin to be had.
 * A single "not pinned" with one explanation for both is how a field stops being
 * read.
 */
type AgyResumePinSource =
  /** The client carried an id in `_meta` and it was accepted. */
  | 'client-meta'
  /** The client carried an explicit "not pinned" block. This is a decision. */
  | 'client-unpinned'
  /** Nothing was carried; this process still held the session, and its pin. */
  | 'in-process'
  /** Nothing was carried and this process holds no pin for the session either. */
  | 'none';

/**
 * The `_meta` block stating what a resume actually established.
 *
 * The honest half of {@link AgyAgent.resumeSession}: a shape check is not an
 * existence check, and a response that only echoed the id back could not tell
 * the two apart.
 *
 * **There is no `verified` boolean, and removing one is what fixed it.** It was
 * `conversationIdSource === 'observed'`, and every client that did what this
 * adapter documents — persist the id, hand it back on resume — took the `_meta`
 * branch, which was hard-coded to `client-meta`. So the field was `false`
 * precisely for compliant clients and `true` only for one that sent nothing, and
 * `cliTransport` suppresses the `conversation` event once a conversation id is
 * passed in, so it could never recover. The provenance bug is fixed below; the
 * boolean is gone rather than repaired, because even at its best it would
 * promise more than this transport can deliver — watching agy mint an id says it
 * existed then, not that it exists now. `source` and `detail` carry both facts
 * without offering a client a checkmark to render.
 *
 * `model` is the same idea one level down. A resume that drops a model pin is
 * not wrong — the choice may really be gone, or the client may have asked for no
 * pin — but a client that resumes and prompts without noticing runs the next
 * turn on agy's persisted default, which is the one outcome the model plumbing
 * exists to prevent. So the state is stated, *with its cause*, rather than left
 * to be inferred from a `pinned: false` somewhere else in the bag.
 */
function resumeReport(
  session: AgySession,
  pinSource: AgyResumePinSource,
): Record<string, unknown> {
  const unpinnedTail =
    `Until the client sets configOption "${AGY_MODEL_CONFIG_ID}" (or resumes again ` +
    `carrying _meta.${AGY_MODEL_META_KEY}.modelId), every turn runs on agy's own ` +
    `saved default, which another agy client can change between turns.`;
  return {
    conversationId: session.conversationId,
    source: session.conversationIdSource,
    detail: RESUME_DETAIL[session.conversationIdSource],
    model:
      session.model !== null
        ? {
            pinned: true,
            modelId: session.model,
            source: pinSource,
            detail:
              (pinSource === 'client-meta'
                ? `the model pin was restored from _meta.${AGY_MODEL_META_KEY}, which is ` +
                  `where this adapter reports it on every prompt response`
                : `this adapter process still holds the session, so its model pin was ` +
                  `never lost`) + `; turns resume with --model ${session.model}`,
          }
        : {
            pinned: false,
            modelId: null,
            source: pinSource,
            detail:
              pinSource === 'client-unpinned'
                ? `THIS SESSION IS NOT PINNED TO A MODEL, which is what the client asked ` +
                  `for: _meta.${AGY_MODEL_META_KEY} carried an explicit "not pinned" ` +
                  `block, and it was taken as the decision it is rather than folded into ` +
                  `"the client said nothing". No --model is sent. ${unpinnedTail}`
                : `THIS SESSION IS NOT PINNED TO A MODEL. Nothing was carried in ` +
                  `_meta.${AGY_MODEL_META_KEY} and this adapter process holds no pin for ` +
                  `it — either it never had one, or the process that made the choice is ` +
                  `gone, since a pin does not survive one. ${unpinnedTail}`,
          },
  };
}

/**
 * The ACP `configOptions` list for a session: today, the model selector.
 *
 * The unpinned sentinel is always first and always present, even when agy could
 * be asked for a model list — deselecting is a state the user can be in, and a
 * picker that cannot express it would have to lie about what an unpinned session
 * is doing.
 */
export function buildConfigOptions(
  catalog: AgyModelCatalog,
  currentModel: string | null,
): SessionConfigOption[] {
  const fallback = catalog.persistedDefault;
  return [
    {
      type: 'select',
      id: AGY_MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      description:
        `Which model agy runs this session's turns on. Anything other than ` +
        `"not pinned" is passed to agy as --model, which is what makes a run repeatable.`,
      currentValue: currentModel ?? AGY_MODEL_UNPINNED_VALUE,
      options: [
        {
          value: AGY_MODEL_UNPINNED_VALUE,
          name:
            fallback === null
              ? "Not pinned — agy's saved default"
              : `Not pinned — agy's saved default (${fallback.name})`,
          description:
            `No --model flag is sent. agy uses the model in ` +
            `~/.gemini/antigravity-cli/settings.json, which any other agy client can ` +
            `change between turns, so two identical prompts can run on two different ` +
            `models without anything saying so.`,
        },
        ...catalog.models.map((model) => ({
          value: model.id,
          name: model.name,
          description: `--model ${model.id}`,
        })),
      ],
      _meta: {
        pinned: currentModel !== null,
        agySavedDefault: fallback === null ? null : { id: fallback.id, name: fallback.name },
        // Empty `models` is not a UI quirk; it means agy could not be asked, and
        // the reason belongs next to the evidence of it.
        catalogDiagnostics: catalog.diagnostics,
      },
    },
  ];
}

/**
 * A session id that names no live session.
 *
 * `-32002` ("Resource not found") rather than the bare `Error` this used to
 * throw. A bare `Error` reaches the client as `-32603 Internal error`, which is
 * the code for "the agent broke" — so a client could not tell *"your session
 * expired, reopen it"* from *"this agent is dead, give up"*, and the only
 * difference that matters to a user is whether retrying helps.
 */
function unknownSession(sessionId: string): RequestError {
  return new RequestError(
    -32002,
    `unknown session ${sessionId}: this adapter process has no such session. ` +
      `Open one with session/new, or re-attach with session/resume carrying ` +
      `_meta.${AGY_CONVERSATION_META_KEY}.`,
    { sessionId, metaKey: AGY_CONVERSATION_META_KEY },
  );
}

/**
 * The local filesystem path a `resource_link` URI names, or `null`.
 *
 * `file:` URIs are what a client sends for a workspace file. Anything else
 * (`https:`, an agent-private scheme) has no path to add to agy's workspace, and
 * saying so is the caller's job — see {@link FlattenedPrompt.diagnostics}.
 * A bare absolute path is accepted too: it is not a URI, but clients send it.
 */
export function resourceLinkPath(uri: string): string | null {
  if (uri.startsWith('file:')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  // A scheme followed by `:` is a URI, not a path — `isAbsolute` would happily
  // accept `https://example.com/x` on POSIX.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) && !/^[a-zA-Z]:[\\/]/.test(uri)) return null;
  return isAbsolute(uri) ? uri : null;
}

export interface FlattenedPrompt {
  /** The single string agy's `-p` takes. */
  readonly text: string;
  /**
   * Directories that must be in agy's workspace for the referenced files to be
   * readable — the parent of each local `resource_link`.
   */
  readonly directories: readonly string[];
  /** Things worth logging: a reference surfaced as text but not as a workspace root. */
  readonly diagnostics: readonly string[];
}

/**
 * The header introducing referenced files in the flattened prompt. agy takes one
 * string, so a reference can only survive as text; this is that text.
 */
const REFERENCE_HEADER =
  'Referenced files (they are in your workspace — open them before answering):';

/**
 * Flatten ACP prompt content blocks into the single string agy's `-p` takes.
 *
 * **`resource_link` is baseline, not optional.** The official schema makes Text
 * and ResourceLink the two content types every agent must accept, with no
 * capability gate — `promptCapabilities` only gates image, audio and embedded
 * resources. This function used to keep `block.type === 'text'` and drop the
 * rest: measured at 4 blocks in, two file references gone, no error, no
 * diagnostic, `stopReason: end_turn`, and agy then answering confidently about
 * files it had never been shown. So the links are rendered into the prompt, and
 * their directories are handed to the transport as `--add-dir` roots by the
 * caller, which is what makes the files actually readable.
 *
 * Anything else throws. `image`, `audio` and `resource` are exactly the three
 * this agent advertises as `false` in `promptCapabilities`, so a client sending
 * one is violating what it was told at `initialize` — `-32602 Invalid params`
 * naming the offending type is a failure it can see and fix. The one thing that
 * must not happen again is the block quietly disappearing.
 */
export function flattenPrompt(blocks: PromptRequest['prompt']): FlattenedPrompt {
  const parts: string[] = [];
  const references: string[] = [];
  const directories: string[] = [];
  const diagnostics: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') parts.push(block.text);
        break;

      case 'resource_link': {
        const path = resourceLinkPath(block.uri);
        references.push(`- ${block.name}: ${path ?? block.uri}`);
        if (path === null) {
          diagnostics.push(
            `resource_link ${block.uri} names no local path; it is in the prompt text ` +
              `but no workspace root was added for it`,
          );
          break;
        }
        const directory = dirname(path);
        if (!directories.includes(directory)) directories.push(directory);
        break;
      }

      default: {
        const type = (block as { type?: unknown }).type;
        throw RequestError.invalidParams(
          {
            blockType: typeof type === 'string' ? type : 'unknown',
            supported: ['text', 'resource_link'],
          },
          `this agent accepts only text and resource_link prompt content, and ` +
            `advertises image, audio and embeddedContext as false at initialize; ` +
            `got a "${typeof type === 'string' ? type : 'unknown'}" block. ` +
            `It is rejected rather than dropped so the loss is visible.`,
        );
      }
    }
  }

  const text =
    references.length === 0
      ? parts.join('\n')
      : [...parts, REFERENCE_HEADER, ...references].join('\n');

  return { text, directories, diagnostics };
}

/** Concatenate two root lists, preserving order and dropping repeats. */
function mergeDirectories(
  sessionRoots: readonly string[],
  promptRoots: readonly string[],
): string[] {
  const merged: string[] = [];
  for (const directory of [...sessionRoots, ...promptRoots]) {
    if (typeof directory !== 'string' || directory === '') continue;
    if (!merged.includes(directory)) merged.push(directory);
  }
  return merged;
}

export class AgyAgent implements Agent {
  readonly #connection: AgentSideConnection;
  readonly #transport: AgyTransport;
  readonly #log: (message: string) => void;
  readonly #newSessionId: () => string;
  readonly #sessions = new Map<string, AgySession>();
  readonly #catalogTtlMs: number;
  /** The last catalog that listed models, and when this layer fetched it. */
  #catalog: AgyModelCatalog | null = null;
  #catalogAt = 0;
  /** The load in flight, so concurrent callers cost one transport call. */
  #catalogInFlight: Promise<AgyModelCatalog> | null = null;

  constructor(connection: AgentSideConnection, options: AgyAgentOptions) {
    this.#connection = connection;
    this.#transport = options.transport;
    this.#log = options.logger ?? (() => {});
    this.#catalogTtlMs = options.modelCatalogTtlMs ?? AGY_MODEL_CATALOG_TTL_MS;
    this.#newSessionId =
      options.newSessionId ??
      (() =>
        `${SESSION_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const protocolVersion = AGY_SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : PROTOCOL_VERSION;
    if (protocolVersion !== params.protocolVersion) {
      this.#log(
        `[protocol_version] client asked for ${String(params.protocolVersion)}; ` +
          `this agent speaks ${AGY_SUPPORTED_PROTOCOL_VERSIONS.join(', ')} — ` +
          `answering ${String(protocolVersion)}`,
      );
    }

    return {
      protocolVersion,
      agentCapabilities: {
        // Explicitly false, not merely absent. `session/load` must stream the
        // whole conversation history back as notifications; agy print mode
        // cannot replay a transcript, and this adapter replayed exactly zero.
        // A third-party client that took the old `loadSession: true` at its word
        // called `session/load`, got `-32002`, and exited 4. What we do have is
        // resume — continue a conversation without replaying it — so that is
        // what is advertised, under the capability the spec gives it.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: {
          resume: {},
          additionalDirectories: {},
        },
        _meta: { [AGY_LIMITATIONS_META_KEY]: AGY_LIMITATIONS },
      },
      // agy authenticates out of band (its own login, system keyring). There is
      // nothing for the client to do, so it is offered no methods.
      authMethods: [],
    };
  }

  async authenticate(): Promise<AuthenticateResponse> {
    return {};
  }

  /**
   * The transport's model list — held briefly, then asked for again.
   *
   * This layer exists to collapse a burst. One client interaction hits it four
   * or five times (`session/new`, each prompt, each `set_config_option`), and a
   * transport that forgot to cache would pay a subprocess for every one of them.
   * That is all it is for: **the transport owns the caching policy**, and this
   * method must not quietly take that job away from it.
   *
   * It did. This was `const cached = this.#catalog; if (cached !== null) return
   * cached;` — no expiry — and it is the only production caller of
   * `transport.listModels()`, so `AgyCliTransport`'s stale-while-revalidate path
   * could not be reached from any shipping configuration: measured with
   * `modelListTtlMs = 1`, four `session/new` plus a prompt plus two
   * `set_config_option` spawned `agy models` exactly once, and the transport's
   * refresh test passed while proving a feature nothing could use. The
   * consequence is not abstract: a model agy retires upstream stays in the
   * picker, is accepted by `setSessionConfigOption`, goes into argv, and fails
   * five seconds later inside agy — which is the exact failure that validation
   * exists to prevent. Round 8 cured "a failure is permanent"; this was "a
   * success is permanent", the same disease one level up.
   *
   * So the entry expires ({@link AGY_MODEL_CATALOG_TTL_MS}: one minute, against
   * the transport's ten). Re-asking costs a method call, not a spawn — the
   * transport answers from its own cache and decides for itself whether a
   * refresh is due. Two caches, one policy, and the invariant that keeps them
   * from contradicting each other is that this TTL stays well under the
   * transport's, so it is never the thing that decides how stale a list may get.
   *
   * **A catalog that lists nothing is not kept at all.** Nothing in it can be
   * pinned, so there is nothing worth remembering, and keeping it was J2: one
   * failed `agy models` at startup answered every later `set_config_option` with
   * `-32602` until the process was restarted. The transport owns the retry
   * cooldown that stops a broken agy being re-spawned per request; this layer
   * only refuses to be the thing that makes a failure permanent. Concurrent
   * callers share one in-flight call whatever the TTL is.
   */
  async #models(): Promise<AgyModelCatalog> {
    const cached = this.#catalog;
    if (cached !== null && Date.now() - this.#catalogAt < this.#catalogTtlMs) return cached;
    const inFlight = this.#catalogInFlight;
    if (inFlight !== null) return inFlight;

    const pending = (async () => {
      try {
        const catalog = await this.#load();
        if (catalog.models.length > 0) {
          this.#catalog = catalog;
          this.#catalogAt = Date.now();
        } else {
          this.#catalog = null;
        }
        return catalog;
      } finally {
        // Cleared in a `finally` so a logger that throws cannot park a rejected
        // promise here to be handed to every future caller — the permanent
        // failure again, by a different route.
        this.#catalogInFlight = null;
      }
    })();
    this.#catalogInFlight = pending;
    return pending;
  }

  /**
   * One `listModels` attempt, turned into a catalog whatever happens.
   *
   * `listModels` is documented as never rejecting, and the `cli` transport does
   * not — but a session that cannot offer a picker is still a usable session,
   * and letting a rejection here fail `session/new` (or worse, a prompt) would
   * trade a missing feature for a dead one.
   */
  async #load(): Promise<AgyModelCatalog> {
    try {
      const catalog = await this.#transport.listModels();
      for (const diagnostic of catalog.diagnostics) this.#log(`[models] ${diagnostic}`);
      return catalog;
    } catch (error: unknown) {
      const detail = `listModels failed: ${String(error)}`;
      this.#log(`[models] ${detail}`);
      return { models: [], persistedDefault: null, diagnostics: [detail] };
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = this.#newSessionId();
    const session: AgySession = {
      sessionId,
      cwd: params.cwd,
      additionalDirectories: [...(params.additionalDirectories ?? [])],
      conversationId: null,
      conversationIdSource: 'none',
      // Deliberately not pre-filled with the catalog's default. Resolving it
      // here would make every session look pinned while `--model` was still
      // absent from argv — the exact confusion this option exists to remove.
      model: null,
      abort: null,
    };
    this.#sessions.set(sessionId, session);
    const catalog = await this.#models();
    // `modes` is how the client learns, in a field it already renders, that
    // every tool in this session runs unapproved; `configOptions` is the same
    // trick for the model — a field clients already render, rather than a
    // `_meta` bag they may never read.
    return {
      sessionId,
      modes: AGY_SESSION_MODES,
      configOptions: buildConfigOptions(catalog, session.model),
      _meta: modelMeta(session, catalog),
    };
  }

  /**
   * Pick a model for a session.
   *
   * The whole of `session/set_config_option` for this adapter, and the only way
   * `--model` ever reaches agy. Every rejection path below exists because the
   * alternative is a session that reports a model it is not running.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (session === undefined) throw unknownSession(params.sessionId);

    if (params.configId !== AGY_MODEL_CONFIG_ID) {
      throw RequestError.invalidParams(
        { configId: params.configId, availableConfigIds: [AGY_MODEL_CONFIG_ID] },
        `this agent has one session config option, "${AGY_MODEL_CONFIG_ID}"; ` +
          `got "${params.configId}".`,
      );
    }
    if (typeof params.value !== 'string') {
      // The only boolean-typed request shape ACP defines, and this agent
      // advertises no boolean option to make it valid.
      throw RequestError.invalidParams(
        { configId: params.configId, expected: 'select' },
        `"${AGY_MODEL_CONFIG_ID}" is a select, not a boolean.`,
      );
    }

    const catalog = await this.#models();
    const chosen = params.value;
    if (chosen !== AGY_MODEL_UNPINNED_VALUE && !catalog.models.some((m) => m.id === chosen)) {
      // Accepting an unknown id would put it straight into argv, and agy fails
      // the turn — five seconds and one spawn later, with the reason buried in
      // stderr. Rejecting here names the ids that do work.
      throw RequestError.invalidParams(
        {
          configId: params.configId,
          value: chosen,
          availableValues: [AGY_MODEL_UNPINNED_VALUE, ...catalog.models.map((m) => m.id)],
          catalogDiagnostics: catalog.diagnostics,
        },
        `"${chosen}" is not a model agy offers. ` +
          (catalog.models.length === 0
            ? // "right now", not "in this process" — the same words the resume
              // path uses, and for the same reason: a failed `agy models` is
              // retried, so this is a state to try again from, not one that
              // needs a restart. The old phrasing was left behind by the fix
              // that made it untrue, and it sends a user to restart an adapter
              // that would have worked on the next call.
              `This adapter could not retrieve agy's model list, so no model can be ` +
              `pinned right now: ${catalog.diagnostics.join('; ')}. The list is ` +
              `re-fetched, so this is worth retrying.`
            : `Choose one of: ${catalog.models.map((m) => m.id).join(', ')} — or ` +
              `"${AGY_MODEL_UNPINNED_VALUE}" to send no --model at all.`),
      );
    }

    session.model = chosen === AGY_MODEL_UNPINNED_VALUE ? null : chosen;
    return {
      configOptions: buildConfigOptions(catalog, session.model),
      _meta: modelMeta(session, catalog),
    };
  }

  /**
   * Resume — ACP's "continue this conversation **without** replaying its
   * history", which is precisely what this adapter can do and `session/load` is
   * not. The agy conversation id is the only thing worth restoring, and the
   * client is the one that stored it: it was handed out in `_meta` on every
   * update and every prompt response.
   *
   * Four ways in, in order of authority; the last one is a genuine failure and
   * says so rather than opening a fresh conversation behind the client's back.
   *
   * **A foreign id is checked, and what could not be checked is said.** This
   * method used to accept literally any string that was not one of ours as an
   * agy conversation id: `session/resume { sessionId: 'nope-does-not-exist' }`
   * returned OK and echoed it back in `_meta`, and the client only found out at
   * the next prompt. Two things changed. The id must now look like an agy
   * conversation id ({@link AGY_CONVERSATION_ID_PATTERN}) or the request is
   * `-32602` — which catches typos and ids belonging to some other agent. And
   * because shape is all this transport can check (agy print mode offers no way
   * to ask "does this conversation exist" short of spending a turn), the
   * response says so outright in `_meta.${@link AGY_RESUME_META_KEY}`, as a
   * `source` and a sentence rather than as a boolean — see {@link resumeReport}
   * for why the boolean was deleted instead of repaired.
   *
   * **The model pin is whatever the client said, including "nothing".** A
   * resumed session used to be unconditionally unpinned, so a desktop that
   * resumed and prompted without re-sending `set_config_option` ran on agy's
   * persisted default — visible only to whoever went looking for `pinned: false`.
   * Now `_meta.${@link AGY_MODEL_META_KEY}` is read back
   * ({@link readModelMeta}) as three states, not two: an id agy does not offer
   * is `-32602` rather than a quiet downgrade, an explicit "not pinned" is
   * honoured *even when this process is still holding a pin*, silence falls
   * through to the pin this process holds, and every one of those outcomes is
   * named in the resume report and in the log.
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const fromMeta = readConversationMeta(params._meta);
    if (fromMeta !== null && fromMeta.key === AGY_CONVERSATION_META_KEY_LEGACY) {
      this.#log(
        `[resume] client sent the conversation id under the pre-namespace key ` +
          `"${AGY_CONVERSATION_META_KEY_LEGACY}"; it is accepted for one version. ` +
          `Persist "${AGY_CONVERSATION_META_KEY}" instead — it is what this adapter emits.`,
      );
    }
    const known = this.#sessions.get(params.sessionId);

    let conversationId: string | null;
    let source: AgyConversationIdSource;
    if (fromMeta !== null) {
      conversationId = this.#validateForeignConversationId(
        fromMeta.conversationId,
        `_meta.${fromMeta.key}`,
      );
      // Compared, not assumed. This branch used to hard-code `client-meta`,
      // which graded the client that follows this adapter's own instructions —
      // persist the id, send it back — below one that sent nothing at all, and
      // the `cli` transport announces no `conversation` event once an id is
      // passed in, so the session could never work its way back up. If the id
      // matches the one this process watched agy mint, that is what it is.
      source =
        known !== undefined &&
        known.conversationId === conversationId &&
        known.conversationIdSource === 'observed'
          ? 'observed'
          : 'client-meta';
      if (known?.conversationId != null && known.conversationId !== conversationId) {
        // Two ids for one session decides which agy conversation the next turn
        // continues. The client's wins — it is the explicit instruction, and it
        // may be resuming a session id this process reused — but silence here
        // would hide a client-side store that has them crossed.
        this.#log(
          `[resume] session ${params.sessionId} carried conversation id ` +
            `"${conversationId}" in _meta.${fromMeta.key}, which disagrees with the id ` +
            `this process holds for it ("${known.conversationId}", obtained: ` +
            `${known.conversationIdSource}). The carried id is used; the next turn ` +
            `continues that conversation.`,
        );
      }
    } else if (known !== undefined) {
      // Ours, still in memory. `null` here is honest: no turn has run yet, so
      // there is no agy conversation to restore and nothing is being lost.
      conversationId = known.conversationId;
      source = known.conversationId === null ? 'none' : known.conversationIdSource;
    } else if (!params.sessionId.startsWith(SESSION_PREFIX)) {
      // Not an id we minted, so the client is naming the agy conversation itself.
      conversationId = this.#validateForeignConversationId(params.sessionId, 'sessionId');
      source = 'session-id';
    } else {
      // One of ours, from a previous adapter process, and the client kept no
      // conversation id. There is nothing to resume from. -32002 is ACP's
      // "Resource not found"; its factory only emits a generic message, so the
      // error is built by hand to say what the client has to do differently.
      throw new RequestError(
        -32002,
        `cannot resume session ${params.sessionId}: no agy conversation id. ` +
          `Send it back as _meta.${AGY_CONVERSATION_META_KEY}; it is reported on ` +
          `every session update and on every prompt response.`,
        { sessionId: params.sessionId, metaKey: AGY_CONVERSATION_META_KEY },
      );
    }

    const catalog = await this.#models();
    // Usually the adapter that ran the earlier turns is gone and its model
    // choice went with it — so the client is allowed to hand the pin back,
    // exactly as it hands back the conversation id, out of the same `_meta`
    // block this adapter reported on every prompt response. Nothing is inferred:
    // a resume that ends up with no pin says so in the resume report.
    const carriedModel = readModelMeta(params._meta);
    if (
      carriedModel.kind === 'pinned' &&
      !catalog.models.some((m) => m.id === carriedModel.modelId)
    ) {
      // Refused rather than downgraded to unpinned. A client that asked to
      // resume *on a specific model* and silently got agy's default is the
      // failure this whole path exists to prevent, and it would be invisible.
      throw RequestError.invalidParams(
        {
          metaKey: AGY_MODEL_META_KEY,
          value: carriedModel.modelId,
          availableValues: [AGY_MODEL_UNPINNED_VALUE, ...catalog.models.map((m) => m.id)],
          catalogDiagnostics: catalog.diagnostics,
        },
        `_meta.${AGY_MODEL_META_KEY} asks to resume pinned to "${carriedModel.modelId}", ` +
          `which is not a model agy offers` +
          (catalog.models.length === 0
            ? ` — this adapter could not retrieve agy's model list, so no model can be ` +
              `pinned right now: ${catalog.diagnostics.join('; ')}. `
            : `. `) +
          `Resume without that key to continue unpinned (every turn then runs on ` +
          `agy's saved default), or send an id agy lists.`,
      );
    }

    // Order of authority, and it is an order of *statements*, not of non-null
    // values. What the client said wins whether it said "pin this" or "pin
    // nothing"; only silence falls through to what this process still holds —
    // which is not a guess either, since a resume of a session still in memory
    // is a reconnect and the adapter that made the choice is the one running.
    //
    // This was `carriedModel ?? known?.model ?? null`, and `??` cannot express
    // the middle case: `readModelMeta` returned `null` for "not pinned" and for
    // "nothing carried" alike, so an explicit "not pinned" fell straight through
    // to the in-process pin and the response asserted `pinned: true` about a
    // session the client had just unpinned. See {@link readModelMeta}.
    const model =
      carriedModel.kind === 'pinned'
        ? carriedModel.modelId
        : carriedModel.kind === 'unpinned'
          ? null
          : (known?.model ?? null);
    const pinSource: AgyResumePinSource =
      carriedModel.kind === 'pinned'
        ? 'client-meta'
        : carriedModel.kind === 'unpinned'
          ? 'client-unpinned'
          : model !== null
            ? 'in-process'
            : 'none';

    const session: AgySession = {
      sessionId: params.sessionId,
      cwd: params.cwd,
      additionalDirectories: [...(params.additionalDirectories ?? [])],
      conversationId,
      conversationIdSource: source,
      model,
      abort: null,
    };
    this.#sessions.set(params.sessionId, session);
    if (model === null) {
      const savedDefault =
        catalog.persistedDefault === null ? '' : ` ("${catalog.persistedDefault.name}")`;
      this.#log(
        pinSource === 'client-unpinned'
          ? // Said out loud even though it is what was asked for, because it is
            // also the case where a pin this process was holding gets dropped.
            `[resume] session ${params.sessionId} resumed unpinned because ` +
              `_meta.${AGY_MODEL_META_KEY} carried an explicit "not pinned" block` +
              (known?.model == null
                ? ''
                : `, which overrides the pin this process still held for it ` +
                  `("${known.model}")`) +
              `; every turn runs on agy's saved default${savedDefault}.`
          : `[resume] session ${params.sessionId} resumed WITHOUT a model pin; every turn ` +
              `runs on agy's saved default${savedDefault}. Set configOption ` +
              `"${AGY_MODEL_CONFIG_ID}", or resume carrying ` +
              `_meta.${AGY_MODEL_META_KEY}.modelId, for a turn that can be reproduced.`,
      );
    }
    // No history is streamed back, and that is what `session/resume` means —
    // the reason this method is not `session/load`. The echoed id lets the
    // client confirm what it actually resumed, and the resume block says how
    // much of that confirmation is worth anything.
    return {
      modes: AGY_SESSION_MODES,
      configOptions: buildConfigOptions(catalog, session.model),
      _meta: {
        ...conversationMeta(session)._meta,
        ...modelMeta(session, catalog),
        [AGY_RESUME_META_KEY]: resumeReport(session, pinSource),
      },
    };
  }

  /**
   * Accept a conversation id the client supplied, or refuse it.
   *
   * `-32602` rather than `-32002`: this is not "I looked and it is gone", it is
   * "that cannot be an agy conversation id at all", and the two want different
   * things from the client — one is retryable with a different id, the other is
   * a bug in what it stored.
   */
  #validateForeignConversationId(candidate: string, where: string): string {
    if (looksLikeAgyConversationId(candidate)) return candidate;
    throw RequestError.invalidParams(
      { [where]: candidate, expectedFormat: 'uuid' },
      `${where} is "${candidate}", which is not the shape of an agy conversation ` +
        `id (a UUID, as agy mints them). This adapter used to accept any string ` +
        `here and report a successful resume, and the mistake only surfaced at the ` +
        `next prompt. Send the id this adapter reported in ` +
        `_meta.${AGY_CONVERSATION_META_KEY}, or open a new session.`,
    );
  }

  /**
   * Accepts the one mode that exists, refuses the rest.
   *
   * Implemented rather than omitted so that a client acting on the
   * `availableModes` it was just handed gets a real answer instead of
   * `-32601 Method not found`. Any other id is `-32602`: the honest reply, since
   * this transport has no way to gate a tool call.
   */
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (this.#sessions.get(params.sessionId) === undefined) {
      throw unknownSession(params.sessionId);
    }
    if (params.modeId !== AGY_PERMISSION_MODE_ID) {
      throw RequestError.invalidParams(
        { modeId: params.modeId, availableModes: [AGY_PERMISSION_MODE_ID] },
        `agy's cli transport has one mode, "${AGY_PERMISSION_MODE_ID}". ` +
          AGY_PERMISSION_NOTICE,
      );
    }
    return {};
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.#sessions.get(params.sessionId)?.abort?.abort();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (session === undefined) throw unknownSession(params.sessionId);

    // Before the abort controller is installed: an unrepresentable content block
    // must fail the request outright, not abandon a half-started turn.
    const flattened = flattenPrompt(params.prompt);
    for (const note of flattened.diagnostics) this.#log(`[prompt_reference] ${note}`);

    // Installed *before* the first await. `session/cancel` is a notification and
    // can arrive at any moment; with the controller installed only after the
    // model catalog resolved, a cancel during that window found `session.abort`
    // still null, did nothing, and agy was spawned anyway.
    const abort = new AbortController();
    session.abort = abort;
    let stopReason: PromptResponse['stopReason'] = 'end_turn';
    let catalog: AgyModelCatalog;

    try {
      // Resolved before the turn so the response can name the model even when
      // the catalog call is what failed. Cached: free after the first turn.
      catalog = await this.#models();
      if (session.model === null) {
        this.#log(
          `[model] session ${session.sessionId} has no model pinned; this turn runs on ` +
            `agy's saved default` +
            (catalog.persistedDefault === null ? '' : ` ("${catalog.persistedDefault.name}")`),
        );
      }
      if (abort.signal.aborted) {
        // Cancelled while the catalog was resolving. Reported as the cancel it
        // is, without spending a spawn on a turn nobody is waiting for.
        return {
          stopReason: 'cancelled',
          _meta: { ...conversationMeta(session)._meta, ...modelMeta(session, catalog) },
        };
      }
      const turn = this.#transport.runTurn({
        prompt: flattened.text,
        cwd: session.cwd,
        // The session's roots plus the ones the prompt's file references need.
        additionalDirectories: mergeDirectories(
          session.additionalDirectories,
          flattened.directories,
        ),
        conversationId: session.conversationId,
        // `null` reaches the transport as `null`, and is reported as such on the
        // response below. It is never quietly resolved to agy's saved default.
        model: session.model,
        signal: abort.signal,
      });

      for await (const event of turn) {
        switch (event.type) {
          case 'conversation':
            session.conversationId = event.conversationId;
            // Watched agy name it: the one provenance a later resume can report
            // as `observed`, whether the client carries the id back or not.
            session.conversationIdSource = 'observed';
            break;
          case 'update':
            await this.#connection.sessionUpdate({
              sessionId: session.sessionId,
              update: event.update,
              // Repeated on every update, not announced once: a client that
              // persists as it renders still has the id if the turn dies midway.
              ...conversationMeta(session),
            });
            break;
          case 'diagnostic':
            this.#log(`[${event.diagnostic.reason}] ${event.diagnostic.detail}`);
            break;
          case 'end':
            stopReason = event.stopReason;
            break;
        }
      }
    } finally {
      session.abort = null;
    }

    // The reliable carrier: a turn can end without emitting a single update, but
    // it always produces this response. It carries the conversation id when there
    // is one, and *always* carries which model the turn ran on — a result whose
    // model is unrecorded cannot be checked against a later one, which is the
    // entire point of running experiments through this adapter.
    return {
      stopReason,
      _meta: { ...conversationMeta(session)._meta, ...modelMeta(session, catalog) },
    };
  }

  /** The agy conversation id for a session, for a client that wants to persist it. */
  conversationIdFor(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.conversationId ?? null;
  }

  /** The `--model` id a session's turns run on, or `null` for agy's saved default. */
  modelFor(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.model ?? null;
  }
}
