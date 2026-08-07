/**
 * The missing production entry point, as a probe.
 *
 * Round 11's B1 blocker was that `serveAgyOverStdio` has no caller outside its
 * own test: the package declares no `bin`, and `build` is `tsc --noEmit`. This
 * file is the smallest thing that makes it runnable, so the same probe that
 * drives claude-agent-acp and codex-acp can drive our adapter too — which is
 * the only way to find out whether "one client, three agents" is true.
 *
 * It is deliberately in a gitignored directory. Shipping this means an esbuild
 * entry in apps/desktop, not a tsx script.
 */
import { serveAgyOverStdio } from '../packages/adapter-agy/src/serve';

serveAgyOverStdio();
// stdio agents must not exit while the client still holds the pipe.
process.stdin.resume();
