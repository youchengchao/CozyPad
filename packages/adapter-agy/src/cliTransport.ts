/**
 * The `cli` transport: one `agy` process per turn, reading its stream-json.
 *
 * See docs/ACP-MIGRATION.md. This path is slow (~5s/turn, a fresh process each
 * time) and cannot ask for approval — agy print mode reports
 * `permission_mode: "always-proceed"` and answers its own questions. It is
 * chosen first because it uses only public flags.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import {
  initialAgyTurnState,
  mapAgyEvent,
  type AcpStopReason,
  type AgyTurnState,
} from './mapper.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  AgyModel,
  AgyModelCatalog,
  AgyTransport,
  AgyTurnEvent,
  AgyTurnRequest,
} from './transport.js';
import { NdjsonLineSplitter, parseAgyLine } from './wire.js';

/** The minimum of a child process this transport touches, so tests can fake it. */
export interface AgyReadableStream {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface AgyChildProcess {
  readonly stdout: AgyReadableStream | null;
  readonly stderr: AgyReadableStream | null;
  kill(): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
}

export interface AgySpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
}

export type AgySpawn = (
  command: string,
  args: readonly string[],
  options: AgySpawnOptions,
) => AgyChildProcess;

export interface AgyCliTransportOptions {
  /** Defaults to `agy.exe` on Windows, `agy` elsewhere; override with COZYPAD_AGY_PATH. */
  readonly executable?: string;
  readonly spawn?: AgySpawn;
  /** agy's stderr and process-level notes. Never routed to the ACP client. */
  readonly logger?: (message: string) => void;
  /**
   * Names each turn, so tool call ids stay unique across a session. Injected
   * only so tests can make them deterministic; see {@link defaultAgyTurnId}.
   */
  readonly newTurnId?: () => string;
  /**
   * Where agy persists the model it uses when `--model` is absent. Defaults to
   * `~/.gemini/antigravity-cli/settings.json`; injected in tests.
   */
  readonly settingsPath?: string;
  /**
   * How long `agy models` may take before the catalog is given up on. It is a
   * network call, and `session/new` waits on it.
   */
  readonly modelListTimeoutMs?: number;
  /**
   * How long a **failed** `agy models` stands before another call retries it.
   *
   * Not zero, because every attempt costs a subprocess and, in the worst case,
   * {@link modelListTimeoutMs} of waiting inside a `session/new` or a prompt —
   * an agy that is down would otherwise pay that on every request. Not infinite
   * either, which is what caching the failure amounted to: see
   * {@link AgyCliTransport.listModels}.
   */
  readonly modelListRetryCooldownMs?: number;
  /**
   * How long a **successful** catalog is served before the next call kicks off a
   * background refresh. `0` disables refreshing entirely.
   *
   * The catalog is a snapshot of what agy offered at one moment; models are
   * added and retired upstream, and a process that never re-asks keeps offering
   * ids that no longer resolve (and hiding ones that now do) until it is
   * restarted. The refresh is deliberately *behind* the answer — the cached
   * catalog is returned immediately — so a stale entry never adds latency to a
   * turn, and a refresh that fails never replaces a catalog that worked.
   */
  readonly modelListTtlMs?: number;
}

/**
 * A name for one turn, unique enough that no two turns a client ever sees share
 * one — which is what ACP requires of the `toolCallId` built from it.
 *
 * Uniqueness has to survive a restarted adapter, not just a running one: a
 * client can resume a session with `session/load` and keep the tool cards it
 * already drew, and a counter that starts over at 1 would then hand the second
 * process's first turn the ids the first process's first turn already used.
 * So the timestamp and the random suffix are both load-bearing — the same
 * construction, and the same reason, as the session ids in `agent.ts`.
 */
export function defaultAgyTurnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultAgyExecutable(): string {
  const configured = process.env.COZYPAD_AGY_PATH;
  if (configured !== undefined && configured !== '') return configured;
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

/**
 * The workspace roots, as agy's repeatable `--add-dir` flag.
 *
 * `cwd` leads, because it is the root the ACP client actually asked for and the
 * one relative paths are meant to resolve against. Duplicates are dropped so a
 * client that repeats `cwd` inside `additionalDirectories` does not produce a
 * doubled flag; the comparison is exact string equality rather than a resolved
 * path, because resolving would rewrite the caller's own spelling and, on
 * Windows, silently reinterpret a POSIX-looking absolute path against the
 * current drive.
 */
function workspaceArgs(cwd: string, additionalDirectories: readonly string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const directory of [cwd, ...additionalDirectories]) {
    if (typeof directory !== 'string') continue;
    const trimmed = directory.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    args.push('--add-dir', trimmed);
  }
  return args;
}

