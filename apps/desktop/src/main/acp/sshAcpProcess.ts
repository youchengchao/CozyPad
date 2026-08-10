import { readFile } from 'node:fs/promises';
import { quoteShellArg } from '@cozypad/contracts';
import {
  connectAcpAgentProcess,
  type AcpClientHandlers,
} from '@cozypad/acp-client';
import type { AcpChild, AcpLaunchSpec } from './acpProcess';
import type { RemoteHostProcess } from '../transport/remoteNodeHost';
import type { NodeHostProcessSpec } from '../transport/nodeHostRuntime';

interface SshAcpTransport {
  exec(command: string, timeoutMs?: number): Promise<string>;
  writeFile(remotePath: string, data: Uint8Array): Promise<void>;
  spawnProcess(spec: NodeHostProcessSpec): Promise<RemoteHostProcess>;
}

export function remoteAcpLaunchSpec(
  spec: AcpLaunchSpec,
  remoteAgyEntry?: string,
): NodeHostProcessSpec {
  const env = Object.fromEntries(
    Object.entries(spec.env ?? {}).filter(
      ([name]) => name !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const common = { cwd: spec.cwd, env };

  switch (spec.label) {
    case 'claude-agent-acp':
      return {
        ...common,
        command: 'npx',
        args: ['-y', '@zed-industries/claude-agent-acp@0.23.1'],
      };
    case 'codex-acp':
      return {
        ...common,
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@1.1.14'],
      };
    case 'adapter-agy':
      if (remoteAgyEntry === undefined) {
        throw new Error('The remote AGY ACP adapter was not prepared');
      }
      return {
        ...common,
        command: 'node',
        args: [remoteAgyEntry],
      };
    default:
      throw new Error('Unsupported remote ACP agent: ' + spec.label);
  }
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
 * Starts ACP through the shared Node host process API. SSH only carries the
 * process streams and lifecycle events.
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
  const process = await transport.spawnProcess(
    remoteAcpLaunchSpec(spec, remoteAgyEntry),
  );
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
      process.kill();
    },
    onExit: (listener) => {
      if (process.ended || process.exitCode !== null || process.signalCode !== null) {
        queueMicrotask(() =>
          listener({
            code: process.exitCode ?? null,
            signal: process.signalCode ?? null,
          }),
        );
        return;
      }
      process.on('exit', (code, signal) => listener({ code, signal }));
    },
  };
}
