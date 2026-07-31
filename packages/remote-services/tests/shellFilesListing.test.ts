import { describe, expect, it } from 'vitest';
import { ShellRemoteFiles } from '../src/shellRemoteFiles';

function fakeExec(output: string): {
  exec: (command: string) => Promise<string>;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    exec: (command: string) => {
      commands.push(command);
      return Promise.resolve(output);
    },
  };
}

const LISTING = [
  '__PWD__\t/home/y',
  'd\tprojects\t4096\t2026-07-29 10:00\td\t\t755',
  'l\tdata\t12\t2026-07-29 10:00\td\t/mnt/datasets\t777',
  'l\tbroken\t9\t2026-07-29 10:00\tN\t/gone\t777',
  'f\trun.sh\t120\t2026-07-29 10:00\tf\t\t755',
  'f\tnotes.md\t340\t2026-07-29 10:00\tf\t\t644',
].join('\n');

describe('ShellRemoteFiles.list metadata', () => {
  it('keeps symlink targets and resolved target types', async () => {
    const { exec } = fakeExec(LISTING);
    const listing = await new ShellRemoteFiles(exec).list('~');
    const byName = new Map(listing.items.map((item) => [item.name, item]));

    expect(byName.get('data')).toMatchObject({
      type: 'l',
      linkTarget: '/mnt/datasets',
      targetType: 'd',
    });
    expect(byName.get('broken')).toMatchObject({ type: 'l', targetType: 'N' });
  });

  it('flags executables from the mode field', async () => {
    const { exec } = fakeExec(LISTING);
    const listing = await new ShellRemoteFiles(exec).list('~');
    const byName = new Map(listing.items.map((item) => [item.name, item]));
    expect(byName.get('run.sh')?.executable).toBe(true);
    expect(byName.get('notes.md')?.executable).toBe(false);
  });

  it('sorts directories and dir-symlinks before files', async () => {
    const { exec } = fakeExec(LISTING);
    const listing = await new ShellRemoteFiles(exec).list('~');
    expect(listing.items.map((item) => item.name)).toEqual([
      'data',
      'projects',
      'broken',
      'notes.md',
      'run.sh',
    ]);
  });

  it('stays single-level and caps huge directories instead of recursing', async () => {
    const rows = Array.from(
      { length: ShellRemoteFiles.ENTRY_LIMIT + 50 },
      (_, index) => `f\tfile${index}\t10\t2026-07-29 10:00\tf\t\t644`,
    );
    const { exec, commands } = fakeExec(['__PWD__\t/big', ...rows].join('\n'));
    const listing = await new ShellRemoteFiles(exec).list('/big');

    expect(commands[0]).toContain('-maxdepth 1');
    expect(commands[0]).not.toContain('-R');
    expect(commands[0]).toContain(`head -n ${ShellRemoteFiles.ENTRY_LIMIT + 1}`);
    expect(listing.items).toHaveLength(ShellRemoteFiles.ENTRY_LIMIT);
    expect(listing.truncated).toBe(true);
  });

  it('reports permission errors from the remote', async () => {
    const { exec } = fakeExec('__ERROR__\tPermission denied: /root');
    await expect(new ShellRemoteFiles(exec).list('/root')).rejects.toThrow(
      'Permission denied',
    );
  });
});
