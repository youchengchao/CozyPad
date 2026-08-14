import { Client } from 'ssh2';
import type {
  ConnectionProfile,
  ConnectionState,
  DirectoryListing,
  TerminalOpenRequest,
} from '@cozypad/contracts';
import { quoteShellArg } from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';
import { connectRemoteNodeHost } from './remoteNodeHost';
import type {
  RemoteHostProcess,
  RemoteHostRuntime,
  Ssh2ExecStreamLike,
  Ssh2SftpLike,
} from './remoteNodeHost';
export type {
  Ssh2DuplexExecStreamLike,
  Ssh2ExecStreamLike,
  Ssh2SftpLike,
} from './remoteNodeHost';
import type { NodeHostProcessSpec } from './nodeHostRuntime';
import type { ProfileCredential } from '../profileStore';

/** ssh2 實際型別的最小子集；測試以 fake 實作注入。 */
export interface Ssh2ShellStreamLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: () => void): this;
  write(data: Uint8Array): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  close(): void;
  stderr?: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown };
}

export interface Ssh2ClientLike {
  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  connect(config: Record<string, unknown>): void;
  shell(
    options: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void,
  ): void;
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
  sftp(
    callback: (error: Error | undefined, sftp: Ssh2SftpLike) => void,
  ): void;
  end(): void;
}

export interface Ssh2TransportOptions {
  getProfile?: (profileId: string) => ConnectionProfile | undefined;
  /** Secrets are resolved in the main process and never returned to the renderer. */
  getCredential?: (
    profileId: string,
  ) => Promise<ProfileCredential | null> | ProfileCredential | null;
  /** SSH host key 驗證（SPEC_V3 13）；回傳 false 中止連線。 */
  verifyHostKey?: (profile: ConnectionProfile, key: Uint8Array) => Promise<boolean>;
  clientFactory?: () => Ssh2ClientLike;
  hostRuntimeFactory?: (
    client: Ssh2ClientLike,
  ) => Promise<RemoteHostRuntime>;
}

const READY_TIMEOUT_MS = 12_000;
const KEEPALIVE_INTERVAL_MS = 10_000;

export const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group18-sha512',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
} as const;

export class Ssh2Transport implements TransportPort {
  private events: TransportEvents | null = null;
  private client: Ssh2ClientLike | null = null;
  private activeProfileId: string | null = null;
  private connecting = false;
  private wasConnected = false;
  private readonly terminals = new Map<string, Ssh2ShellStreamLike>();
  private nextTerminalId = 1;
  private readonly clientFactory: () => Ssh2ClientLike;
  private readonly hostRuntimeFactory: (
    client: Ssh2ClientLike,
  ) => Promise<RemoteHostRuntime>;
  private host: RemoteHostRuntime | null = null;

