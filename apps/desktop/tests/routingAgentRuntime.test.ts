import { describe, expect, it } from 'vitest';
import { LocalAgentRuntime, type LocalPtyHost } from '../src/main/localAgentRuntime';
import { RoutingAgentRuntime } from '../src/main/routingAgentRuntime';

class FakeHost implements LocalPtyHost {
  private next = 1;
  private live = new Set<string>();
  openTerminal(): Promise<string> {
    const id = `local-term-${this.next++}`;
    this.live.add(id);
    return Promise.resolve(id);
  }
  writeTerminal(): void {}
  closeTerminal(id: string): void {
    this.live.delete(id);
  }
  hasTerminal(id: string): boolean {
    return this.live.has(id);
  }
}

class FakeTmux {
  readonly socketName = 'cozypad';
  readonly calls: string[] = [];
  listSessions(): Promise<never[]> {
    this.calls.push('listSessions');
    return Promise.resolve([]);
  }
  newSession(): Promise<{ sessionId: string; paneId: string; createdEpoch: number }> {
    this.calls.push('newSession');
    return Promise.resolve({ sessionId: '$7', paneId: '%9', createdEpoch: 0 });
  }
  respawnPane(target: string): Promise<void> {
    this.calls.push(`respawn:${target}`);
    return Promise.resolve();
  }
  sendText(target: string, text: string): Promise<void> {
    this.calls.push(`send:${target}:${text}`);
    return Promise.resolve();
  }
  interrupt(target: string): Promise<void> {
    this.calls.push(`interrupt:${target}`);
    return Promise.resolve();
  }
  escape(target: string): Promise<void> {
    this.calls.push(`escape:${target}`);
    return Promise.resolve();
  }
  hasSession(target: string): Promise<boolean> {
    this.calls.push(`has:${target}`);
    return Promise.resolve(true);
  }
  killSession(target: string): Promise<void> {
    this.calls.push(`kill:${target}`);
    return Promise.resolve();
  }
}

function runtime(): { routing: RoutingAgentRuntime; tmux: FakeTmux; host: FakeHost } {
  const tmux = new FakeTmux();
  const host = new FakeHost();
  return {
    routing: new RoutingAgentRuntime(tmux, new LocalAgentRuntime(host)),
    tmux,
    host,
  };
}

describe('agent runtime routing', () => {
  it('starts a local session without touching tmux', async () => {
    const { routing, tmux } = runtime();
    routing.useLocal(true);

    const session = await routing.newSession({
      name: 'chat',
      cwd: '.',
      argv: ['agy'],
    });

    // The whole point: talking locally must not require tmux to exist.
    expect(tmux.calls).toEqual([]);
    expect(session.sessionId).toMatch(/^\$local-/u);
    expect(routing.socketName).toBe('local');
  });

  it('gives a local session the console it is already running in', async () => {
    const { routing } = runtime();
    routing.useLocal(true);
    const session = await routing.newSession({ name: 'c', cwd: '.', argv: ['agy'] });

    // Remote sessions attach to a pane; a local one has no second console to
    // open, and starting one would launch a second agent.
    expect(routing.terminalFor(session.sessionId)).toBe('local-term-1');
    expect(routing.terminalFor('$7')).toBeUndefined();
  });

  it('routes each session by the host recorded in its id', async () => {
    const { routing, tmux } = runtime();
    routing.useLocal(true);
    const local = await routing.newSession({ name: 'c', cwd: '.', argv: ['agy'] });

    // Switching host must not misdirect calls about sessions already running.
    routing.useLocal(false);
    await routing.interrupt(local.sessionId);
    await routing.interrupt('$7');

    expect(tmux.calls).toEqual(['interrupt:$7']);
    expect(await routing.hasSession(local.sessionId)).toBe(true);
  });

  it('creates remote sessions through tmux once a remote host is in use', async () => {
    const { routing, tmux } = runtime();
    routing.useLocal(false);

    await routing.newSession({ name: 'c', cwd: '.', argv: ['agy'] });

    expect(tmux.calls).toEqual(['newSession']);
    expect(routing.socketName).toBe('cozypad');
  });
});
