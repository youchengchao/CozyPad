import { describe, expect, it } from 'vitest';
import type { ConnectionStateChanged } from '@cozypad/contracts';
import { sshFixtures } from '@cozypad/test-fixtures';
import type {
  Ssh2ClientLike,
  Ssh2ShellStreamLike,
} from '../src/main/transport/ssh2Transport';
import { Ssh2Transport } from '../src/main/transport/ssh2Transport';
import type { TransportEvents } from '../src/main/transport/TransportPort';

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

class FakeClient implements Ssh2ClientLike {
  connectConfig: Record<string, unknown> | null = null;
  ended = false;
  readonly shellRequests: {
    options: { term: string; cols: number; rows: number };
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void;
  }[] = [];
  private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: 'ready' | 'error' | 'close', listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  connect(config: Record<string, unknown>): void {
    this.connectConfig = config;
  }

  shell(
    options: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void,
  ): void {
    this.shellRequests.push({ options, callback });
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
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function connectedTransport(): Promise<{
  transport: Ssh2Transport;
  client: FakeClient;
  recorder: Recorder;
}> {
  const client = new FakeClient();
  const recorder = createRecorder();
  const transport = new Ssh2Transport({
    getProfile: () => PROFILE,
    getPassword: () => 'hunter2',
    clientFactory: () => client,
  });
  transport.setEvents(recorder);
  const connectPromise = transport.connect('p1');
  await flushMicrotasks();
  client.emit('ready');
  await connectPromise;
  return { transport, client, recorder };
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
    });
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

  it('opens a shell with the requested PTY size', async () => {
    const { transport, client } = await connectedTransport();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 120, rows: 30 });
    const request = client.shellRequests[0]!;
    expect(request.options).toEqual({ term: 'xterm-256color', cols: 120, rows: 30 });
    request.callback(undefined, new FakeShellStream());
    await expect(openPromise).resolves.toMatch(/^ssh-term-/);
  });

  it('forwards PTY output bytes exactly, including split UTF-8 chunks', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
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
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    stream.emitStderr(sshFixtures.promptBytes);
    expect(recorder.outputs[0]).toEqual({ terminalId, data: sshFixtures.promptBytes });
  });

  it('writes input bytes to the shell stream', async () => {
    const { transport, client } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    const input = new TextEncoder().encode('nvidia-smi\r');
    transport.writeTerminal(terminalId, input);
    expect(stream.writes).toEqual([input]);
  });

  it('maps resize onto setWindow(rows, cols, ...)', async () => {
    const { transport, client } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    transport.resizeTerminal(terminalId, 150, 45);
    expect(stream.windows).toEqual([[45, 150, 0, 0]]);
  });

  it('reports terminal close exactly once', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
    const terminalId = await openPromise;
    stream.emitClose();
    stream.emitClose();
    expect(recorder.closes).toEqual([{ terminalId, exitCode: null }]);
  });

  it('closes terminals and reports disconnected when the connection drops', async () => {
    const { transport, client, recorder } = await connectedTransport();
    const stream = new FakeShellStream();
    const openPromise = transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 });
    client.shellRequests[0]!.callback(undefined, stream);
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
      transport.openTerminal({ profileId: 'p1', cols: 80, rows: 24 }),
    ).rejects.toThrow('not connected');
  });
});
