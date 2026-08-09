import { readFile } from 'node:fs/promises';
import { quoteShellArg } from '@cozypad/contracts';
import {
  connectAcpAgentProcess,
  type AcpClientHandlers,
  type NodeChildProcessLike,
  type NodeReadableLike,
  type NodeWritableLike,
} from '@cozypad/acp-client';
import type { AcpChild, AcpLaunchSpec } from './acpProcess';
import type { Ssh2DuplexExecStreamLike } from '../transport/ssh2Transport';

interface SshAcpTransport {
  exec(command: string, timeoutMs?: number): Promise<string>;
  writeFile(remotePath: string, data: Uint8Array): Promise<void>;
  openExecChannel(command: string): Promise<Ssh2DuplexExecStreamLike>;
}

interface RemoteProgram {
  readonly command: string;
  readonly args: readonly string[];
}

type ExitListener = (code: number | null, signal: string | null) => void;
type ErrorListener = (error: Error) => void;

class SshChildProcess implements NodeChildProcessLike {
  readonly stdin: NodeWritableLike;
  readonly stdout: NodeReadableLike;
  readonly stderr: NodeReadableLike | null;
  exitCode: number | null = null;
  signalCode: string | null = null;

  private ended = false;
  private readonly exitListeners: ExitListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  constructor(private readonly channel: Ssh2DuplexExecStreamLike) {
    this.stdin = channel as unknown as NodeWritableLike;
    this.stdout = channel as unknown as NodeReadableLike;
    this.stderr = (channel.stderr ?? null) as NodeReadableLike | null;
    channel.on('close', (code, signal) => {
      if (this.ended) return;
      this.ended = true;
      this.exitCode = code ?? null;
      this.signalCode = signal ?? null;
      for (const listener of this.exitListeners.splice(0)) {
        listener(this.exitCode, this.signalCode);
      }
    });
    channel.on('error', (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
  }

  on(event: 'exit', listener: ExitListener): this;
  on(event: 'error', listener: ErrorListener): this;
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): this {
    if (event === 'exit') {
      const exitListener = listener as ExitListener;
      if (this.ended) {
        queueMicrotask(() => exitListener(this.exitCode, this.signalCode));
      } else {
        this.exitListeners.push(exitListener);
      }
    } else {
      this.errorListeners.push(listener as ErrorListener);
    }
    return this;
  }

  close(): void {
    this.channel.close();
  }
}

function remoteProgramFor(
  spec: AcpLaunchSpec,
  remoteAgyEntry?: string,
): RemoteProgram {
  switch (spec.label) {
    case 'claude-agent-acp':
      return {
        command: 'npx',
        args: ['-y', '@zed-industries/claude-agent-acp@0.23.1'],
      };
    case 'codex-acp':
      return {
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@1.1.14'],
      };
    case 'adapter-agy':
      if (remoteAgyEntry === undefined) {
        throw new Error('The remote AGY ACP adapter was not prepared');
      }
      return { command: 'node', args: [remoteAgyEntry] };
    default:
      throw new Error('Unsupported remote ACP agent: ' + spec.label);
  }
}

export function buildSshAcpCommand(
  spec: AcpLaunchSpec,
  remoteAgyEntry?: string,
): string {
  const program = remoteProgramFor(spec, remoteAgyEntry);
  const environment = Object.entries(spec.env ?? {})
    .filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE')
    .map(([name, value]) => name + '=' + value);
  const invocation = ['env', ...environment, program.command, ...program.args]
    .map(quoteShellArg)
    .join(' ');
  const command = 'cd -- ' + quoteShellArg(spec.cwd) + ' && exec ' + invocation;
  return 'exec "${SHELL:-/bin/sh}" -lc ' + quoteShellArg(command);
}

async function prepareRemoteAgyEntry(
  transport: SshAcpTransport,
  spec: AcpLaunchSpec,
): Promise<string> {
  const localEntry = spec.args[0];
  if (localEntry === undefined) {
    throw new Error('The bundled AGY ACP adapter is missing');
  }
  const home = (await transport.exec('printf \'%s\' "$HOME"')).trim();
  if (!home.startsWith('/') || home === '/') {
    throw new Error('Remote host did not provide a safe user home directory');
  }
  const directory = home.replace(/\/+$/u, '') + '/.cozypad';
  const remoteEntry = directory + '/agy-acp.cjs';
  await transport.exec('mkdir -p -- ' + quoteShellArg(directory));
  await transport.writeFile(remoteEntry, await readFile(localEntry));
  return remoteEntry;
}

/**
 * Runs an ACP server on the connected SSH host and binds its raw channel to the
 * same ACP client used for local child processes.
 */
export async function spawnSshAcpAgent(
  transport: SshAcpTransport,
  spec: AcpLaunchSpec,
  handlers: AcpClientHandlers,
  connect: typeof connectAcpAgentProcess = connectAcpAgentProcess,
): Promise<AcpChild> {
  const remoteAgyEntry =
    spec.label === 'adapter-agy'
      ? await prepareRemoteAgyEntry(transport, spec)
      : undefined;
  const channel = await transport.openExecChannel(
    buildSshAcpCommand(spec, remoteAgyEntry),
  );
  const process = new SshChildProcess(channel);
  const handle = connect({
    child: process,
    label: spec.label,
    handlers,
  });
  let killed = false;
  return {
    handle,
    kill: () => {
      if (killed) return;
      killed = true;
      process.close();
    },
    onExit: (listener) => {
      process.on('exit', (code, signal) => listener({ code, signal }));
    },
  };
}
