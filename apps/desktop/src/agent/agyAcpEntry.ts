/**
 * The agy ACP adapter, as a runnable file.
 *
 * `serveAgyOverStdio` had exactly one caller outside its own test, which is why
 * "wire it into the app" was never a wiring job — there was nothing to spawn.
 * esbuild bundles this to `dist/agy-acp.cjs`, and the main process starts it as
 * a child and speaks ACP over its stdio.
 *
 * Bundled rather than resolved from PATH because it is ours and it is small.
 * claude-agent-acp and codex-acp are published npm packages with their own bins
 * and are found differently; see `acpProcess.ts`.
 */
import { serveAgyOverStdio } from '@cozypad/adapter-agy';

// `io` defaults to `process`, and the adapter already writes its log lines to
// stderr — stdout is the protocol and nothing else may touch it.
serveAgyOverStdio();

// A stdio agent must not exit while the client still holds the pipe. Without
// this the process ends as soon as the module finishes evaluating, and the
// client sees a connection that closed before `initialize` was answered.
process.stdin.resume();
