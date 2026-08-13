import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHostRuntime } from '../src/main/transport/nodeHostRuntime';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-files-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('NodeHostRuntime filesystem safety', () => {
  it('creates only a new direct child of an existing directory', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();

    await runtime.fsCreate(directory, 'note.txt', 'file');
    await expect(readFile(path.join(directory, 'note.txt'), 'utf8')).resolves.toBe('');
    await expect(runtime.fsCreate(directory, 'note.txt', 'file')).rejects.toThrow();
    await expect(runtime.fsCreate(directory, '../escaped.txt', 'file')).rejects.toThrow(
      'Invalid file name',
    );
    await expect(runtime.fsCreate(directory, '..', 'directory')).rejects.toThrow(
      'Invalid file name',
    );
  });

  it('does not overwrite an existing item during rename', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const source = path.join(directory, 'source.txt');
    const destination = path.join(directory, 'destination.txt');
    await writeFile(source, 'source');
    await writeFile(destination, 'destination');

    await expect(runtime.fsRename(source, 'destination.txt')).rejects.toThrow(
      'Destination already exists',
    );
    await expect(runtime.fsRename(source, '../escaped.txt')).rejects.toThrow(
      'Invalid file name',
    );
    await expect(readFile(destination, 'utf8')).resolves.toBe('destination');
  });

  it('renames a file when the destination is unused', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const source = path.join(directory, 'source.txt');
    const destination = path.join(directory, 'destination.txt');
    await writeFile(source, 'source');

    await runtime.fsRename(source, 'destination.txt');
    await expect(readFile(source, 'utf8')).rejects.toThrow();
    await expect(readFile(destination, 'utf8')).resolves.toBe('source');
  });

  it('does not replace an existing directory during rename', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const source = path.join(directory, 'source');
    const destination = path.join(directory, 'destination');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(path.join(source, 'source.txt'), 'source');
    await writeFile(path.join(destination, 'destination.txt'), 'destination');

    await expect(runtime.fsRename(source, 'destination')).rejects.toThrow(
      'Destination already exists',
    );
    await expect(readFile(path.join(source, 'source.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(path.join(destination, 'destination.txt'), 'utf8')).resolves.toBe(
      'destination',
    );
  });

  it('refuses filesystem-root and home-directory deletion', async () => {
    const runtime = new NodeHostRuntime();
    const root = path.parse(path.resolve(os.homedir())).root;

    await expect(runtime.fsRemove(root)).rejects.toThrow('protected filesystem path');
    await expect(runtime.fsRemove(os.homedir())).rejects.toThrow(
      'protected filesystem path',
    );
  });

  it('removes an explicitly selected non-protected directory', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const child = path.join(directory, 'child');
    await mkdir(child);
    await writeFile(path.join(child, 'note.txt'), 'note');

    await runtime.fsRemove(child);
    await expect(readFile(path.join(child, 'note.txt'))).rejects.toThrow();
  });

  it('checks the byte limit before loading a file into memory', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'note.txt');
    await writeFile(target, 'four');

    await expect(runtime.fsReadBytes(target, 4)).resolves.toBe('Zm91cg==');
    await expect(runtime.fsReadBytes(target, 3)).rejects.toThrow(
      'File is too large to read',
    );
  });

  it('checks the byte limit before writing a file', async () => {
    const runtime = new NodeHostRuntime();
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'note.txt');

    await expect(runtime.fsWrite(target, new Uint8Array(5), 4)).rejects.toThrow(
      'File is too large to save',
    );
    await expect(readFile(target)).rejects.toThrow();
    await runtime.fsWrite(target, new Uint8Array([1, 2, 3, 4]), 4);
    await expect(readFile(target)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
