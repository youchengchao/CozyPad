import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ConnectionProfile, DirectoryListing, TerminalOpenRequest } from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';

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
  /**
   * Commands in flight. A remote host ends these for us when the connection
   * drops; here nothing does, and an agent-follow loop left running would poll
   * its files forever after the session it watched is gone.
   */
  private readonly execChildren = new Set<ChildProcess>();
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
    for (const child of [...this.execChildren]) this.endExec(child);
    this.execChildren.clear();
    this.events?.onConnectionState({ profileId, state: 'disconnected' });
    return Promise.resolve();
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('not connected');
  }

  /**
   * Killing the shell is not enough to settle its promise: a grandchild it
   * spawned still holds the output pipes, and `close` waits for those. The
   * command is over as far as we are concerned, so the streams go too.
   */
  private endExec(child: ChildProcess): void {
    child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  /**
   * Commands are written for a POSIX shell, as they are for a remote host, so
   * the same scripts work in both places. Git for Windows ships one; without
   * it the caller gets a clear error rather than a cryptic parse failure.
   */
  private shell(): { command: string; args: (script: string) => string[] } {
    if (process.platform !== 'win32') {
      return { command: '/bin/sh', args: (script) => ['-lc', script] };
    }
    const candidates = [
      process.env.COZYPAD_LOCAL_SHELL,
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter((value): value is string => value !== undefined && value !== '');
    return {
      command: candidates[0] ?? 'bash.exe',
      args: (script) => ['-lc', script],
    };
  }

  exec(command: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
    return this.execStream(command, () => undefined, timeoutMs, true, signal);
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
    const shell = this.shell();
    return new Promise<string>((resolve, reject) => {
      if (signal) {
        if (signal.aborted) {
          reject(new Error('command aborted'));
          return;
        }
      }
      const child = spawn(shell.command, shell.args(command), {
        windowsHide: true,
      });
      this.execChildren.add(child);
      let output = '';
      let stdoutPending = '';
      let stderrPending = '';
      let settled = false;

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          settled = true;
          child.kill();
          reject(new Error(`local command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (signal) {
        signal.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          child.kill();
          reject(new Error('command aborted'));
        });
      }

      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      const consumeStdout = (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        if (collectOutput) output += text;
        stdoutPending += text;
        const lines = stdoutPending.split('\n');
        stdoutPending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      };

      const consumeStderr = (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        if (collectOutput) output += text;
        stderrPending += text;
        const lines = stderrPending.split('\n');
        stderrPending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      };

      child.stdout.on('data', consumeStdout);
      child.stderr.on('data', consumeStderr);
      child.on('error', (error) => {
        this.execChildren.delete(child);
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        reject(
          new Error(
            `cannot run local commands: ${error.message}. A POSIX shell is required; set COZYPAD_LOCAL_SHELL to one.`,
          ),
        );
      });
      child.on('close', () => {
        this.execChildren.delete(child);
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const finalStdoutPending = stdoutPending + stdoutDecoder.end();
        if (finalStdoutPending !== '') onLine(finalStdoutPending);
        const finalStderrPending = stderrPending + stderrDecoder.end();
        if (finalStderrPending !== '') onLine(finalStderrPending);
        resolve(output + stdoutDecoder.end() + stderrDecoder.end());
      });
    });
  }

  async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }

  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string> {
    this.assertConnected();
    const terminalId = `local-term-${this.nextTerminalId++}`;
    const shell = this.shell();
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
    const resolvedPath = path.resolve(resolveHome(dirPath));
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const limit = 2000;
    const truncated = entries.length > limit;
    const capped = truncated ? entries.slice(0, limit) : entries;
    const rawItems = await Promise.all(
      capped.map(async (entry) => {
        const entryPath = path.join(resolvedPath, entry.name);
        try {
          const lstat = await fs.lstat(entryPath);
          let type = 'f';
          if (lstat.isDirectory()) type = 'd';
          else if (lstat.isSymbolicLink()) type = 'l';

          let linkTarget: string | undefined;
          let targetType: string | undefined;
          if (lstat.isSymbolicLink()) {
            try {
              linkTarget = await fs.readlink(entryPath);
              const stat = await fs.stat(entryPath);
              targetType = stat.isDirectory() ? 'd' : 'f';
            } catch {
              targetType = 'N'; // broken link
            }
          }

          const isExecutable = !lstat.isDirectory() && ((lstat.mode & 0o111) > 0);

          return {
            name: entry.name,
            path: entryPath,
            type,
            sizeBytes: lstat.size,
            modified: formatMtime(lstat.mtime),
            ...(linkTarget ? { linkTarget } : {}),
            ...(targetType ? { targetType } : {}),
            executable: isExecutable,
          };
        } catch (err) {
          return null;
        }
      })
    );

    const items = rawItems.filter((item): item is NonNullable<typeof item> => item !== null);

    items.sort((a, b) => {
      const aDir = a.type === 'd' || (a.type === 'l' && a.targetType === 'd');
      const bDir = b.type === 'd' || (b.type === 'l' && b.targetType === 'd');
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return { path: resolvedPath, items, truncated };
  }

  async fsReadText(filePath: string, maxBytes: number, offset: number): Promise<string> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (stat.size > offset + maxBytes) {
        content += `\n\n[Preview truncated: showing bytes ${offset + 1} to ${offset + maxBytes} of ${stat.size} bytes]`;
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  async fsReadBytes(filePath: string): Promise<string> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    const content = await fs.readFile(resolved);
    return content.toString('base64');
  }

  async fsWrite(filePath: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write by creating temporary file and renaming it
    const base = path.basename(resolved);
    const tmpPath = path.join(dir, `.${base}.tmp.${Math.random().toString(36).substring(2)}`);
    await fs.writeFile(tmpPath, data);
    try {
      await fs.rename(tmpPath, resolved);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    this.assertConnected();
    const resolvedDir = path.resolve(resolveHome(directory));
    const target = path.join(resolvedDir, name);
    if (kind === 'file') {
      const handle = await fs.open(target, 'w');
      await handle.close();
    } else {
      await fs.mkdir(target, { recursive: true });
    }
  }

  async fsRename(filePath: string, newName: string): Promise<void> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    const dir = path.dirname(resolved);
    const target = path.join(dir, newName);
    await fs.rename(resolved, target);
  }

  async fsDuplicate(filePath: string): Promise<string> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    let dest = path.join(dir, `${base}_copy`);
    try {
      await fs.access(dest);
      const dateStr = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
      dest = path.join(dir, `${base}_copy_${dateStr}`);
    } catch {
      // Destination doesn't exist, proceed
    }
    await fs.cp(resolved, dest, { recursive: true });
    return dest;
  }

  async fsCopyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.assertConnected();
    const src = path.resolve(resolveHome(sourcePath));
    const destDir = path.resolve(resolveHome(destinationDirectory));
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    await fs.cp(src, dest, { recursive: true });
    return dest;
  }

  async fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    this.assertConnected();
    const src = path.resolve(resolveHome(sourcePath));
    const destDir = path.resolve(resolveHome(destinationDirectory));
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    await fs.rename(src, dest);
    return dest;
  }

  async fsRemove(filePath: string): Promise<void> {
    this.assertConnected();
    const resolved = path.resolve(resolveHome(filePath));
    await fs.rm(resolved, { recursive: true, force: true });
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) terminal.kill();
    this.terminals.clear();
    this.protectedTerminals.clear();
    for (const child of [...this.execChildren]) this.endExec(child);
    this.execChildren.clear();
    this.connected = false;
  }
}

function resolveHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function formatMtime(mtime: Date): string {
  const y = mtime.getFullYear();
  const m = String(mtime.getMonth() + 1).padStart(2, '0');
  const d = String(mtime.getDate()).padStart(2, '0');
  const h = String(mtime.getHours()).padStart(2, '0');
  const min = String(mtime.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}
