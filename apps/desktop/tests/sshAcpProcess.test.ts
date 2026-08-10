import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  AcpAgentHandle,
  AcpClientHandlers,
  ConnectAcpAgentProcessOptions,
  NodeChildProcessLike,
} from '@cozypad/acp-client';
import type { AcpLaunchSpec } from '../src/main/acp/acpProcess';
import {
  remoteAcpLaunchSpec,
  spawnSshAcpAgent,
} from '../src/main/acp/sshAcpProcess';
import type { NodeHostProcessSpec } from '../src/main/transport/nodeHostRuntime';
import type { RemoteHostProcess } from '../src/main/transport/remoteNodeHost';

function processFixture(): {
  process: RemoteHostProcess;
  kill: ReturnType<typeof vi.fn>;
  emitExit(code: number | null, signal: string | null): void;
} {
  const kill = vi.fn();
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    ended: false,
    signalCode: null as string | null,
    kill,
  }) as RemoteHostProcess;
  return {
    process,
    kill,
    emitExit: (code, signal) => {
      Object.assign(process, { ended: true, exitCode: code, signalCode: signal });
      (process as unknown as EventEmitter).emit('exit', code, signal);
    },
  };
}

function launchSpec(label: AcpLaunchSpec['label'], cwd = '/srv/project'): AcpLaunchSpec {
  return {
    label,
    command: 'unused-locally',
    args: [],
    cwd,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
      LANG: 'zh_TW.UTF-8',
    },
  };
}

function connectorFixture(): {
  connect: (options: ConnectAcpAgentProcessOptions) => AcpAgentHandle;
  child: () => NodeChildProcessLike;
  handle: AcpAgentHandle;
} {
  const handle = {} as AcpAgentHandle;
  let captured: NodeChildProcessLike | undefined;
  return {
    handle,
    connect: (options) => {
      captured = options.child;
      return handle;
    },
    child: () => {
      if (captured === undefined) throw new Error('ACP process was not connected');
      return captured;
    },
  };
}

function handlers(): AcpClientHandlers {
  return {
    onSessionUpdate: () => undefined,
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };
}

describe('SSH ACP process transport', () => {
  it('builds a pinned process spec without a shell', () => {
    const spec = remoteAcpLaunchSpec(
      launchSpec('codex-acp', '/srv/research; touch /tmp/not-run'),
    );

    expect(spec).toMatchObject({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp@1.1.14'],
      cwd: '/srv/research; touch /tmp/not-run',
    });
    expect(spec.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('connects ACP to the process streams supplied by the remote host', async () => {
    const fixture = processFixture();
    const connector = connectorFixture();
    const spawnProcess = vi.fn(async (spec: NodeHostProcessSpec) => {
      void spec;
      return fixture.process;
    });
    const transport = {
      exec: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
      spawnProcess,
    };

    const child = await spawnSshAcpAgent(
      transport,
      launchSpec('claude-agent-acp'),
      handlers(),
      connector.connect,
    );

    expect(child.handle).toBe(connector.handle);
    expect(connector.child()).toBe(fixture.process);
    expect(spawnProcess.mock.calls[0]?.[0]).toMatchObject({
      command: 'npx',
      args: ['-y', '@zed-industries/claude-agent-acp@0.23.1'],
      cwd: '/srv/project',
    });

    const exits: unknown[] = [];
    child.onExit((detail) => exits.push(detail));
    fixture.emitExit(17, 'SIGTERM');
    expect(exits).toEqual([{ code: 17, signal: 'SIGTERM' }]);

    child.kill();
    child.kill();
    expect(fixture.kill).toHaveBeenCalledOnce();
  });

  it('copies the bundled AGY adapter before spawning it through Node', async () => {
    const fixture = processFixture();
    const connector = connectorFixture();
    const writeFile = vi.fn(
      async (remotePath: string, data: Uint8Array) => {
        void remotePath;
        void data;
      },
    );
    const exec = vi.fn(async (command: string) =>
      command.startsWith('printf') ? '/home/researcher' : '',
    );
    const spawnProcess = vi.fn(async (spec: NodeHostProcessSpec) => {
      void spec;
      return fixture.process;
    });
    const transport = { exec, writeFile, spawnProcess };
    const spec = {
      ...launchSpec('adapter-agy'),
      args: [fileURLToPath(new URL('../dist/agy-acp.cjs', import.meta.url))],
    };

    await spawnSshAcpAgent(transport, spec, handlers(), connector.connect);

    expect(exec.mock.calls[1]?.[0]).toContain(
      "mkdir -p -- '/home/researcher/.cozypad'",
    );
    expect(writeFile.mock.calls[0]?.[0]).toBe(
      '/home/researcher/.cozypad/agy-acp.cjs',
    );
    expect(
      (writeFile.mock.calls[0]?.[1] as Uint8Array).byteLength,
    ).toBeGreaterThan(0);
    expect(spawnProcess.mock.calls[0]?.[0]).toMatchObject({
      command: 'node',
      args: ['/home/researcher/.cozypad/agy-acp.cjs'],
      cwd: '/srv/project',
    });
  });
});
