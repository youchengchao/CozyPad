/**
 * Spawning an ACP agent as a child process, and connecting to it.
 *
 * Every agent CozyPad drives speaks the same protocol; only the launch line
 * differs. That was measured rather than assumed — `scripts/probe-acp-agent.mts`
 * drives claude-agent-acp, codex-acp and our own adapter through one client and
 * one code path, and all three answer.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  connectAcpAgentProcess,
  type AcpAgentHandle,
  type AcpClientHandlers,
  type AcpRequestTimeouts,
} from '@cozypad/acp-client';

export interface AcpLaunchSpec {
  /** How the process is named in diagnostics, e.g. `'adapter-agy'`. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Where `dist/agy-acp.cjs` actually lives at runtime.
 *
 * Inside a packaged app the main bundle runs from `app.asar`, and a file inside
 * an asar archive has no real path for the OS to execute. `asarUnpack` in
 * package.json puts a real copy next to it in `app.asar.unpacked`, and this is
 * the rewrite that points at it. In development `__dirname` contains neither
 * string and the replace is a no-op.
 */
export function agyAcpEntryPath(): string {
  return path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'agy-acp.cjs');
}

/**
 * The launch spec for our own agy adapter.
 *
 * `ELECTRON_RUN_AS_NODE` is load-bearing: in a packaged app `process.execPath`
 * is CozyPad.exe, and spawning it without that variable starts a second copy of
 * the application instead of running the script.
 */
export function agyLaunchSpec(cwd: string): AcpLaunchSpec {
  return {
    label: 'adapter-agy',
    command: process.execPath,
    args: [agyAcpEntryPath()],
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
  };
}

/**
 * Where a published ACP agent's real entry point lives.
 *
 * Resolved to `dist/index.js` and run with node rather than through the npm
 * `.CMD` shim, which needs a shell — and `shell: true` on Windows concatenates
 * argv into one unescaped string. Same reason the adapter is bundled rather
 * than launched by name.
 */
function publishedAgentEntry(packageName: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(`${packageName}/package.json`) as {
    bin: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]!;
  return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), bin);
}

/**
 * The launch spec for each agent CozyPad drives.
 *
 * Every one of them speaks the same protocol; only this line differs. That was
 * measured rather than assumed — `scripts/probe-acp-agent.mts` drives all three
 * through one client and one code path, and all three answer.
 *
 * claude-agent-acp and codex-acp are published packages that wrap the real
 * CLIs: the first spawns Claude Code itself, the second bundles `@openai/codex`.
 * So the agent's own context management, compaction and tool loop are unchanged
 * — ACP replaces how CozyPad *listens*, not how the agent *thinks*.
 */
export function launchSpecFor(agentKind: string, cwd: string): AcpLaunchSpec {
  switch (agentKind) {
    case 'claude':
      return {
        label: 'claude-agent-acp',
        command: process.execPath,
        args: [publishedAgentEntry('@zed-industries/claude-agent-acp')],
        cwd,
        env: { ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
      };
    case 'codex':
      return {
        label: 'codex-acp',
        command: process.execPath,
        args: [publishedAgentEntry('@agentclientprotocol/codex-acp')],
        cwd,
        env: { ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
      };
    default:
      return agyLaunchSpec(cwd);
  }
}

export interface AcpChild {
  readonly handle: AcpAgentHandle;
  /** Ends the agent. Safe to call more than once. */
  kill(): void;
}

/**
 * Starts an ACP agent and connects to it.
 *
 * `shell: false` is not a preference. On Windows the shell concatenates argv
 * into one unescaped string, which shreds any argument containing a space —
 * measured once as agy silently answering a *different, empty* prompt in plain
 * text, with no error anywhere. For the same reason a published agent must be
 * launched as `node <dist/index.js>` and never through its `.CMD` shim, which
 * would require a shell to run at all.
 */
export function spawnAcpAgent(
  spec: AcpLaunchSpec,
  handlers: AcpClientHandlers,
  timeouts?: AcpRequestTimeouts,
): AcpChild {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...spec.env },
  });

  const handle = connectAcpAgentProcess({
    child: child as never,
    label: spec.label,
    handlers,
    ...(timeouts === undefined ? {} : { timeouts }),
  });

  let killed = false;
  return {
    handle,
    kill: () => {
      if (killed) return;
      killed = true;
      child.kill();
    },
  };
}
