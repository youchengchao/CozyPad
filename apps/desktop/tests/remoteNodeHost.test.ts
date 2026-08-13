import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RemoteNodeHostClient,
  type Ssh2DuplexExecStreamLike,
} from '../src/main/transport/remoteNodeHost';

type EventEmitterEvent = Parameters<EventEmitter['on']>[0];
type EventEmitterListener = Parameters<EventEmitter['on']>[1];

function runnerChannel(
  child: ChildProcessWithoutNullStreams,
): Ssh2DuplexExecStreamLike {
  const channel = {
    on(event: EventEmitterEvent, listener: EventEmitterListener) {
      if (event === 'data' || event === 'end') child.stdout.on(event, listener);
      else if (event === 'error') child.on('error', listener);
      else if (event === 'close') child.on('exit', listener);
      return channel;
    },
    write(chunk: Uint8Array, callback?: (error?: Error | null) => void) {
      return child.stdin.write(chunk, callback);
    },
    close() {
      child.stdin.end();
    },
    stderr: child.stderr,
  };
  return channel as unknown as Ssh2DuplexExecStreamLike;
}

describe('remote Node host runner', () => {
  it('runs the shared filesystem and process runtime over one stdio bridge', async () => {
    const entry = fileURLToPath(
      new URL('../dist/remote-host.cjs', import.meta.url),
    );
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const runnerExit = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    const host = new RemoteNodeHostClient(runnerChannel(child));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-host-'));

    try {
      await host.ping();
      await host.fsCreate(directory, 'note.txt', 'file');
      await host.fsWrite(
        path.join(directory, 'note.txt'),
        Buffer.from('shared-runtime', 'utf8'),
      );
      await expect(
        host.fsReadText(path.join(directory, 'note.txt'), 1024, 0),
      ).resolves.toBe('shared-runtime');
      await expect(
        host.fsReadBytes(path.join(directory, 'note.txt'), 1024),
      ).resolves.toBe(Buffer.from('shared-runtime').toString('base64'));
      await expect(
        host.fsReadBytes(path.join(directory, 'note.txt'), 4),
      ).rejects.toThrow('File is too large to read');

      const remoteProcess = await host.spawnProcess({
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.once('data', data => process.stdout.write(data, () => process.exit(0)))",
        ],
        cwd: directory,
      });
      const output = new Promise<string>((resolve) => {
        remoteProcess.stdout?.on('data', (chunk) =>
          resolve(Buffer.from(chunk).toString('utf8')),
        );
      });
      const exit = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          remoteProcess.on('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      await new Promise<void>((resolve, reject) => {
        remoteProcess.stdin?.write(Buffer.from('bridge-ok'), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      await expect(output).resolves.toBe('bridge-ok');
      await expect(exit).resolves.toEqual({ code: 0, signal: null });
      const hangingProcess = await host.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000)'],
        cwd: directory,
      });
      const disconnected = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) => {
        hangingProcess.on('exit', (code, signal) => resolve({ code, signal }));
      });
      host.dispose();
      await expect(disconnected).resolves.toEqual({ code: null, signal: null });
    } finally {
      host.dispose();
      await runnerExit;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
