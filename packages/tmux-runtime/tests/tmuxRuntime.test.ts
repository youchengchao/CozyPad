import { describe, expect, it } from 'vitest';
import type { RemoteAgentSessionRecord } from '@cozypad/contracts';
import {
  TmuxRuntime,
  normalizeSessionName,
  parseListPanes,
  parseListSessions,
  reconcileSessions,
} from '../src/index';

function fakeExec(outputs: string[]): {
  exec: (command: string) => Promise<string>;
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

describe('normalizeSessionName', () => {
  it('adds the sdh_ prefix and sanitizes', () => {
    expect(normalizeSessionName('claude run#1')).toBe('sdh_claude_run_1');
    expect(normalizeSessionName('sdh_ok-name')).toBe('sdh_ok-name');
  });
});

describe('parsers', () => {
  it('parses list-sessions with session ids', () => {
    const sessions = parseListSessions(
      '$0\tsdh_claude_a\t1753760000\t1\n$3\tsdh_codex_b\t1753761111\t0\n',
    );
    expect(sessions).toEqual([
      { sessionId: '$0', name: 'sdh_claude_a', createdEpoch: 1753760000, attached: true },
      { sessionId: '$3', name: 'sdh_codex_b', createdEpoch: 1753761111, attached: false },
    ]);
  });

  it('parses list-panes', () => {
    const panes = parseListPanes('%7\t41233\tclaude\t/home/y/projects/seg-train\n');
    expect(panes[0]).toEqual({
      paneId: '%7',
      pid: 41233,
      currentCommand: 'claude',
      currentPath: '/home/y/projects/seg-train',
    });
  });
});

describe('TmuxRuntime', () => {
  it('lists only sdh_ sessions', async () => {
    const { exec } = fakeExec(['$0\tsdh_claude_a\t1\t0\n$1\tuser_own\t2\t0\n']);
    const runtime = new TmuxRuntime(exec);
    const sessions = await runtime.listSessions();
    expect(sessions.map((session) => session.name)).toEqual(['sdh_claude_a']);
  });

  it('newSession returns the real session/pane ids', async () => {
    const { exec, commands } = fakeExec(['__TMUX__\t$5\t%9\t1753760042\n']);
    const runtime = new TmuxRuntime(exec);
    const created = await runtime.newSession({
      name: 'claude_s1',
      cwd: '~/projects',
      argv: ['claude', '--output-format', 'stream-json'],
    });
    expect(created).toEqual({ sessionId: '$5', paneId: '%9', createdEpoch: 1753760042 });
    expect(commands[0]).toContain("-P -F '__TMUX__\t#{session_id}\t#{pane_id}");
    expect(commands[0]).toContain('claude');
    expect(commands[0]).toContain('stream-json');
    expect(commands[0]).toContain('new-session -d -s "$session" -c "$cwd"');
  });

  it('newSession surfaces remote errors', async () => {
    const { exec } = fakeExec(['__ERROR__\tSession already exists: sdh_x\n']);
    const runtime = new TmuxRuntime(exec);
    await expect(
      runtime.newSession({ name: 'x', cwd: '~', argv: [] }),
    ).rejects.toThrow('already exists');
  });

  it('sendText uses literal mode and quotes the payload', async () => {
    const { exec, commands } = fakeExec(['__OK__\n']);
    const runtime = new TmuxRuntime(exec);
    await runtime.sendText('$5', "echo 'hi'; rm -rf /");
    const command = commands[0]!;
    expect(command).toContain('send-keys -t');
    expect(command).toContain('-l --');
    expect(command).toContain(`'echo '"'"'hi'"'"'; rm -rf /'`);
    expect(command).toContain('Enter');
  });

  it('capturePane clamps the line count', async () => {
    const { exec, commands } = fakeExec(['screen contents']);
    const runtime = new TmuxRuntime(exec);
    await runtime.capturePane('$5', 9999);
    expect(commands[0]).toContain('-S -500');
  });

  it('reads mouse mode from the running server', async () => {
    const { exec } = fakeExec(['__MOUSE__\ton\n']);
    await expect(new TmuxRuntime(exec).getMouseMode()).resolves.toBe(true);
  });

  it('reports mouse mode off when unset', async () => {
    const { exec } = fakeExec(['__MOUSE__\toff\n']);
    await expect(new TmuxRuntime(exec).getMouseMode()).resolves.toBe(false);
  });

  it('setMouseMode applies live and persists a managed block in ~/.tmux.conf', async () => {
    const { exec, commands } = fakeExec(['__OK__\ton\n']);
    await new TmuxRuntime(exec).setMouseMode(true);
    const command = commands[0]!;
    expect(command).toContain('mode=on');
    expect(command).toContain('# >>> cozypad managed >>>');
    expect(command).toContain('set-option -g mouse "$mode"');
    // 既有設定必須保留：只移除自己的區塊再重寫。
    expect(command).toContain('awk');
    expect(command).toContain('$HOME/.tmux.conf');
  });

  it('setMouseMode surfaces write failures', async () => {
    const { exec } = fakeExec(['__ERROR__\tcannot write /home/y/.tmux.conf\n']);
    await expect(new TmuxRuntime(exec).setMouseMode(false)).rejects.toThrow('cannot write');
  });

  it('uses a named socket when provided', async () => {
    const { exec, commands } = fakeExec(['no']);
    const runtime = new TmuxRuntime(exec, 'cozypad');
    await runtime.hasSession('$1');
    expect(commands[0]).toContain(`tmux -L 'cozypad' has-session`);
  });
});

function record(
  overrides: Partial<RemoteAgentSessionRecord> & { tmuxSessionId: string },
): RemoteAgentSessionRecord {
  const { tmuxSessionId, ...rest } = overrides;
  return {
    id: `local-${tmuxSessionId}`,
    identity: null,
    provisionalIdentity: {
      connectionProfileId: 'p1',
      tmuxSocket: 'default',
      tmuxSessionId,
      agentKind: 'claude',
      launchNonce: 'nonce',
    },
    projectId: 'proj',
    cwd: '~/projects',
    title: 'session',
    status: 'running',
    tmuxCreatedEpoch: 1000,
    createdAt: 't0',
    updatedAt: 't0',
    lastEventSequence: 0,
    ...rest,
  };
}

const live = (sessionId: string, createdEpoch = 1000, name = `sdh_${sessionId}`) => ({
  sessionId,
  name,
  createdEpoch,
  attached: false,
});

describe('reconcileSessions (SPEC_V3 §5.4 / Gate A)', () => {
  it('marks records without a live session as exited', () => {
    const result = reconcileSessions([record({ tmuxSessionId: '$1' })], [], 'now');
    expect(result.updated[0]?.status).toBe('exited');
  });

  it('keeps running sessions running and revives exited ones to ready', () => {
    const result = reconcileSessions(
      [
        record({ tmuxSessionId: '$1', status: 'running' }),
        record({ tmuxSessionId: '$2', status: 'disconnected' }),
      ],
      [live('$1'), live('$2')],
      'now',
    );
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.status).toBe('ready');
  });

  it('does not mistake a recycled $N for the old session', () => {
    const result = reconcileSessions(
      [record({ tmuxSessionId: '$1', tmuxCreatedEpoch: 1000 })],
      [live('$1', 2000)],
      'now',
    );
    expect(result.updated[0]?.status).toBe('exited');
    expect(result.orphanedLive.map((session) => session.sessionId)).toEqual(['$1']);
  });

  it('session rename does not change identity matching', () => {
    const result = reconcileSessions(
      [record({ tmuxSessionId: '$1', status: 'running' })],
      [live('$1', 1000, 'sdh_renamed_by_user')],
      'now',
    );
    expect(result.updated).toHaveLength(0);
    expect(result.orphanedLive).toHaveLength(0);
  });

  it('reports untracked live sdh_ sessions as orphaned', () => {
    const result = reconcileSessions([], [live('$9')], 'now');
    expect(result.orphanedLive.map((session) => session.sessionId)).toEqual(['$9']);
  });
});
