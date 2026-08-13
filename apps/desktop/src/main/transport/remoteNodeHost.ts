import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { DirectoryListing } from '@cozypad/contracts';
import { quoteShellArg } from '@cozypad/contracts';
import type { NodeChildProcessLike } from '@cozypad/acp-client';
import type { NodeHostProcessSpec } from './nodeHostRuntime';
import type {
  HostRpcMessage,
  HostRpcProcessEvent,
  HostRpcResponse,
} from './remoteHostProtocol';

type EventEmitterEvent = Parameters<EventEmitter['on']>[0];
type EventEmitterListener = Parameters<EventEmitter['on']>[1];

export interface Ssh2ExecStreamLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
  close(): void;
  stderr?: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown };
}

export interface Ssh2DuplexExecStreamLike {
  readonly readable?: boolean;
  readonly readableEnded?: boolean;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  readonly closed?: boolean;
  readonly errored?: Error | null;
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'close',
    listener: (code?: number | null, signal?: string | null) => void,
  ): this;
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): unknown;
  end?(): unknown;
  resume?(): unknown;
  close(): void;
  stderr?: {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  };
}

export interface Ssh2SftpLike {
  writeFile(
    remotePath: string,
    data: Buffer,
    callback: (error?: Error | null) => void,
  ): void;
  end?(): void;
}

export interface SshNodeHostClientLike {
  exec(
    command: string,
    callback: (error: Error | undefined, stream: Ssh2ExecStreamLike) => void,
  ): void;
  sftp(
    callback: (error: Error | undefined, sftp: Ssh2SftpLike) => void,
  ): void;
}

export interface RemoteHostProcess extends NodeChildProcessLike {
  readonly ended: boolean;
  kill(): void;
}

export interface RemoteHostRuntime {
  exec(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs?: number,
    collectOutput?: boolean,
    signal?: AbortSignal,
  ): Promise<string>;
  writeFile(filePath: string, data: Uint8Array): Promise<void>;
  fsList(dirPath: string): Promise<DirectoryListing>;
  fsReadText(filePath: string, maxBytes: number, offset: number): Promise<string>;
  fsReadBytes(filePath: string, maxBytes: number): Promise<string>;
  fsWrite(filePath: string, data: Uint8Array): Promise<void>;
  fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void>;
  fsRename(filePath: string, newName: string): Promise<void>;
  fsDuplicate(filePath: string): Promise<string>;
  fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  fsRemove(filePath: string): Promise<void>;
  spawnProcess(spec: NodeHostProcessSpec): Promise<RemoteHostProcess>;
  dispose(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class RemoteNodeProcess extends EventEmitter implements RemoteHostProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: string | null = null;

  ended = false;
  private pendingError: Error | null = null;

  constructor(
    private readonly runtime: RemoteNodeHostClient,
    readonly processId: string,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.runtime.writeProcess(this.processId, bytes).then(
          () => callback(),
          (error) => callback(error),
        );
      },
    });
  }

  override on(event: EventEmitterEvent, listener: EventEmitterListener): this {
    super.on(event, listener);
    if (event === 'error' && this.pendingError !== null) {
      const error = this.pendingError;
      this.pendingError = null;
      queueMicrotask(() => this.emit('error', error));
    }
    return this;
  }

  kill(): void {
    if (this.ended) return;
    void this.runtime
      .killProcess(this.processId)
      .catch((error) => this.disconnect(error));
  }

  receive(event: HostRpcProcessEvent): void {
    if (event.event === 'stdout' && event.data !== undefined) {
      this.stdout.write(Buffer.from(event.data, 'base64'));
      return;
    }
    if (event.event === 'stderr' && event.data !== undefined) {
      this.stderr.write(Buffer.from(event.data, 'base64'));
      return;
    }
    if (event.event === 'error') {
      this.fail(new Error(event.error ?? 'remote process failed'));
      return;
    }
    if (event.event !== 'exit' || this.ended) return;
    this.ended = true;
    this.exitCode = event.code ?? null;
    this.signalCode = event.signal ?? null;
    this.emit('exit', this.exitCode, this.signalCode);
    this.stdout.end();
    this.stderr.end();
    this.stdin.destroy();
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.pendingError = error;
    this.stdout.destroy();
    this.stderr.destroy();
    this.stdin.destroy();
    if (this.listenerCount('error') > 0) {
      this.pendingError = null;
      this.emit('error', error);
    }
  }

  disconnect(error: Error): void {
    if (this.ended) return;
    this.fail(error);
    this.ended = true;
    this.emit('exit', null, null);
  }
}

