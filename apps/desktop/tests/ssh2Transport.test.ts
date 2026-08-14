import { describe, expect, it } from 'vitest';
import type { ConnectionStateChanged } from '@cozypad/contracts';
import { sshFixtures } from '@cozypad/test-fixtures';
import type {
  Ssh2ClientLike,
  Ssh2ExecStreamLike,
  Ssh2SftpLike,
  Ssh2ShellStreamLike,
} from '../src/main/transport/ssh2Transport';
import {
  SSH_ALGORITHMS,
  Ssh2Transport,
} from '../src/main/transport/ssh2Transport';
import type { TransportEvents } from '../src/main/transport/TransportPort';
import type { RemoteHostRuntime } from '../src/main/transport/remoteNodeHost';

class FakeShellStream implements Ssh2ShellStreamLike {
  readonly writes: Uint8Array[] = [];
  readonly windows: [number, number, number, number][] = [];
  closed = false;
  private readonly dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];

  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Uint8Array) => void): void => {
      this.stderrListeners.push(listener);
    },
  };

  on(event: 'data' | 'close', listener: ((chunk: Uint8Array) => void) | (() => void)): this {
    if (event === 'data') this.dataListeners.push(listener as (chunk: Uint8Array) => void);
    else this.closeListeners.push(listener as () => void);
    return this;
  }

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push([rows, cols, height, width]);
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  emitData(chunk: Uint8Array): void {
    this.dataListeners.forEach((listener) => listener(chunk));
  }

  emitStderr(chunk: Uint8Array): void {
    this.stderrListeners.forEach((listener) => listener(chunk));
  }

  emitClose(): void {
    this.closeListeners.forEach((listener) => listener());
  }
}

class FakeHostRuntime {
  readonly execCalls: string[] = [];
  readonly writes: Array<{ path: string; data: Uint8Array }> = [];
  execResult = '';
  execError: Error | null = null;
  disposed = false;