/**
 * Build agy's argv. Pure, and tested — this is where the live-fire bugs show up:
 * a dropped `--conversation` silently loses all context, a prompt passed through
 * a shell silently loses everything after the first space, and a missing
 * `--add-dir` silently answers about the wrong directory.
 *
 * **`--add-dir` is not decoration, and the process cwd is not a substitute.**
 * Measured one lever at a time on agy 1.1.11 (2026-08-07, two agy calls, Sonnet;
 * `tests/fixtures/proveWorkspace.mjs`, table in `tests/fixtures/README.md`):
 *
 * - `--add-dir <workspace>` with the spawn cwd pointed at an unrelated empty
 *   directory → `list_dir` ran in the workspace and found the marker file.
 * - spawn cwd pointed at the workspace with **no** `--add-dir` → agy echoed the
 *   right directory back as `init.cwd`, then ran `list_dir` in
 *   `~/.gemini/antigravity-cli/scratch` and answered "The directory is empty".
 *   Exit 0, `result.status: SUCCESS`, nothing anywhere reporting a problem.
 *
 * So `--add-dir` alone gets agy **into** the directory we name, and the cwd alone
 * does not — which is the good outcome for the remote/SSH path, where the spawn
 * cwd may not be ours to set. The flag is repeatable, which is what
 * `additionalDirectories` needs.
 *
 * **That is inclusion, and inclusion is not scoping.** This comment used to say
 * `cwd` is "worthless for scoping", which reads as a claim that `--add-dir`
 * *does* scope — that agy will stay inside the roots we pass. Nothing here has
 * ever measured that. Both experiments asked "can agy find the directory we
 * named"; neither asked "will agy refuse a path we did not name", and the answer
 * on record is that it will not: `tests/fixtures/turn-tool-error.ndjson` is one
 * real turn in which agy ran `cmd /c dir Z:\no-such-drive-here`, grepped
 * `~/.gemini/antigravity-cli/scratch` and fetched `http://127.0.0.1:9/`, all
 * outside the workspace, under `permission_mode: "always-proceed"` and with no
 * client-side policy able to stop any of it. `--add-dir` is a hint about where
 * to look, not a sandbox; see `AGY_LIMITATIONS.confinesToWorkspace` in
 * `agent.ts`, which is what the client is told.
 *
 * **`--model` is the same class of defect one level up.** Omitting it does not
 * fail; agy silently uses the model saved in `~/.gemini/antigravity-cli/settings.json`,
 * which any other agy client can change between turns. See `AgyTurnRequest.model`.
 */
export function buildAgyArgv(request: {
  readonly prompt: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly conversationId: string | null;
  /** `null` means "emit no `--model`", which is a decision, not an omission. */
  readonly model: string | null;
}): string[] {
  return [
    '-p',
    request.prompt,
    '--output-format',
    'stream-json',
    ...(request.model === null || request.model === '' ? [] : ['--model', request.model]),
    ...workspaceArgs(request.cwd, request.additionalDirectories),
    ...(request.conversationId === null || request.conversationId === ''
      ? []
      : ['--conversation', request.conversationId]),
  ];
}

/** Where agy keeps the model it falls back to when `--model` is absent. */
export function defaultAgySettingsPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Parse `agy models` stdout.
 *
 * The format, measured on agy 1.1.11: a `Fetching available models...` progress
 * line, then one `<id>\t<display name>` line per model. Lines without a tab are
 * progress or noise and are skipped rather than guessed at — an id invented from
 * a banner would be passed to `--model` and rejected a turn later.
 */
