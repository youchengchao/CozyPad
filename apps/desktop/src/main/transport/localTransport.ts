import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile, DirectoryListing, TerminalOpenRequest } from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';
import { NodeHostRuntime, nodeHostShell } from './nodeHostRuntime';

/**
 * The machine CozyPad itself runs on, offered as a connection so an agent that
 * is already installed here does not require a remote host to reach it.
 */
export const LOCAL_PROFILE: ConnectionProfile = {
  id: 'local-machine',
  name: `This computer (${os.hostname()})`,
  // Descriptive only. Nothing here is dialled: the transport spawns a child
  // process, so no socket is opened, nothing listens, and no address is used.
  host: 'localhost',
  port: 22,
  username: os.userInfo().username,
  authMethod: 'password',
  hasPassword: false,
  hasPrivateKey: false,
  credentialPersisted: false,
  isLocal: true,
};

export function isLocalProfile(profileId: string): boolean {
  return profileId === LOCAL_PROFILE.id;
}

/**
 * Windows has no `fork`, so an interactive program only gets a real terminal
 * through a pseudo-console. `conhost --headless` is one: it takes an explicit
 * size, runs the program attached to it, and proxies the VT stream over the
 * usual stdio pipes. This is the same mechanism the platform's own SSH server
 * uses, and it is what makes a TUI agent behave here exactly as it does on a
 * remote host.
 */
const CONHOST = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'conhost.exe',
);

interface LocalTerminal {
  kill(): void;
  write(data: Uint8Array): void;
}

export class LocalTransport implements TransportPort {
  private events: TransportEvents | null = null;
  private connected = false;
  private nextTerminalId = 1;
  private readonly terminals = new Map<string, LocalTerminal>();
  private readonly protectedTerminals = new Set<string>();
  private readonly host = new NodeHostRuntime();
  /**
   * Recent output per terminal. A session starts producing its screen before
   * anyone opens it; with tmux an attach triggers a fresh redraw, but a shared
   * console has already spoken, so the first viewer would see nothing.
   */
  private readonly buffers = new Map<string, Uint8Array[]>();

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  connect(profileId: string): Promise<void> {
    this.connected = true;
    this.events?.onConnectionState({ profileId, state: 'connected' });
    return Promise.resolve();
  }

  disconnect(profileId: string): Promise<void> {
    this.connected = false;
    for (const terminalId of [...this.terminals.keys()]) this.forceCloseTerminal(terminalId);
    this.host.stopExecs();
    this.events?.onConnectionState({ profileId, state: 'disconnected' });
    return Promise.resolve();
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('not connected');
  }

  exec(command: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    return this.host.exec(command, timeoutMs, signal);
  }

  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs = 15_000,
    collectOutput = false,
    signal?: AbortSignal,
  ): Promise<string> {
    // Rejected rather than thrown: an async method that sometimes throws
    // synchronously forces every caller to guard twice.
    if (!this.connected) return Promise.reject(new Error('not connected'));
    return this.host.execStream(command, onLine, timeoutMs, collectOutput, signal);
  }

  async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    await this.host.writeFile(filePath, data);
  }

  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string> {
    this.assertConnected();
    const terminalId = `local-term-${this.nextTerminalId++}`;
    const shell = nodeHostShell();
    const target =
      command === undefined
        ? [shell.command, '-l', '-i']
        : [shell.command, ...shell.args(command)];

    const child = spawn(
      CONHOST,
      [
        '--headless',
        '--width',
        String(request.cols),
        '--height',
        String(request.rows),
        '--',
        ...target,
      ],
      { windowsHide: true },
    );

    const emit = (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk);
      const buffered = this.buffers.get(terminalId) ?? [];
      buffered.push(bytes);
      // Bounded: a long-running agent must not grow this without limit.
      while (buffered.length > 400) buffered.shift();
      this.buffers.set(terminalId, buffered);
      this.events?.onTerminalOutput(terminalId, bytes);
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (error) => {
      if (this.terminals.delete(terminalId)) {
        this.events?.onTerminalClosed(terminalId, null, error.message);
      }
    });
    child.on('close', (code) => {
      if (this.terminals.delete(terminalId)) {
        this.events?.onTerminalClosed(terminalId, code);
      }
    });

    this.terminals.set(terminalId, {
      kill: () => child.kill(),
      write: (data) => child.stdin.write(data),
    });
    return Promise.resolve(terminalId);
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.terminals.get(terminalId)?.write(data);
  }

  /** Re-emit what a terminal has already printed, for a viewer joining late. */
  replayTerminal(terminalId: string): void {
    for (const chunk of this.buffers.get(terminalId) ?? []) {
      this.events?.onTerminalOutput(terminalId, chunk);
    }
  }

  /** Whether the program behind this terminal is still running. */
  hasTerminal(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * A headless pseudo-console fixes its size when it starts: resizing it needs
   * a signal pipe that cannot be handed over from here. Callers that care must
   * open the terminal at the size they intend to keep — which is what the AGY
   * surface already does.
   */
  resizeTerminal(): void {
    // Intentionally unsupported; see the note above.
  }

  /**
   * A session's console belongs to the session, not to whoever is looking at
   * it. Closing a chat view must not end the agent running behind it, so a
   * terminal owned by a session ignores an ordinary close.
   */
  protectTerminal(terminalId: string): void {
    this.protectedTerminals.add(terminalId);
  }

  closeTerminal(terminalId: string): void {
    if (this.protectedTerminals.has(terminalId)) return;
    this.forceCloseTerminal(terminalId);
  }

  /** Ends the program for real; only the owner of a session should call this. */
  forceCloseTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return;
    this.terminals.delete(terminalId);
    this.protectedTerminals.delete(terminalId);
    this.buffers.delete(terminalId);
    terminal.kill();
  }

  async fsList(dirPath: string): Promise<DirectoryListing> {
    this.assertConnected();
    return this.host.fsList(dirPath);
  }

  async fsReadText(filePath: string, maxBytes: number, offset: number): Promise<string> {
    this.assertConnected();
    return this.host.fsReadText(filePath, maxBytes, offset);
  }

  async fsReadBytes(filePath: string, maxBytes: number): Promise<string> {
    this.assertConnected();
    return this.host.fsReadBytes(filePath, maxBytes);
  }

  async fsWrite(filePath: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    await this.host.fsWrite(filePath, data);
  }

  async fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    this.assertConnected();
    await this.host.fsCreate(directory, name, kind);
  }

  async fsRename(filePath: string, newName: string): Promise<void> {
    this.assertConnected();
    await this.host.fsRename(filePath, newName);
  }

  async fsDuplicate(filePath: string): Promise<string> {
    this.assertConnected();
    return this.host.fsDuplicate(filePath);
  }

  async fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.assertConnected();
    return this.host.fsCopyTo(sourcePath, destinationDirectory);
  }

  async fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.assertConnected();
    return this.host.fsMoveTo(sourcePath, destinationDirectory);
  }

  async fsRemove(filePath: string): Promise<void> {
    this.assertConnected();
    await this.host.fsRemove(filePath);
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) terminal.kill();
    this.terminals.clear();
    this.protectedTerminals.clear();
    this.host.stopExecs();
    this.connected = false;
  }
}
