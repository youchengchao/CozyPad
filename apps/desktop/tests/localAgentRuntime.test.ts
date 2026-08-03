import { describe, expect, it } from 'vitest';
import type { TerminalOpenRequest } from '@cozypad/contracts';
import { LocalAgentRuntime, type LocalPtyHost } from '../src/main/localAgentRuntime';

class FakePtyHost implements LocalPtyHost {
  readonly opened: { command?: string; request: TerminalOpenRequest }[] = [];
  readonly writes: { terminalId: string; text: string }[] = [];
  readonly closed: string[] = [];
  private next = 1;
  private live = new Set<string>();

  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string> {
    const terminalId = `local-term-${this.next++}`;
    this.opened.push({ request, ...(command === undefined ? {} : { command }) });
    this.live.add(terminalId);
    return Promise.resolve(terminalId);
  }
  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.writes.push({ terminalId, text: new TextDecoder().decode(data) });
  }
  closeTerminal(terminalId: string): void {
    this.closed.push(terminalId);
    this.live.delete(terminalId);
  }
  hasTerminal(terminalId: string): boolean {
    return this.live.has(terminalId);
  }
  /** Simulate the program exiting on its own. */
  end(terminalId: string): void {
    this.live.delete(terminalId);
  }
}

describe('local agent runtime', () => {
  it('starts a session as a plain process, with nothing to install', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);

    const session = await runtime.newSession({
      name: 'abc123',
      cwd: 'D:/work',
      argv: ['agy.exe', '--sandbox'],
    });

    // No tmux, no socket, no daemon — just the program in its own console.
    const command = host.opened[0]?.command ?? '';
    expect(command).not.toContain('tmux');
    expect(command).toContain("cd 'D:/work'");
    expect(command).toContain("exec 'agy.exe' '--sandbox'");
    expect(session.sessionId).toBe(session.paneId);
    expect(runtime.terminalFor(session.sessionId)).toBe('local-term-1');
  });

  it('names sessions the way the remote runtime does', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);

    await runtime.newSession({ name: 'my session', cwd: '.', argv: ['agy'] });
    const [listed] = await runtime.listSessions();

    expect(listed?.name).toBe('sdh_my_session');
  });

  it('refuses to start a second session under the same name', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    await runtime.newSession({ name: 'dup', cwd: '.', argv: ['agy'] });

    await expect(
      runtime.newSession({ name: 'dup', cwd: '.', argv: ['agy'] }),
    ).rejects.toThrow('already exists');
  });

  it('sends input, interrupt and escape to the running console', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    const { sessionId } = await runtime.newSession({
      name: 'keys',
      cwd: '.',
      argv: ['agy'],
    });

    await runtime.sendText(sessionId, 'hello');
    await runtime.sendText(sessionId, 'no-enter', false);
    await runtime.interrupt(sessionId);
    await runtime.escape(sessionId);

    expect(host.writes.map((write) => write.text)).toEqual([
      'hello\r',
      'no-enter',
      '\u0003',
      '\u001b',
    ]);
  });

  it('reports a session as gone once its program exits', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    const { sessionId } = await runtime.newSession({
      name: 'exits',
      cwd: '.',
      argv: ['agy'],
    });
    expect(await runtime.hasSession(sessionId)).toBe(true);

    host.end('local-term-1');

    expect(await runtime.hasSession(sessionId)).toBe(false);
    // A dead process must not linger in the list the UI reconciles against.
    expect(await runtime.listSessions()).toEqual([]);
  });

  it('lets a revival reuse the name of a session whose program exited', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    await runtime.newSession({ name: 'same', cwd: '.', argv: ['agy'] });
    host.end('local-term-1');

    const second = await runtime.newSession({ name: 'same', cwd: '.', argv: ['agy'] });

    expect(runtime.terminalFor(second.sessionId)).toBe('local-term-2');
  });

  it('kills a session by ending its process', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    const { sessionId } = await runtime.newSession({
      name: 'kill',
      cwd: '.',
      argv: ['agy'],
    });

    await runtime.killSession(sessionId);

    expect(host.closed).toEqual(['local-term-1']);
    expect(await runtime.hasSession(sessionId)).toBe(false);
    // Deleting something already gone is not an error.
    await expect(runtime.killSession(sessionId)).resolves.toBeUndefined();
  });

  it('restarts a session in the directory it was created in', async () => {
    const host = new FakePtyHost();
    const runtime = new LocalAgentRuntime(host);
    const { sessionId } = await runtime.newSession({
      name: 'respawn',
      cwd: '/srv/project',
      argv: ['agy'],
    });

    await runtime.respawnPane(sessionId, ['agy', '--sandbox']);

    expect(host.closed).toEqual(['local-term-1']);
    expect(host.opened[1]?.command).toContain("cd '/srv/project'");
    expect(host.opened[1]?.command).toContain("exec 'agy' '--sandbox'");
    expect(runtime.terminalFor(sessionId)).toBe('local-term-2');
  });
});
