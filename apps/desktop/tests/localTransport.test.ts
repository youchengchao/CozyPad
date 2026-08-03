import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionProfileSchema } from '@cozypad/contracts';
import {
  LOCAL_PROFILE,
  LocalTransport,
  isLocalProfile,
} from '../src/main/transport/localTransport';

/**
 * These run against the real machine — that is the point of the transport, and
 * a mocked child process would prove nothing about whether a pseudo-console
 * actually carries a TUI.
 */
const windows = process.platform === 'win32';

function connected(): {
  transport: LocalTransport;
  output: Map<string, string>;
  closed: string[];
} {
  const transport = new LocalTransport();
  const output = new Map<string, string>();
  const closed: string[] = [];
  transport.setEvents({
    onConnectionState: () => undefined,
    onTerminalOutput: (terminalId, data) => {
      output.set(
        terminalId,
        (output.get(terminalId) ?? '') + Buffer.from(data).toString('utf8'),
      );
    },
    onTerminalClosed: (terminalId) => closed.push(terminalId),
  });
  void transport.connect(LOCAL_PROFILE.id);
  return { transport, output, closed };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('local transport', () => {
  it('identifies its own reserved profile', () => {
    expect(isLocalProfile(LOCAL_PROFILE.id)).toBe(true);
    expect(isLocalProfile('some-ssh-profile')).toBe(false);
  });

  it('announces itself as local so nothing asks the user to log in', () => {
    // Without this flag the UI sees a password profile with no saved password
    // and prompts for one — asking the user to unlock their own machine.
    expect(LOCAL_PROFILE.isLocal).toBe(true);
    expect(LOCAL_PROFILE.hasPassword).toBe(false);
    expect(LOCAL_PROFILE.hasPrivateKey).toBe(false);
    expect(LOCAL_PROFILE.credentialPersisted).toBe(false);
  });

  it('is valid as a profile, so it survives contract parsing', () => {
    expect(() => ConnectionProfileSchema.parse(LOCAL_PROFILE)).not.toThrow();
  });

  it('refuses to work before connecting', async () => {
    const transport = new LocalTransport();
    await expect(transport.exec('echo hi')).rejects.toThrow('not connected');
  });

  it('runs a POSIX command and returns its output', async () => {
    const { transport } = connected();

    const output = await transport.exec('echo cozypad-local && echo second');

    expect(output).toContain('cozypad-local');
    expect(output).toContain('second');
    transport.dispose();
  });

  it('streams a command line by line', async () => {
    const { transport } = connected();
    const lines: string[] = [];

    await transport.execStream('printf "one\\ntwo\\nthree\\n"', (line) =>
      lines.push(line),
    );

    expect(lines).toEqual(expect.arrayContaining(['one', 'two', 'three']));
    transport.dispose();
  });

  it('reports a timeout instead of hanging forever', async () => {
    const { transport } = connected();

    await expect(transport.exec('sleep 5', 400)).rejects.toThrow('timed out');
    transport.dispose();
  });

  it('ends in-flight commands when the connection closes', async () => {
    const { transport } = connected();

    // No timeout: this models an agent-follow loop, which runs until the
    // session it watches ends. Disconnecting must end it — a remote host does
    // that by closing the channel; here nothing else would.
    const stream = transport.execStream('sleep 30', () => undefined, 0);
    await settle(300);
    await transport.disconnect(LOCAL_PROFILE.id);

    await expect(stream).resolves.toBeDefined();
  });

  it('writes a file, creating the directory it needs', async () => {
    const { transport } = connected();
    const target = path.join(
      mkdtempSync(path.join(tmpdir(), 'cozypad-local-')),
      'nested',
      'note.txt',
    );

    await transport.writeFile(target, new TextEncoder().encode('hello'));

    expect(readFileSync(target, 'utf8')).toBe('hello');
    transport.dispose();
  });

  it.runIf(windows)(
    'gives a command a real terminal, so a TUI can drive it',
    async () => {
      const { transport, output, closed } = connected();

      // `clear` only emits escape sequences when it believes it has a terminal,
      // which is exactly the property a remote pty provides and a plain pipe
      // does not.
      const terminalId = await transport.openTerminal(
        { profileId: LOCAL_PROFILE.id, cols: 100, rows: 30 },
        'clear; echo terminal-ready',
      );
      await settle(4000);

      const text = output.get(terminalId) ?? '';
      expect(text).toContain('terminal-ready');
      expect(text).toContain('[');
      expect(closed).toContain(terminalId);
      transport.dispose();
    },
    20_000,
  );

  it.runIf(windows)(
    'carries keystrokes into an interactive shell',
    async () => {
      const { transport, output } = connected();
      const terminalId = await transport.openTerminal({
        profileId: LOCAL_PROFILE.id,
        cols: 100,
        rows: 30,
      });
      await settle(2500);

      transport.writeTerminal(
        terminalId,
        new TextEncoder().encode('echo round-trip-ok\n'),
      );
      await settle(3000);

      expect(output.get(terminalId) ?? '').toContain('round-trip-ok');
      transport.dispose();
    },
    25_000,
  );
});