export class RemoteNodeHostClient implements RemoteHostRuntime {
  private readonly decoder = new StringDecoder('utf8');
  private pendingText = '';
  private nextRequestId = 1;
  private nextProcessId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly lineListeners = new Map<number, (line: string) => void>();
  private readonly processes = new Map<string, RemoteNodeProcess>();

  constructor(private readonly channel: Ssh2DuplexExecStreamLike) {
    channel.on('data', (chunk) => this.receiveData(chunk));
    channel.on('error', (error) => this.closeWithError(error));
    channel.on('close', () => this.closeWithError(new Error('remote Node host bridge closed')));
  }

  ping(): Promise<void> {
    return this.request('ping', {});
  }

  exec(command: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
    return this.execStream(command, () => undefined, timeoutMs, true, signal);
  }

  async execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs = 15_000,
    collectOutput = false,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error('command aborted');
    const id = this.nextRequestId++;
    this.lineListeners.set(id, onLine);
    const abort = () => {
      void this.request('cancel', { requestId: id }).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await this.requestWithId<string>(id, 'execStream', {
        command,
        timeoutMs,
        collectOutput,
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.lineListeners.delete(id);
    }
  }

  writeFile(filePath: string, data: Uint8Array): Promise<void> {
    return this.request('writeFile', {
      filePath,
      data: Buffer.from(data).toString('base64'),
    });
  }

  fsList(dirPath: string): Promise<DirectoryListing> {
    return this.request('fsList', { dirPath });
  }

  fsReadText(filePath: string, maxBytes: number, offset: number): Promise<string> {
    return this.request('fsReadText', { filePath, maxBytes, offset });
  }

  fsReadBytes(filePath: string, maxBytes: number): Promise<string> {
    return this.request('fsReadBytes', { filePath, maxBytes });
  }

  fsWrite(filePath: string, data: Uint8Array): Promise<void> {
    return this.request('fsWrite', {
      filePath,
      data: Buffer.from(data).toString('base64'),
    });
  }

  fsCreate(
    directory: string,
    name: string,
    kind: 'file' | 'directory',
  ): Promise<void> {
    return this.request('fsCreate', { directory, name, kind });
  }

  fsRename(filePath: string, newName: string): Promise<void> {
    return this.request('fsRename', { filePath, newName });
  }

  fsDuplicate(filePath: string): Promise<string> {
    return this.request('fsDuplicate', { filePath });
  }

  fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.request('fsCopyTo', { sourcePath, destinationDirectory });
  }

  fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.request('fsMoveTo', { sourcePath, destinationDirectory });
  }

  fsRemove(filePath: string): Promise<void> {
    return this.request('fsRemove', { filePath });
  }

  async spawnProcess(spec: NodeHostProcessSpec): Promise<RemoteHostProcess> {
    const processId = 'remote-process-' + this.nextProcessId++;
    const process = new RemoteNodeProcess(this, processId);
    this.processes.set(processId, process);
    try {
      await this.request('spawnProcess', { processId, spec });
      return process;
    } catch (error) {
      this.processes.delete(processId);
      process.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  writeProcess(processId: string, data: Uint8Array): Promise<void> {
    return this.request('processWrite', {
      processId,
      data: Buffer.from(data).toString('base64'),
    });
  }

  async killProcess(processId: string): Promise<void> {
    await this.request('processKill', { processId });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    this.closeWithError(new Error('remote Node host bridge disposed'));
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.requestWithId<T>(this.nextRequestId++, method, params);
  }

  private requestWithId<T>(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('remote Node host bridge is closed'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const payload = Buffer.from(
        JSON.stringify({ type: 'request', id, method, params }) + '\n',
        'utf8',
      );
      this.channel.write(payload, (error) => {
        if (error === undefined || error === null) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private receiveData(chunk: Uint8Array | string): void {
    this.pendingText +=
      typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    const lines = this.pendingText.split('\n');
    this.pendingText = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') this.receiveLine(line);
    }
  }

  private receiveLine(line: string): void {
    let message: HostRpcMessage;
    try {
      message = JSON.parse(line) as HostRpcMessage;
    } catch {
      this.closeWithError(new Error('remote Node host returned invalid JSON'));
      return;
    }

    if (message.type === 'response') {
      this.receiveResponse(message);
      return;
    }
    if (message.type === 'event') {
      this.lineListeners.get(message.requestId)?.(message.line);
      return;
    }
    const process = this.processes.get(message.processId);
    process?.receive(message);
    if (message.event === 'exit') this.processes.delete(message.processId);
  }

  private receiveResponse(message: HostRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private closeWithError(error: Error): void {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const process of this.processes.values()) process.disconnect(error);
    this.processes.clear();
  }
}

function remoteHostEntryPath(): string {
  return path.join(__dirname, 'remote-host.cjs');
}

function markerValue(output: string, name: string): string | undefined {
  const prefix = name + '=';
  return output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function rawExec(
  client: SshNodeHostClientLike,
  command: string,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      let output = '';
      let errorOutput = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        reject(new Error('remote bootstrap command timed out'));
      }, timeoutMs);
      stream.on('data', (chunk) => {
        output += stdout.write(Buffer.from(chunk));
      });
      stream.stderr?.on('data', (chunk) => {
        errorOutput += stderr.write(Buffer.from(chunk));
      });
      stream.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        output += stdout.end();
        errorOutput += stderr.end();
        if (code === 0 || code === null) resolve(output);
        else {
          reject(
            new Error(
              errorOutput.trim() ||
                output.trim() ||
                'remote bootstrap command exited with ' + String(code),
            ),
          );
        }
      });
    });
  });
}