  async exec(command: string): Promise<string> {
    this.execCalls.push(command);
    if (this.execError !== null) throw this.execError;
    return this.execResult;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writes.push({ path, data });
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeClient implements Ssh2ClientLike {
  connectConfig: Record<string, unknown> | null = null;
  connectError: Error | null = null;
  ended = false;
  readonly shellRequests: {
    options: { term: string; cols: number; rows: number };
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void;
  }[] = [];
  readonly execRequests: {
    command: string;
    options?: {
      pty: { term: string; cols: number; rows: number; width: number; height: number };
    };
    callback: (
      error: Error | undefined,
      stream: Ssh2ExecStreamLike | Ssh2ShellStreamLike,
    ) => void;
  }[] = [];
  readonly sftpRequests: Array<
    (error: Error | undefined, sftp: Ssh2SftpLike) => void
  > = [];
  private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: 'ready' | 'error' | 'close', listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  connect(config: Record<string, unknown>): void {
    this.connectConfig = config;
    if (this.connectError) throw this.connectError;
  }

  shell(
    options: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void,
  ): void {
    this.shellRequests.push({ options, callback });
  }

  exec(
    command: string,
    callback: (error: Error | undefined, stream: Ssh2ExecStreamLike) => void,
  ): void;
  exec(
    command: string,
    options: {
      pty: { term: string; cols: number; rows: number; width: number; height: number };
    },
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void,
  ): void;
  exec(
    command: string,
    optionsOrCallback:
      | {
          pty: {
            term: string;
            cols: number;
            rows: number;
            width: number;
            height: number;
          };
        }
      | ((error: Error | undefined, stream: Ssh2ExecStreamLike) => void),
    terminalCallback?: (
      error: Error | undefined,
      stream: Ssh2ShellStreamLike,
    ) => void,
  ): void {
    if (typeof optionsOrCallback === 'function') {
      this.execRequests.push({
        command,
        callback: optionsOrCallback as (
          error: Error | undefined,
          stream: Ssh2ExecStreamLike | Ssh2ShellStreamLike,
        ) => void,
      });
      return;
    }
    this.execRequests.push({
      command,
      options: optionsOrCallback,
      callback: terminalCallback! as (
        error: Error | undefined,
        stream: Ssh2ExecStreamLike | Ssh2ShellStreamLike,
      ) => void,
    });
  }

  sftp(
    callback: (error: Error | undefined, sftp: Ssh2SftpLike) => void,
  ): void {
    this.sftpRequests.push(callback);
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }

  emit(event: 'ready' | 'error' | 'close', ...args: unknown[]): void {
    (this.handlers.get(event) ?? []).forEach((listener) =>
      (listener as (...a: unknown[]) => void)(...args),
    );
  }
}

interface Recorder extends TransportEvents {
  states: ConnectionStateChanged[];
  outputs: { terminalId: string; data: Uint8Array }[];
  closes: { terminalId: string; exitCode: number | null; reason?: string }[];
}

function createRecorder(): Recorder {
  const recorder: Recorder = {
    states: [],
    outputs: [],
    closes: [],
    onConnectionState: (event) => recorder.states.push(event),
    onTerminalOutput: (terminalId, data) => recorder.outputs.push({ terminalId, data }),
    onTerminalClosed: (terminalId, exitCode, reason) =>
      recorder.closes.push(
        reason === undefined ? { terminalId, exitCode } : { terminalId, exitCode, reason },
      ),
  };
  return recorder;
}

const PROFILE = {
  id: 'p1',
  name: 'Lab GPU box',
  host: '192.168.1.10',
  port: 2222,
  username: 'ycchao',
  authMethod: 'password' as const,
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function connectedTransport(): Promise<{
  transport: Ssh2Transport;
  client: FakeClient;
  host: FakeHostRuntime;
  recorder: Recorder;
}> {
  const client = new FakeClient();
  const host = new FakeHostRuntime();
  const recorder = createRecorder();
  const transport = new Ssh2Transport({
    getProfile: () => PROFILE,
    getCredential: () => ({ authMethod: 'password', password: 'hunter2' }),
    clientFactory: () => client,
    hostRuntimeFactory: async () => host as unknown as RemoteHostRuntime,
  });
  transport.setEvents(recorder);
  const connectPromise = transport.connect('p1');
  await flushMicrotasks();
  client.emit('ready');
  await connectPromise;
  return { transport, client, host, recorder };
}

describe('Ssh2Transport', () => {
  it('rejects unknown profiles', async () => {
    const transport = new Ssh2Transport({ getProfile: () => undefined });
    await expect(transport.connect('nope')).rejects.toThrow('unknown profile');
  });

  it('passes profile and password into ssh2 connect config', async () => {
    const { client } = await connectedTransport();
    expect(client.connectConfig).toMatchObject({
      host: '192.168.1.10',
      port: 2222,
      username: 'ycchao',
      password: 'hunter2',
      readyTimeout: 12000,
      keepaliveInterval: 10000,
      algorithms: SSH_ALGORITHMS,
    });
  });

  it('does not offer legacy SSH algorithms', () => {
    const offered = Object.values(SSH_ALGORITHMS).flat().join(',');
    expect(offered).not.toMatch(/sha1|ssh-rsa|ssh-dss|cbc|3des|arcfour|md5/iu);
  });

  it('only offers ciphers supported by the Electron crypto runtime', () => {
    expect(SSH_ALGORITHMS.cipher).toEqual([
      'aes128-gcm@openssh.com',
      'aes256-gcm@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'aes256-ctr',
    ]);
    expect(SSH_ALGORITHMS.cipher).not.toContain('chacha20-poly1305@openssh.com');
  });

  it('walks connecting → connected on success', async () => {
    const { recorder } = await connectedTransport();
    expect(recorder.states.map((event) => event.state)).toEqual([
      'connecting',
      'connected',
    ]);
  });

  it('emits error state and rejects when the connection fails', async () => {
    const client = new FakeClient();
    const recorder = createRecorder();
    const transport = new Ssh2Transport({
      getProfile: () => PROFILE,
      getCredential: () => ({ authMethod: 'password', password: 'hunter2' }),
      clientFactory: () => client,
    });
    transport.setEvents(recorder);
    const connectPromise = transport.connect('p1');
    const expectation = expect(connectPromise).rejects.toThrow('auth failed');
    await flushMicrotasks();
    client.emit('error', new Error('auth failed'));
    client.emit('close');
    await expectation;
    const states = recorder.states.map((event) => event.state);
    expect(states).toEqual(['connecting', 'error']);
    expect(recorder.states[1]?.error).toBe('auth failed');
  });

  it('clears a client that throws synchronously so a retry can connect', async () => {
    const failedClient = new FakeClient();
    failedClient.connectError = new Error('Cannot parse privateKey: unsupported key format');
    const retryClient = new FakeClient();
    const clients = [failedClient, retryClient];
    const recorder = createRecorder();
    const transport = new Ssh2Transport({
      getProfile: () => PROFILE,
      getCredential: () => ({ authMethod: 'password', password: 'hunter2' }),
      clientFactory: () => clients.shift()!,
      hostRuntimeFactory: async () => new FakeHostRuntime() as unknown as RemoteHostRuntime,
    });
    transport.setEvents(recorder);

    await expect(transport.connect('p1')).rejects.toThrow(
      'Cannot parse privateKey: unsupported key format',
    );
    expect(failedClient.ended).toBe(true);

    const retryPromise = transport.connect('p1');
    await flushMicrotasks();
    retryClient.emit('ready');
    await expect(retryPromise).resolves.toBeUndefined();
    expect(recorder.states.map((event) => event.state)).toEqual([
      'connecting',
      'error',
      'connecting',
      'connected',
    ]);
  });

  it('releases an established client after an error so reconnect can proceed', async () => {
    const firstClient = new FakeClient();
    const retryClient = new FakeClient();
    const clients = [firstClient, retryClient];
    const recorder = createRecorder();
    const transport = new Ssh2Transport({
      getProfile: () => PROFILE,
      getCredential: () => ({ authMethod: 'password', password: 'hunter2' }),
      clientFactory: () => clients.shift()!,
      hostRuntimeFactory: async () => new FakeHostRuntime() as unknown as RemoteHostRuntime,
    });
    transport.setEvents(recorder);

    const firstPromise = transport.connect('p1');
    await flushMicrotasks();
    firstClient.emit('ready');
    await firstPromise;
    firstClient.emit('error', new Error('socket reset'));

    expect(firstClient.ended).toBe(true);
    const retryPromise = transport.connect('p1');
    await flushMicrotasks();
    retryClient.emit('ready');
    await expect(retryPromise).resolves.toBeUndefined();
    expect(recorder.states.map((event) => event.state)).toEqual([
      'connecting',
      'connected',
      'error',
      'connecting',
      'connected',
    ]);
  });

  it('re-emits connected for the same active profile after a renderer reload', async () => {
    const { transport, client, recorder } = await connectedTransport();

    await expect(transport.connect('p1')).resolves.toBeUndefined();
    expect(client.ended).toBe(false);
    expect(recorder.states.map((event) => event.state)).toEqual([
      'connecting',
      'connected',
      'connected',
    ]);
  });

  it('opens a login shell in the requested working directory and PTY size', async () => {
    const { transport, client } = await connectedTransport();
    const openPromise = transport.openTerminal({
      profileId: 'p1',
      cwd: "/srv/team's project",
      cols: 120,
      rows: 30,
    });
    const request = client.execRequests[0]!;
    expect(request.command).toBe(
      `cd -- '/srv/team'"'"'s project' || exit 1\nexec "\${SHELL:-/bin/sh}" -l`,
    );
    expect(request.options).toEqual({
      pty: {
        term: 'xterm-256color',
        cols: 120,
        rows: 30,
        width: 0,
        height: 0,
      },
    });
    request.callback(undefined, new FakeShellStream());
    await expect(openPromise).resolves.toMatch(/^ssh-term-/);
  });

  it('expands the default workspace home before opening a terminal', async () => {
    const { transport, client } = await connectedTransport();
    const openPromise = transport.openTerminal({
      profileId: 'p1',
      cwd: '~',
      cols: 80,
      rows: 24,
    });
    const request = client.execRequests.at(-1)!;
    expect(request.command).toBe(
      'cd -- "$HOME" || exit 1\nexec "${SHELL:-/bin/sh}" -l',
    );
    request.callback(undefined, new FakeShellStream());
    await openPromise;
  });

  it('starts a terminal command directly on an explicitly allocated PTY', async () => {
    const { transport, client } = await connectedTransport();
    const openPromise = transport.openTerminal(
      { profileId: 'p1', cwd: '/srv/project', cols: 132, rows: 44 },
      "tmux -L 'cozypad' attach-session -t '$0'",
    );
    expect(client.shellRequests).toHaveLength(0);
    const request = client.execRequests[0]!;
    expect(request.command).toBe(
      "cd -- '/srv/project' || exit 1\ntmux -L 'cozypad' attach-session -t '$0'",
    );
    expect(request.options).toEqual({
      pty: {
        term: 'xterm-256color',
        cols: 132,
        rows: 44,
        width: 0,
        height: 0,
      },
    });
    request.callback(undefined, new FakeShellStream());
    await expect(openPromise).resolves.toMatch(/^ssh-term-/);
  });

  it('forwards PTY output bytes exactly, including split UTF-8 chunks', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;

    stream.emitData(sshFixtures.ansiColorBytes);
    for (const chunk of sshFixtures.utf8SplitChunks) stream.emitData(chunk);

    expect(recorder.outputs).toHaveLength(3);
    expect(recorder.outputs[0]).toEqual({
      terminalId,
      data: sshFixtures.ansiColorBytes,
    });
    expect(recorder.outputs[1]!.data).toEqual(sshFixtures.utf8SplitChunks[0]);
    expect(recorder.outputs[2]!.data).toEqual(sshFixtures.utf8SplitChunks[1]);
  });

  it('forwards stderr output into the same terminal stream', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    stream.emitStderr(sshFixtures.promptBytes);
    expect(recorder.outputs[0]).toEqual({ terminalId, data: sshFixtures.promptBytes });
  });

  it('writes input bytes to the shell stream', async () => {
    const { transport, client } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    const input = new TextEncoder().encode('nvidia-smi\r');
    transport.writeTerminal(terminalId, input);
    expect(stream.writes).toEqual([input]);
  });

  it('maps resize onto setWindow(rows, cols, ...)', async () => {
    const { transport, client } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    transport.resizeTerminal(terminalId, 150, 45);
    expect(stream.windows).toEqual([[45, 150, 0, 0]]);
  });

  it('reports terminal close exactly once', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    stream.emitClose();
    stream.emitClose();
    expect(recorder.closes).toEqual([{ terminalId, exitCode: null }]);
  });

  it('closes terminals and reports disconnected when the connection drops', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 });
    client.execRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;

