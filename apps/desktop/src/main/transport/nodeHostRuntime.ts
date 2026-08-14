import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  MAX_INLINE_FILE_WRITE_BYTES,
  type DirectoryListing,
} from '@cozypad/contracts';

export interface NodeHostShell {
  command: string;
  args(script: string): string[];
}

export interface NodeHostProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Selects the POSIX-compatible shell used for host-side commands. Keeping this
 * in the host runtime lets the same command semantics run on whichever machine
 * owns the Node process, without moving terminal lifecycle into this layer.
 */
export function nodeHostShell(): NodeHostShell {
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

/** Generic process and filesystem operations for the machine running Node. */
export class NodeHostRuntime {
  private readonly execChildren = new Set<ChildProcess>();

  /** Starts a program on whichever machine owns this Node runtime. */
  spawnProcess(spec: NodeHostProcessSpec): ChildProcess {
    return spawn(spec.command, [...spec.args], {
      cwd: path.resolve(resolveHome(spec.cwd)),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...spec.env },
    });
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
    const shell = nodeHostShell();
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('command aborted'));
        return;
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
          reject(new Error(`host command timed out after ${timeoutMs}ms`));
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
            `cannot run host commands: ${error.message}. A POSIX shell is required; set COZYPAD_LOCAL_SHELL to one.`,
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

  /** Ends all generic commands owned by this host runtime. */
  stopExecs(): void {
    for (const child of [...this.execChildren]) this.endExec(child);
    this.execChildren.clear();
  }

  private endExec(child: ChildProcess): void {
    child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }

  async fsRealpath(inputPath: string): Promise<string> {
    return fs.realpath(path.resolve(resolveHome(inputPath)));
  }

  async fsList(dirPath: string): Promise<DirectoryListing> {
    const resolvedPath = await this.fsRealpath(dirPath);
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
              targetType = 'N';
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
        } catch {
          return null;
        }
      }),
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

  async fsReadBytes(filePath: string, maxBytes: number): Promise<string> {
    const resolved = path.resolve(resolveHome(filePath));
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > maxBytes) {
        throw new Error(
          `File is too large to read (${stat.size} bytes, limit ${maxBytes} bytes).`,
        );
      }
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(
          content,
          offset,
          content.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const finalSize = (await handle.stat()).size;
      if (offset !== stat.size || finalSize !== stat.size) {
        throw new Error(`File changed while it was being read: ${resolved}`);
      }
      return content.toString('base64');
    } finally {
      await handle.close();
    }
  }

  async fsWrite(
    filePath: string,
    data: Uint8Array,
    maxBytes = MAX_INLINE_FILE_WRITE_BYTES,
  ): Promise<void> {
    if (data.byteLength > maxBytes) {
      throw new Error(
        `File is too large to save (${data.byteLength} bytes, limit ${maxBytes} bytes).`,
      );
    }
    const resolved = path.resolve(resolveHome(filePath));
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const base = path.basename(resolved);
    const tmpPath = path.join(dir, `.${base}.tmp.${Math.random().toString(36).substring(2)}`);
    await fs.writeFile(tmpPath, data);
    try {
      await fs.rename(tmpPath, resolved);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  async fsCreate(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    const resolvedDir = path.resolve(resolveHome(directory));
    await assertDirectory(resolvedDir);
    assertValidBasename(name);
    const target = path.join(resolvedDir, name);
    assertDirectChild(resolvedDir, target);
    if (kind === 'file') {
      const handle = await fs.open(target, 'wx');
      await handle.close();
    } else {
      await fs.mkdir(target);
    }
  }

  async fsRename(filePath: string, newName: string): Promise<void> {
    const resolved = path.resolve(resolveHome(filePath));
    const dir = path.dirname(resolved);
    assertValidBasename(newName);
    const target = path.join(dir, newName);
    assertDirectChild(dir, target);
    if (resolved === target) return;
    if (hostPathsEqual(resolved, target)) {
      await fs.rename(resolved, target);
      return;
    }
    await renameWithoutOverwrite(resolved, target);
  }

  async fsDuplicate(filePath: string): Promise<string> {
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
    const src = path.resolve(resolveHome(sourcePath));
    const destDir = path.resolve(resolveHome(destinationDirectory));
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    await fs.cp(src, dest, { recursive: true });
    return dest;
  }

  async fsMoveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    const src = path.resolve(resolveHome(sourcePath));
    const destDir = path.resolve(resolveHome(destinationDirectory));
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    await fs.rename(src, dest);
    return dest;
  }

  async fsRemove(filePath: string): Promise<void> {
    const resolved = path.resolve(resolveHome(filePath));
    const root = path.parse(resolved).root;
    if (hostPathsEqual(resolved, root) || hostPathsEqual(resolved, path.resolve(os.homedir()))) {
      throw new Error(`Refusing to delete protected filesystem path: ${resolved}`);
    }
    await fs.lstat(resolved);
    await fs.rm(resolved, { recursive: true, force: false });
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${directory}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const WINDOWS_NO_CLOBBER_RENAME_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$source = [Environment]::GetEnvironmentVariable("COZYPAD_RENAME_SOURCE")',
  '$target = [Environment]::GetEnvironmentVariable("COZYPAD_RENAME_TARGET")',
  'try {',
  '  if ([IO.Directory]::Exists($source)) {',
  '    [IO.Directory]::Move($source, $target)',
  '  } else {',
  '    [IO.File]::Move($source, $target)',
  '  }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('; ');

/** Node's fs.rename replaces destinations, so use host-native no-clobber moves. */
async function renameWithoutOverwrite(source: string, target: string): Promise<void> {
  let result: { code: number | null; stderr: string };
  if (process.platform === 'win32') {
    result = await runHostUtility(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_NO_CLOBBER_RENAME_SCRIPT],
      {
        COZYPAD_RENAME_SOURCE: source,
        COZYPAD_RENAME_TARGET: target,
      },
    );
  } else {
    result = await runHostUtility('/bin/mv', ['-n', '-T', '--', source, target]);
  }

  const sourceStillExists = await pathExists(source);
  if (result.code === 0 && !sourceStillExists) return;
  if (await pathExists(target)) {
    throw new Error(`Destination already exists: ${target}`);
  }
  const detail = result.stderr.trim();
  throw new Error(detail === '' ? `Rename failed: ${source}` : `Rename failed: ${detail}`);
}

function runHostUtility(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

function assertDirectChild(directory: string, target: string): void {
  if (!hostPathsEqual(path.dirname(target), directory)) {
    throw new Error('File name must be a single path segment');
  }
}

function assertValidBasename(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    name.includes('/') ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error(`Invalid file name: ${name}`);
  }
  if (process.platform !== 'win32') return;
  if (
    /[\\:*?"<>|]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(?:con|prn|aux|nul|clock\$|com[0-9]|lpt[0-9])(?:\..*)?$/iu.test(name)
  ) {
    throw new Error(`Invalid Windows file name: ${name}`);
  }
}

function hostPathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function resolveHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function formatMtime(mtime: Date): string {
  const y = mtime.getFullYear();
  const m = String(mtime.getMonth() + 1).padStart(2, '0');
  const d = String(mtime.getDate()).padStart(2, '0');
  const h = String(mtime.getHours()).padStart(2, '0');
  const min = String(mtime.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}
