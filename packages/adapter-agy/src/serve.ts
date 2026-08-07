/**
 * Stdio entry point: run this module as a process and it is an ACP agent.
 *
 * stdout is the protocol. Anything human-readable must go to stderr or it
 * corrupts the JSON-RPC stream. That split is the whole contract of this file,
 * so the three streams are a parameter ({@link ServeAgyIo}) rather than a direct
 * reach for `process` — otherwise nothing can assert which stream got what, and
 * inverting the two would be an invisible, agent-killing edit.
 */
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import { AgyAgent } from './agent.js';
import { AgyCliTransport } from './cliTransport.js';
import type { AgyTransport } from './transport.js';

/**
 * The three streams a stdio agent owns. Structurally satisfied by `process`,
 * and by a trio of `PassThrough`s in tests.
 */
export interface ServeAgyIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface ServeAgyOptions {
  readonly transport?: AgyTransport;
  readonly logger?: (message: string) => void;
  /** Defaults to the real process streams. Substituted in tests. */
  readonly io?: ServeAgyIo;
}

/**
 * `ndJsonStream` is typed against whichever `ReadableStream`/`WritableStream` the
 * *consumer's* `lib` resolves to: `node:stream/web`'s under `lib: ["ES2022"]`, the
 * DOM's the moment `lib` includes `"DOM"` — which apps/desktop does. `Readable.toWeb`
 * and `Writable.toWeb` always hand back the node declarations, and the two are
 * structurally incompatible (`ReadableStreamBYOBReader.read` narrows its view type
 * differently), so calling it directly compiles in this package and fails in the
 * consumer that actually builds these sources.
 *
 * Borrowing the parameter types from `ndJsonStream` itself keeps the conversion
 * relative to whatever lib is in play instead of naming either declaration.
 * `tsconfig.dom.json` compiles this file with DOM loaded so the mismatch can
 * never come back unnoticed; `pnpm typecheck` runs it.
 */
type NdJsonOutput = Parameters<typeof ndJsonStream>[0];
type NdJsonInput = Parameters<typeof ndJsonStream>[1];

/** Wrap a node stdio pair as the web streams `ndJsonStream` wants. */
function ndJsonOverNodeStdio(io: ServeAgyIo) {
  return ndJsonStream(
    Writable.toWeb(io.stdout) as unknown as NdJsonOutput,
    Readable.toWeb(io.stdin) as unknown as NdJsonInput,
  );
}

export function serveAgyOverStdio(options: ServeAgyOptions = {}): AgentSideConnection {
  const io = options.io ?? process;
  const log =
    options.logger ?? ((message: string) => io.stderr.write(`[agy-acp] ${message}\n`));
  const transport = options.transport ?? new AgyCliTransport({ logger: log });
  return new AgentSideConnection(
    (connection) => new AgyAgent(connection, { transport, logger: log }),
    ndJsonOverNodeStdio(io),
  );
}