export function parseAgyModelList(stdout: string): AgyModel[] {
  const models: AgyModel[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (id === '' || name === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
}

/**
 * Resolve the model agy would use with no `--model`, from its own settings file.
 *
 * `settings.json` stores the **display name** (`"model": "Gemini 3.6 Flash (Low)"`),
 * not the `--model` id, so the name is matched against the catalog to recover an
 * id. An unmatched name is still reported — telling the user "the default is
 * something called X and I could not map it to a flag" is strictly better than
 * reporting no default at all, and better than guessing an id.
 */
export function resolveAgyPersistedDefault(
  settingsJson: string,
  models: readonly AgyModel[],
): AgyModelCatalog['persistedDefault'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const name = (parsed as { model?: unknown }).model;
  if (typeof name !== 'string' || name === '') return null;
  const matched = models.find((model) => model.name === name);
  return { id: matched?.id ?? null, name };
}

/** Hands events from the child's callbacks to the async iterator consuming them. */
class EventQueue<T> {
  #items: T[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #error: Error | null = null;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    this.#wake?.();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length > 0) {
        yield this.#items.shift() as T;
      }
      if (this.#error !== null) throw this.#error;
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

export class AgyCliTransport implements AgyTransport {
  readonly kind = 'cli' as const;

  readonly #executable: string;
  readonly #spawn: AgySpawn;
  readonly #log: (message: string) => void;
  readonly #newTurnId: () => string;
  readonly #settingsPath: string;
  readonly #modelListTimeoutMs: number;
  readonly #modelListRetryCooldownMs: number;
  readonly #modelListTtlMs: number;
  /**
   * The last catalog that actually listed models. A failure never replaces it —
   * losing a working catalog to one bad refresh is the same defect as caching
   * the failure in the first place.
   */
  #good: AgyModelCatalog | null = null;
  /** When {@link #good} was fetched, for {@link AgyCliTransportOptions.modelListTtlMs}. */
  #goodAt = 0;
  /** The in-flight load, shared so N concurrent `session/new` cost one subprocess. */
  #inFlight: Promise<AgyModelCatalog> | null = null;
  /** The last failed attempt, served only until its cooldown expires. */
  #failed: AgyModelCatalog | null = null;
  #failedAt = 0;

  constructor(options: AgyCliTransportOptions = {}) {
    this.#newTurnId = options.newTurnId ?? defaultAgyTurnId;
    this.#settingsPath = options.settingsPath ?? defaultAgySettingsPath();
    this.#modelListTimeoutMs = options.modelListTimeoutMs ?? 20_000;
    this.#modelListRetryCooldownMs = options.modelListRetryCooldownMs ?? 10_000;
    this.#modelListTtlMs = options.modelListTtlMs ?? 600_000;
    this.#executable = options.executable ?? defaultAgyExecutable();
    this.#spawn = options.spawn ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, [...args], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: [...spawnOptions.stdio],
        // Never `shell: true`. On Windows it concatenates argv into a single
        // unescaped string: a prompt with a space is shredded and
        // `--output-format` goes with it, after which agy answers a *different,
        // empty* prompt in plain text and nothing here parses. agy ships a real
        // executable, so it is spawned directly.
        shell: false,
      }) as unknown as AgyChildProcess);
    this.#log = options.logger ?? (() => {});
  }

  /**
   * `agy models` — once per transport **while it works**, retried when it does not.
   *
   * Never rejects. A failure here must not take `session/new` down with it: the
   * session is still usable, it just has no picker, and the empty catalog plus
   * its diagnostic is what says so out loud. Throwing instead would trade a
   * missing feature for a dead session.
   *
   * **A failure is not a result, and used to be cached like one.** This method
   * was `this.#catalog ??= this.#loadCatalog()`, and `#loadCatalog` never
   * rejects — so one `agy models` that failed at startup (agy mid-update, a
   * network blip, a laptop that had not woken its VPN yet) stored an empty
   * catalog for the life of the process. Every later
   * `session/set_config_option` then answered `-32602` "no model can be pinned
   * in this process", *including in sessions opened long after agy recovered*,
   * and every turn ran on agy's persisted default — which another agy client can
   * change between turns. It failed loudly, so no result was ever mislabelled;
   * but for the one user whose whole reason for pinning a model is a CV
   * experiment that has to be reproducible, one startup hiccup silently
   * downgraded every experiment until the adapter was restarted.
   *
   * So: only a catalog that listed models is kept. A failure is held for
   * {@link AgyCliTransportOptions.modelListRetryCooldownMs} — long enough that a
   * broken agy is not re-spawned per request, short enough that a recovered one
   * is picked up without a restart — and the next call after that tries again.
   */
  async listModels(): Promise<AgyModelCatalog> {
    const now = Date.now();
    const cooling = this.#failed !== null && now - this.#failedAt < this.#modelListRetryCooldownMs;
    if (this.#good !== null) {
      // Stale-while-revalidate: the answer is already known, so the refresh must
      // not be in front of it. A refresh is skipped while a failure is cooling
      // down, or an unreachable agy would be re-spawned on every call.
      if (this.#modelListTtlMs > 0 && now - this.#goodAt >= this.#modelListTtlMs && !cooling) {
        void this.#load();
      }
      return this.#good;
    }
    if (cooling && this.#failed !== null) return this.#failed;
    return this.#load();
  }

  /**
   * One attempt, shared by everyone who asks while it is in flight.
   *
   * The bookkeeping — not the spawning — is what this method is for: which
   * outcome is worth keeping, and for how long. A failure records itself in
   * `#failed` and **leaves `#good` alone**, which is what makes a refresh that
   * fails a non-event: `listModels` keeps serving the catalog that worked.
   * The returned value is the attempt's own result, not the served one.
   */
  #load(): Promise<AgyModelCatalog> {
    if (this.#inFlight !== null) return this.#inFlight;
    const pending = this.#loadCatalog().then(
      (catalog) => {
        this.#inFlight = null;
        if (catalog.models.length > 0) {
          this.#good = catalog;
          this.#goodAt = Date.now();
          this.#failed = null;
        } else {
          this.#failed = catalog;
          this.#failedAt = Date.now();
        }
        return catalog;
      },
      (error: unknown) => {
        // `#loadCatalog` is written not to reject, but it calls the caller's
        // logger, which can. A rejected promise left in `#inFlight` would be
        // handed to every future caller forever.
        this.#inFlight = null;
        const failure: AgyModelCatalog = {
          models: [],
          persistedDefault: null,
          diagnostics: [`\`${this.#executable} models\` could not be read: ${String(error)}`],
        };
        this.#failed = failure;
        this.#failedAt = Date.now();
        return failure;
      },
    );
    this.#inFlight = pending;
    return pending;
  }

  async #loadCatalog(): Promise<AgyModelCatalog> {
    const diagnostics: string[] = [];
    const models = await this.#runModelList(diagnostics);
    let persistedDefault: AgyModelCatalog['persistedDefault'] = null;
    try {
      persistedDefault = resolveAgyPersistedDefault(
        readFileSync(this.#settingsPath, 'utf8'),
        models,
      );
      if (persistedDefault === null) {
        diagnostics.push(
          `${this.#settingsPath} names no "model", so the model a turn runs on ` +
            `when none is pinned cannot be reported`,
        );
      }
    } catch (error) {
      diagnostics.push(
        `could not read agy's settings at ${this.#settingsPath} (${String(error)}); ` +
          `the model an unpinned turn runs on is unknown`,
      );
    }
    for (const diagnostic of diagnostics) this.#log(`[models] ${diagnostic}`);
    return { models, persistedDefault, diagnostics };
  }

  /** Spawn `agy models` and parse its stdout. Collects reasons, never throws. */
  #runModelList(diagnostics: string[]): Promise<AgyModel[]> {
    return new Promise<AgyModel[]>((resolve) => {
      let child: AgyChildProcess;
      try {
        child = this.#spawn(this.#executable, ['models'], {
          cwd: process.cwd(),
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        diagnostics.push(`could not run \`${this.#executable} models\`: ${String(error)}`);
        resolve([]);
        return;
      }

      let stdout = '';
      let settled = false;
      const settle = (models: AgyModel[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(models);
      };

      const timer = setTimeout(() => {
        diagnostics.push(
          `\`${this.#executable} models\` did not answer within ` +
            `${String(this.#modelListTimeoutMs)}ms; no models are offered`,
        );
        try {
          child.kill();
        } catch {
          // Already gone; the diagnostic above is the report that matters.
        }
        settle([]);
      }, this.#modelListTimeoutMs);
      // A pending timer must not hold the process open — this runs inside a
      // long-lived stdio agent, and `unref` is absent on some timer shims.
      (timer as { unref?: () => void }).unref?.();

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.#log(`agy models stderr: ${chunk.trimEnd()}`);
      });

      child.once('error', (error: Error) => {
        diagnostics.push(`\`${this.#executable} models\` failed to start: ${error.message}`);
        settle([]);
      });
      child.once('close', (code: number | null) => {
        const models = parseAgyModelList(stdout);
        if (code !== 0) {
          diagnostics.push(
            `\`${this.#executable} models\` exited with code ${String(code)}; ` +
              `${String(models.length)} model(s) were parsed from what it printed`,
          );
        } else if (models.length === 0) {
          diagnostics.push(
            `\`${this.#executable} models\` exited cleanly but printed no ` +
              `"<id>\\t<name>" lines; no models are offered`,
          );
        }
        settle(models);
      });
    });
  }

  runTurn(request: AgyTurnRequest): AsyncIterable<AgyTurnEvent> {
    const queue = new EventQueue<AgyTurnEvent>();
    const argv = buildAgyArgv(request);

    let state: AgyTurnState = initialAgyTurnState(request.conversationId, this.#newTurnId());
    let announcedConversation = request.conversationId !== null;
    let stopReason: AcpStopReason | undefined;
    let cancelled = false;
    let settled = false;

    const finish = (reason: AcpStopReason): void => {
      if (settled) return;
      settled = true;
      queue.push({ type: 'end', stopReason: reason });
      queue.close();
    };

    let child: AgyChildProcess;
    try {
      child = this.#spawn(this.#executable, argv, {
        // Set because it is correct to set — agy echoes it back as `init.cwd`,
        // and any non-agy resolution the child does starts here. It is NOT what
        // puts agy in the workspace: measured on agy 1.1.11, a turn spawned in
        // the workspace with no `--add-dir` ran `list_dir` in agy's own scratch
        // directory and reported it empty. `buildAgyArgv` carries the workspace.
        // Neither lever confines agy to it — see `buildAgyArgv`'s comment.
        cwd: request.cwd,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      queue.fail(error instanceof Error ? error : new Error(String(error)));
      return queue.drain();
    }

    const onAbort = (): void => {
      cancelled = true;
      try {
        child.kill();
      } catch (error) {
        this.#log(`failed to kill agy: ${String(error)}`);
      }
    };
    if (request.signal !== undefined) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }

    const splitter = new NdjsonLineSplitter();

    const consume = (line: string): void => {
      if (line.trim() === '') return;
      const event = parseAgyLine(line);
      if (event === undefined) {
        queue.push({
          type: 'diagnostic',
          diagnostic: { reason: 'unparseable_line', detail: line.slice(0, 120) },
        });
        return;
      }
      const mapped = mapAgyEvent(event, state);
      state = mapped.state;
      if (!announcedConversation && state.conversationId !== null) {
        announcedConversation = true;
        queue.push({ type: 'conversation', conversationId: state.conversationId });
      }
      for (const update of mapped.updates) queue.push({ type: 'update', update });
      for (const diagnostic of mapped.diagnostics) queue.push({ type: 'diagnostic', diagnostic });
      if (mapped.stopReason !== undefined) stopReason = mapped.stopReason;
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) consume(line);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#log(`agy stderr: ${chunk.trimEnd()}`);
    });

    child.once('error', (error: Error) => {
      request.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      queue.fail(error);
    });

    child.once('close', (code: number | null) => {
      request.signal?.removeEventListener('abort', onAbort);
      for (const line of splitter.flush()) consume(line);

      if (cancelled) {
        finish('cancelled');
        return;
      }
      if (stopReason !== undefined) {
        finish(stopReason);
        return;
      }
      // No `result` event. A clean exit still ended the turn; a dirty one is a
      // failure the client must see rather than a turn that quietly said nothing.
      if (code === 0) {
        finish('end_turn');
        return;
      }
      if (settled) return;
      settled = true;
      queue.fail(new Error(`agy exited with code ${String(code)}`));
    });

    return queue.drain();
  }

  async dispose(): Promise<void> {
    // Nothing is held between turns: each turn owns its process.
  }
}