  constructor(private readonly options: Ssh2TransportOptions = {}) {
    this.clientFactory =
      options.clientFactory ?? (() => new Client() as unknown as Ssh2ClientLike);
    this.hostRuntimeFactory = options.hostRuntimeFactory ?? connectRemoteNodeHost;
  }

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  async connect(profileId: string): Promise<void> {
    const profile = this.options.getProfile?.(profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    if (
      this.client !== null &&
      this.wasConnected &&
      this.activeProfileId === profileId
    ) {
      // A renderer reload loses its local state while the main-process SSH
      // session remains alive. Re-emit the snapshot instead of rejecting.
      this.emitState(profileId, 'connected');
      return;
    }
    if (this.client !== null || this.connecting) {
      throw new Error('already connected; disconnect first');
    }

    this.connecting = true;
    try {
      const authMethod = profile.authMethod ?? 'password';
      const credential = (await this.options.getCredential?.(profileId)) ?? null;
      if (credential === null || credential.authMethod !== authMethod) {
        throw new Error(
          authMethod === 'privateKey'
            ? 'SSH private key is required'
            : 'SSH password is required',
        );
      }

      this.emitState(profileId, 'connecting');
      const client = this.clientFactory();
      this.client = client;
      this.activeProfileId = profileId;
      this.wasConnected = false;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let initializingHost = false;
        const fail = (error: Error): void => {
          if (this.client !== client) return;
          const shouldReject = !settled;
          settled = true;
          this.closeAllTerminals();
          this.host?.dispose();
          this.host = null;
          this.client = null;
          this.activeProfileId = null;
          this.wasConnected = false;
          this.emitState(profileId, 'error', error.message);
          try {
            client.end();
          } catch {
            // The active reference is already cleared, so retry remains safe.
          }
          if (shouldReject) reject(error);
        };

        client.on('ready', () => {
          if (settled || initializingHost || this.client !== client) return;
          initializingHost = true;
          void this.hostRuntimeFactory(client).then(
            (host) => {
              if (settled || this.client !== client) {
                host.dispose();
                return;
              }
              this.host = host;
              settled = true;
              this.wasConnected = true;
              this.emitState(profileId, 'connected');
              resolve();
            },
            fail,
          );
        });
        client.on('error', (error) => fail(error));
        client.on('close', () => {
          if (this.client !== client) return;
          this.closeAllTerminals();
          this.host?.dispose();
          this.host = null;
          this.client = null;
          this.activeProfileId = null;
          const wasConnected = this.wasConnected;
          this.wasConnected = false;
          if (wasConnected) {
            this.emitState(profileId, 'disconnected');
          } else if (!settled) {
            settled = true;
            const error = new Error('connection closed before ready');
            this.emitState(profileId, 'error', error.message);
            reject(error);
          }
        });
        const verifyHostKey = this.options.verifyHostKey;
        try {
          client.connect({
            host: profile.host,
            port: profile.port,
            username: profile.username,
            ...(credential.authMethod === 'password'
              ? { password: credential.password }
              : {
                  privateKey: credential.privateKey,
                  ...(credential.passphrase === undefined
                    ? {}
                    : { passphrase: credential.passphrase }),
                }),
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: KEEPALIVE_INTERVAL_MS,
            algorithms: SSH_ALGORITHMS,
            ...(verifyHostKey === undefined
              ? {}
              : {
                  hostVerifier: (key: Uint8Array, done: (valid: boolean) => void) => {
                    verifyHostKey(profile, key).then(done, () => done(false));
                  },
                }),
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): Promise<void> {
    this.host?.dispose();
    this.host = null;
    this.client?.end();
    return Promise.resolve();
  }

  async exec(command: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
    return this.requireHost().exec(command, timeoutMs, signal);
  }

  async execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs = 15_000,
    collectOutput = true,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.requireHost().execStream(
      command,
      onLine,
      timeoutMs,
      collectOutput,
      signal,
    );
  }

  async writeFile(remotePath: string, data: Uint8Array): Promise<void> {
    await this.requireHost().writeFile(remotePath, data);
  }

  async spawnProcess(spec: NodeHostProcessSpec): Promise<RemoteHostProcess> {
    return this.requireHost().spawnProcess(spec);
  }
  async openTerminal(request: TerminalOpenRequest, command?: string): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('not connected');
    const terminalId = `ssh-term-${this.nextTerminalId++}`;
    const commandPty = {
      term: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      width: 0,
      height: 0,
    };
    const cwdPrefix =
      request.cwd === '~'
        ? 'cd -- "$HOME" || exit 1'
        : request.cwd.startsWith('~/')
          ? `cd -- "$HOME"/${quoteShellArg(request.cwd.slice(2))} || exit 1`
          : `cd -- ${quoteShellArg(request.cwd)} || exit 1`;
    const terminalCommand =
      command === undefined
        ? `${cwdPrefix}\nexec "\${SHELL:-/bin/sh}" -l`
        : `${cwdPrefix}\n${command}`;
    const stream = await new Promise<Ssh2ShellStreamLike>((resolve, reject) => {
      const done = (error: Error | undefined, terminalStream: Ssh2ShellStreamLike) =>
        error ? reject(error) : resolve(terminalStream);
      client.exec(terminalCommand, { pty: commandPty }, done);
    });
    this.terminals.set(terminalId, stream);
    stream.on('data', (chunk) =>
      this.events?.onTerminalOutput(terminalId, new Uint8Array(chunk)),
    );
    stream.stderr?.on('data', (chunk) =>
      this.events?.onTerminalOutput(terminalId, new Uint8Array(chunk)),
    );
    stream.on('close', () => {
      if (this.terminals.delete(terminalId)) {
        this.events?.onTerminalClosed(terminalId, null);
      }
    });
    return terminalId;
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.terminals.get(terminalId)?.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.setWindow(rows, cols, 0, 0);
  }

  closeTerminal(terminalId: string): void {
    this.terminals.get(terminalId)?.close();
  }

  dispose(): void {
    this.host?.dispose();
    this.host = null;
    this.client?.end();
  }

  private requireHost(): RemoteHostRuntime {
    if (this.host === null) {
      throw new Error('remote Node host is not connected');
    }
    return this.host;
  }

  private closeAllTerminals(): void {
    for (const terminalId of [...this.terminals.keys()]) {
      this.terminals.delete(terminalId);
      this.events?.onTerminalClosed(terminalId, null, 'connection closed');
    }
  }

  private emitState(profileId: string, state: ConnectionState, error?: string): void {
    this.events?.onConnectionState({
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    });
  }

  async fsRealpath(inputPath: string): Promise<string> {
    return this.requireHost().fsRealpath(inputPath);
  }

  async fsList(dirPath: string): Promise<DirectoryListing> {
    return this.requireHost().fsList(dirPath);
  }

  async fsReadText(filePath: string, maxBytes: number, offset: number): Promise<string> {
    return this.requireHost().fsReadText(filePath, maxBytes, offset);
  }

  async fsReadBytes(filePath: string, maxBytes: number): Promise<string> {
    return this.requireHost().fsReadBytes(filePath, maxBytes);
  }

  async fsWrite(filePath: string, data: Uint8Array): Promise<void> {
    await this.requireHost().fsWrite(filePath, data);
  }

  async fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    await this.requireHost().fsCreate(directory, name, kind);
  }

  async fsRename(filePath: string, newName: string): Promise<void> {
    await this.requireHost().fsRename(filePath, newName);
  }

  async fsDuplicate(filePath: string): Promise<string> {
    return this.requireHost().fsDuplicate(filePath);
  }

  async fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.requireHost().fsCopyTo(sourcePath, destinationDirectory);
  }

  async fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.requireHost().fsMoveTo(sourcePath, destinationDirectory);
  }

  async fsRemove(filePath: string): Promise<void> {
    await this.requireHost().fsRemove(filePath);
  }
}
