import { describe, expect, it } from 'vitest';
import { ShellRemoteFiles, quoteShellArg } from '../src/shellRemoteFiles';

function fakeExec(outputs: string[]): {
  exec: (command: string, timeoutMs?: number) => Promise<string>;
  commands: string[];
} {
  const commands: string[] = [];
  const queue = [...outputs];
  return {
    commands,
    exec: (command: string) => {
      commands.push(command);
      return Promise.resolve(queue.shift() ?? '');
    },
  };
}

describe('quoteShellArg', () => {
  it('wraps in single quotes', () => {
    expect(quoteShellArg('~/projects')).toBe("'~/projects'");
  });

  it("escapes embedded single quotes the POSIX way", () => {
    expect(quoteShellArg("it's")).toBe("'it'\"'\"'s'");
  });
});

describe('ShellRemoteFiles.list', () => {
  it('parses __PWD__, entries, and sorts directories first', async () => {
    const listing = [
      '__PWD__\t/home/ycchao/projects',
      'f\tnotes.md\t1234\t2026-07-29 10:00',
      'd\tsrc\t4096\t2026-07-28 09:00',
      'f\tzeta.txt\t10\t2026-07-29 10:00',
      'd\tconfigs\t4096\t2026-07-28 09:00',
    ].join('\n');
    const { exec } = fakeExec([listing]);
    const files = new ShellRemoteFiles(exec);

    const result = await files.list('~/projects');
    expect(result.path).toBe('/home/ycchao/projects');
    expect(result.items.map((item) => item.name)).toEqual([
      'configs',
      'src',
      'notes.md',
      'zeta.txt',
    ]);
    expect(result.items[2]).toMatchObject({
      path: '/home/ycchao/projects/notes.md',
      type: 'f',
      sizeBytes: 1234,
    });
  });

  it('throws the in-band error message', async () => {
    const { exec } = fakeExec(['__ERROR__\tNot a directory: /nope']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.list('/nope')).rejects.toThrow('Not a directory: /nope');
  });

  it('quotes the target path into the script', async () => {
    const { exec, commands } = fakeExec(['__PWD__\t/x\n']);
    const files = new ShellRemoteFiles(exec);
    await files.list("dir with 'quote");
    expect(commands[0]).toContain(`target='dir with '"'"'quote'`);
  });
});

describe('ShellRemoteFiles.write', () => {
  it('sends the base64 payload with an atomic mktemp+mv script', async () => {
    const { exec, commands } = fakeExec(['']);
    const files = new ShellRemoteFiles(exec);
    await files.write('~/notes.md', 'aGVsbG8=');
    const command = commands[0]!;
    expect(command).toContain("payload='aGVsbG8='");
    expect(command).toContain('mktemp');
    expect(command).toContain('base64 -d');
    expect(command).toContain('mv -- "$tmp" "$target"');
  });

  it('propagates remote save errors', async () => {
    const { exec } = fakeExec(['__ERROR__\tSave failed. Check permissions.']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.write('~/x', 'aGk=')).rejects.toThrow('Save failed');
  });

  it('rejects oversized payloads locally', async () => {
    const { exec, commands } = fakeExec(['']);
    const files = new ShellRemoteFiles(exec);
    const big = 'A'.repeat(2 * 1024 * 1024);
    await expect(files.write('~/x', big)).rejects.toThrow('too large');
    expect(commands).toHaveLength(0);
  });
});

describe('ShellRemoteFiles operations', () => {
  it('duplicate returns the new path', async () => {
    const { exec } = fakeExec(['/home/y/notes.md_copy']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.duplicate('/home/y/notes.md')).resolves.toBe(
      '/home/y/notes.md_copy',
    );
  });

  it('moveTo surfaces destination conflicts', async () => {
    const { exec } = fakeExec(['__ERROR__\tDestination already exists: /d/x']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.moveTo('/s/x', '/d')).rejects.toThrow('already exists');
  });

  it('remove issues the guarded rm script', async () => {
    const { exec, commands } = fakeExec(['']);
    const files = new ShellRemoteFiles(exec);
    await files.remove('/home/y/old');
    expect(commands[0]).toContain('Refusing to delete root or home directory');
    expect(commands[0]).toContain('rm -rf --');
  });

  it('rename rejects names with slashes without touching the remote', async () => {
    const { exec, commands } = fakeExec(['']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.rename('/a/b', 'x/y')).rejects.toThrow('cannot');
    expect(commands).toHaveLength(0);
  });

  it('readBytes maps __TOO_LARGE__ into a friendly error', async () => {
    const { exec } = fakeExec(['__TOO_LARGE__\t99999999\t12582912']);
    const files = new ShellRemoteFiles(exec);
    await expect(files.readBytes('/big.bin')).rejects.toThrow('too large for download');
  });

  it('create builds mkdir vs touch variants', async () => {
    const { exec, commands } = fakeExec(['', '']);
    const files = new ShellRemoteFiles(exec);
    await files.create('~/projects', 'data', 'directory');
    await files.create('~/projects', 'run.log', 'file');
    expect(commands[0]).toContain('mkdir "$target"');
    expect(commands[1]).toContain(': > "$target"');
  });
});