    await transport.disconnect();

    expect(client.ended).toBe(true);
    expect(recorder.closes).toEqual([
      { terminalId, exitCode: null, reason: 'connection closed' },
    ]);
    expect(recorder.states.map((event) => event.state)).toEqual([
      'connecting',
      'connected',
      'disconnected',
    ]);
  });

  it('refuses to open terminals when not connected', async () => {
    const transport = new Ssh2Transport({ getProfile: () => PROFILE });
    await expect(
      transport.openTerminal({ profileId: 'p1', cwd: '/srv/project', cols: 80, rows: 24 }),
    ).rejects.toThrow('not connected');
  });

  it('delegates commands to the remote Node host runtime', async () => {
    const { transport, client, host } = await connectedTransport();
    host.execResult = 'Linux gpu-box 6.8.0';

    await expect(transport.exec('uname -a')).resolves.toBe(
      'Linux gpu-box 6.8.0',
    );
    expect(host.execCalls).toEqual(['uname -a']);
    expect(client.execRequests).toHaveLength(0);
  });

  it('delegates binary writes to the remote Node host runtime', async () => {
    const { transport, host } = await connectedTransport();
    const data = new Uint8Array([0, 255, 4, 8]);

    await expect(
      transport.writeFile('/srv/project/image.png', data),
    ).resolves.toBeUndefined();
    expect(host.writes).toEqual([
      { path: '/srv/project/image.png', data },
    ]);
  });

  it('passes the host verifier result through to ssh2', async () => {
    const client = new FakeClient();
    const recorder = createRecorder();
    const verified: Uint8Array[] = [];
    const transport = new Ssh2Transport({
      getProfile: () => PROFILE,
      getCredential: () => ({ authMethod: 'password', password: 'hunter2' }),
      verifyHostKey: (profile, key) => {
        expect(profile.host).toBe(PROFILE.host);
        verified.push(key);
        return Promise.resolve(true);
      },
      clientFactory: () => client,
      hostRuntimeFactory: async () => new FakeHostRuntime() as unknown as RemoteHostRuntime,
    });
    transport.setEvents(recorder);
    const connectPromise = transport.connect('p1');
    await flushMicrotasks();

    const hostVerifier = client.connectConfig?.hostVerifier as (
      key: Uint8Array,
      done: (valid: boolean) => void,
    ) => void;
    expect(typeof hostVerifier).toBe('function');
    const results: boolean[] = [];
    hostVerifier(new Uint8Array([1, 2, 3]), (valid) => results.push(valid));
    await flushMicrotasks();
    expect(results).toEqual([true]);
    expect(verified).toHaveLength(1);

    client.emit('ready');
    await connectPromise;
  });

  it('passes a private key and passphrase without a password', async () => {
    const client = new FakeClient();
    const profile = { ...PROFILE, authMethod: 'privateKey' as const };
    const transport = new Ssh2Transport({
      getProfile: () => profile,
      getCredential: () => ({
        authMethod: 'privateKey',
        privateKey: 'test-private-key-material',
        passphrase: 'test-passphrase',
      }),
      clientFactory: () => client,
      hostRuntimeFactory: async () => new FakeHostRuntime() as unknown as RemoteHostRuntime,
    });
    const connectPromise = transport.connect(profile.id);
    await flushMicrotasks();

    expect(client.connectConfig).toMatchObject({
      privateKey: 'test-private-key-material',
      passphrase: 'test-passphrase',
    });
    expect(client.connectConfig).not.toHaveProperty('password');

    client.emit('ready');
    await connectPromise;
  });
});
