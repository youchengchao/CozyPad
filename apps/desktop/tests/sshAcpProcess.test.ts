import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type {
  AcpAgentHandle,
  AcpClientHandlers,
  ConnectAcpAgentProcessOptions,
  NodeChildProcessLike,
} from '@cozypad/acp-client';
import type { AcpLaunchSpec } from '../src/main/acp/acpProcess';
import {
  buildSshAcpCommand,
  spawnSshAcpAgent,
} from '../src/main/acp/sshAcpProcess';
import type { Ssh2DuplexExecStreamLike } from '../src/main/transport/ssh2Transport';

function channelFixture(): {
  channel: Ssh2DuplexExecStreamLike;
  close: ReturnType<typeof vi.fn>;
  emitClose(code?: number | null, signal?: string | null): void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const close = vi.fn();
  const channel = {
    readable: true,
    on(event: string, listener: (...args: unknown[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return this;
    },
    write: vi.fn(),
    close,
  } as unknown as Ssh2DuplexExecStreamLike;
  return {
    channel,
    close,
    emitClose: (code, signal) => {
      for (const listener of listeners.get('close') ?? []) {
        listener(code, signal);
      }
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
  it('uses the pinned official adapter through a login shell', () => {
    const command = buildSshAcpCommand(
      launchSpec('codex-acp', '/srv/research; touch /tmp/not-run'),
    );

    expect(command).toContain('"${SHELL:-/bin/sh}" -lc');
    expect(command).toContain('@agentclientprotocol/codex-acp@1.1.14');
    expect(command).toContain('/srv/research; touch /tmp/not-run');
    expect(command).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('maps one duplex SSH channel to ACP stdin/stdout and exit', async () => {
    const fixture = channelFixture();
    const connector = connectorFixture();
    const openExecChannel = vi.fn(
      async (command: string) => {
        void command;
        return fixture.channel;
      },
    );
    const transport = {
      exec: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
      openExecChannel,
    };

    const child = await spawnSshAcpAgent(
      transport,
      launchSpec('claude-agent-acp'),
      handlers(),
      connector.connect,
    );

    expect(child.handle).toBe(connector.handle);
    expect(connector.child().stdin).toBe(fixture.channel);
    expect(connector.child().stdout).toBe(fixture.channel);
    expect(openExecChannel.mock.calls[0]?.[0]).toContain(
      '@zed-industries/claude-agent-acp@0.23.1',
    );

    const exits: unknown[] = [];
    child.onExit((detail) => exits.push(detail));
    fixture.emitClose(17, 'SIGTERM');
    expect(exits).toEqual([{ code: 17, signal: 'SIGTERM' }]);

    child.kill();
    child.kill();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('copies the existing bundled AGY adapter before opening its channel', async () => {
    const fixture = channelFixture();
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
    const openExecChannel = vi.fn(async (command: string) => {
      void command;
      return fixture.channel;
    });
    const transport = { exec, writeFile, openExecChannel };
    const spec = {
      ...launchSpec('adapter-agy'),
      args: [fileURLToPath(new URL('../dist/agy-acp.cjs', import.meta.url))],
    };

    await spawnSshAcpAgent(transport, spec, handlers(), connector.connect);

    expect(exec.mock.calls[1]?.[0]).toContain("mkdir -p -- '/home/researcher/.cozypad'");
    expect(writeFile.mock.calls[0]?.[0]).toBe(
      '/home/researcher/.cozypad/agy-acp.cjs',
    );
    expect((writeFile.mock.calls[0]?.[1] as Uint8Array).byteLength).toBeGreaterThan(0);
    const command = openExecChannel.mock.calls[0]?.[0];
    expect(command).toContain('node');
    expect(command).toContain('/home/researcher/.cozypad/agy-acp.cjs');
  });
});