function uploadFile(
  client: SshNodeHostClientLike,
  remotePath: string,
  data: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.writeFile(remotePath, Buffer.from(data), (writeError) => {
        sftp.end?.();
        if (writeError) reject(writeError);
        else resolve();
      });
    });
  });
}

function openRawChannel(
  client: SshNodeHostClientLike,
  command: string,
): Promise<Ssh2DuplexExecStreamLike> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) reject(error);
      else resolve(stream as unknown as Ssh2DuplexExecStreamLike);
    });
  });
}

async function waitForPing(runtime: RemoteNodeHostClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runtime.ping(),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('remote Node host did not answer its handshake')),
          12_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Installs and starts the shared Node host runtime over one channel of the
 * existing SSH connection. SFTP is used only to bootstrap the runner itself.
 */
export async function connectRemoteNodeHost(
  client: SshNodeHostClientLike,
): Promise<RemoteHostRuntime> {
  const probe = [
    'cozypad_login_shell="${SHELL:-}"',
    'if [ -z "$cozypad_login_shell" ] && command -v getent >/dev/null 2>&1; then',
    '  cozypad_login_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"',
    'fi',
    'if [ -z "$cozypad_login_shell" ]; then',
    '  cozypad_login_shell="$(command -v sh 2>/dev/null || true)"',
    'fi',
    'cozypad_login_env=""',
    'if [ -n "$cozypad_login_shell" ] && [ -x "$cozypad_login_shell" ]; then',
    '  cozypad_login_env="$("$cozypad_login_shell" -l -i -c env 2>/dev/null || true)"',
    'fi',
    'cozypad_login_path="$(echo "$cozypad_login_env" | sed -n \'s/^PATH=//p\' | tail -n 1)"',
    'if [ -z "$cozypad_login_path" ]; then cozypad_login_path="$PATH"; fi',
    'cozypad_home="$(echo "$cozypad_login_env" | sed -n \'s/^HOME=//p\' | tail -n 1)"',
    'if [ -z "$cozypad_home" ]; then cozypad_home="$HOME"; fi',
    'PATH="$cozypad_login_path"',
    'export PATH',
    'cozypad_node="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"',
    'if [ -z "$cozypad_node" ]; then echo "Node.js is required on the remote host"; exit 127; fi',
    'printf "__COZYPAD_NODE__=%s\\n" "$cozypad_node"',
    'printf "__COZYPAD_HOME__=%s\\n" "$cozypad_home"',
    'printf "__COZYPAD_LOGIN_PATH__=%s\\n" "$cozypad_login_path"',
  ].join('\n');
  const diagnostics = await rawExec(client, probe);
  const nodePath = markerValue(diagnostics, '__COZYPAD_NODE__');
  const home = markerValue(diagnostics, '__COZYPAD_HOME__');
  const loginPath = markerValue(diagnostics, '__COZYPAD_LOGIN_PATH__');
  if (nodePath === undefined || !nodePath.startsWith('/')) {
    throw new Error('Remote host did not provide an absolute Node.js path');
  }
  if (home === undefined || !home.startsWith('/') || home === '/') {
    throw new Error('Remote host did not provide a safe user home directory');
  }
  if (loginPath === undefined || loginPath === '') {
    throw new Error('Remote host did not provide a login PATH');
  }

  const directory = home.replace(/\/+$/u, '') + '/.cozypad';
  const remoteEntry = directory + '/remote-host.cjs';
  await rawExec(client, 'mkdir -p -- ' + quoteShellArg(directory));
  await uploadFile(client, remoteEntry, await readFile(remoteHostEntryPath()));

  const invocation =
    'exec env ' +
    [
      'HOME=' + home,
      'PATH=' + loginPath,
      nodePath,
      remoteEntry,
    ].map(quoteShellArg).join(' ');
  const channel = await openRawChannel(client, invocation);
  const runtime = new RemoteNodeHostClient(channel);
  try {
    await waitForPing(runtime);
    return runtime;
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
