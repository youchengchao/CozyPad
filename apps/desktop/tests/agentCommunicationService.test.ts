import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TmuxSessionInfo } from '@cozypad/tmux-runtime';
import { AgentCommunicationService } from '../src/main/agentCommunicationService';
import { MemoryProfileStore } from '../src/main/profileStore';
import type { TransportPort } from '../src/main/transport/TransportPort';

class FakeTransport {
  readonly commands: string[] = [];
  readonly streamCommands: string[] = [];
  readonly writes: Array<{ path: string; data: Uint8Array }> = [];
  onStreamLine: ((line: string) => void) | null = null;
  attachmentDirectory = '/srv/deep-learning/.cozypad/session-tmp/session/attachments';
  executablePath = '/home/researcher/.toolchains/node/bin/claude';
  executableRealPath = '/home/researcher/.toolchains/node/lib/claude/cli.js';
  stderrLog = '';
  launchStatus = 'running';
  startupDiagnostics = '';
  readonly terminalWrites: Array<{ terminalId: string; data: Uint8Array }> = [];
  readonly terminalCommands: Array<{ request: unknown; command?: string }> = [];
  readonly closedTerminals: string[] = [];

  exec(command: string): Promise<string> {
    this.commands.push(command);
    if (command.includes('__COZYPAD_OS__')) {
      return Promise.resolve(
        [
          '__COZYPAD_OS__=Linux',
          '__COZYPAD_DISTRIBUTION__=Ubuntu 24.04 LTS',
          '__COZYPAD_KERNEL__=6.8.0-test',
          '__COZYPAD_ARCH__=x86_64',
          '__COZYPAD_LOGIN_SHELL__=/usr/bin/zsh',
          '__COZYPAD_LOGIN_PATH__=/home/researcher/.toolchains/node/bin:/usr/bin:/bin',
          '__COZYPAD_HOME__=/home/researcher',
          '__COZYPAD_COMMAND_SHELL__=/usr/bin/sh',
        ].join('\n'),
      );
    }
    if (command.includes('__COZYPAD_EXECUTABLE__')) {
      if (command.includes("command -v 'codex'")) {
        return Promise.resolve(
          [
            '__COZYPAD_EXECUTABLE__=/home/researcher/.local/bin/codex',
            '__COZYPAD_WHICH__=/home/researcher/.local/bin/codex',
            '__COZYPAD_REAL_PATH__=/home/researcher/.local/share/codex/codex',
            '__COZYPAD_VERSION__=codex-cli 1.2.3',
            '__COZYPAD_VERSION_STATUS__=0',
            '__COZYPAD_HELP_STATUS__=0',
            '__COZYPAD_HELP_OUTPUT_BEGIN__',
            'app-server --yolo --ask-for-approval',
            '__COZYPAD_HELP_OUTPUT_END__',
            '__COZYPAD_PROTOCOL_HELP_STATUS__=0',
            '__COZYPAD_PROTOCOL_HELP_OUTPUT_BEGIN__',
            '--listen stdio://',
            '__COZYPAD_PROTOCOL_HELP_OUTPUT_END__',
          ].join('\n'),
        );
      }
      if (command.includes("command -v 'agy'")) {
        return Promise.resolve(
          [
            '__COZYPAD_EXECUTABLE__=/home/researcher/.local/bin/agy',
            '__COZYPAD_WHICH__=/home/researcher/.local/bin/agy',
            '__COZYPAD_REAL_PATH__=/home/researcher/.local/bin/agy',
            '__COZYPAD_VERSION__=agy 1.1.9',
            '__COZYPAD_VERSION_STATUS__=0',
            '__COZYPAD_HELP_STATUS__=0',
            '--print --output-format text json stream-json',
            '--conversation --log-file --sandbox',
            '--dangerously-skip-permissions --disable-slash-commands',
          ].join('\n'),
        );
      }
      return Promise.resolve(
        [
          `__COZYPAD_EXECUTABLE__=${this.executablePath}`,
          `__COZYPAD_WHICH__=${this.executablePath}`,
          `__COZYPAD_REAL_PATH__=${this.executableRealPath}`,
          '__COZYPAD_VERSION__=2.1.132',
          '--output-format',
          '--input-format',
          '--resume',
          '--permission-prompt-tool',
          '--dangerously-skip-permissions',
        ].join('\n'),
      );
    }
    if (command.includes('__COZYPAD_ATTACHMENT_DIR__')) {
      return Promise.resolve(
        `__COZYPAD_ATTACHMENT_DIR__=${Buffer.from(this.attachmentDirectory).toString('base64')}`,
      );
    }
    if (command.includes('__COZYPAD_AGENT_STATUS__')) {
      return Promise.resolve(`__COZYPAD_AGENT_STATUS__=${this.launchStatus}`);
    }
    if (command.includes('__COZYPAD_STARTUP_DIAGNOSTICS__')) {
      return Promise.resolve(
        `__COZYPAD_STARTUP_DIAGNOSTICS__\n${this.startupDiagnostics}`,
      );
    }
    if (command.includes('stderr.log')) return Promise.resolve(this.stderrLog);
    return Promise.resolve('');
  }

  /** Settles the latest follow stream, the way the remote loop ending would. */
  endStream: (() => void) | null = null;

  execStream(command: string, onLine: (line: string) => void): Promise<string> {
    this.streamCommands.push(command);
    this.onStreamLine = onLine;
    return new Promise((resolve) => {
      this.endStream = () => resolve('');
    });
  }

  writeFile(remotePath: string, data: Uint8Array): Promise<void> {
    this.writes.push({ path: remotePath, data });
    return Promise.resolve();
  }

  openTerminal(request: unknown, command?: string): Promise<string> {
    this.terminalCommands.push(
      command === undefined ? { request } : { request, command },
    );
    return Promise.resolve('terminal-1');
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.terminalWrites.push({ terminalId, data });
  }

  closeTerminal(terminalId: string): void {
    this.closedTerminals.push(terminalId);
  }
}

class FakeTmux {
  readonly socketName = 'cozypad-test';
  readonly created: Array<{ name: string; cwd: string; argv: string[] }> = [];
  readonly sent: Array<{ target: string; text: string }> = [];
  readonly respawned: Array<{ target: string; argv: string[] }> = [];
  readonly interrupted: string[] = [];
  readonly escaped: string[] = [];
  readonly killed: string[] = [];
  alive = true;
  newSessionError: Error | null = null;
  /** Lets a test observe the service's state at the moment tmux is killed. */
  onKill: ((target: string) => void) | null = null;

  listSessions(): Promise<TmuxSessionInfo[]> {
    return Promise.resolve([]);
  }

  newSession(options: { name: string; cwd: string; argv: string[] }) {
    this.created.push(options);
    if (this.newSessionError !== null) {
      return Promise.reject(this.newSessionError);
    }
    // A session that was just created is alive, whatever happened before.
    this.alive = true;
    return Promise.resolve({
      sessionId: `$${7 + this.created.length - 1}`,
      paneId: `%${9 + this.created.length - 1}`,
      createdEpoch: 1234,
    });
  }

  sendText(target: string, text: string): Promise<void> {
    this.sent.push({ target, text });
    return Promise.resolve();
  }

  respawnPane(target: string, argv: string[]): Promise<void> {
    this.respawned.push({ target, argv });
    return Promise.resolve();
  }

  interrupt(target: string): Promise<void> {
    this.interrupted.push(target);
    return Promise.resolve();
  }

  escape(target: string): Promise<void> {
    this.escaped.push(target);
    return Promise.resolve();
  }

  killSession(target: string): Promise<void> {
    this.killed.push(target);
    this.alive = false;
    this.onKill?.(target);
    return Promise.resolve();
  }

  hasSession(): Promise<boolean> {
    return Promise.resolve(this.alive);
  }
}

describe('AgentCommunicationService', () => {
  let tempDirectory: string;
  let transport: FakeTransport;
  let tmux: FakeTmux;
  let service: AgentCommunicationService;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cozypad-agent-test-'));
    transport = new FakeTransport();
    tmux = new FakeTmux();
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    service = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: profiles,
      storePath: path.join(tempDirectory, 'sessions.json'),
      getHostFingerprint: () => 'SHA256:test',
    });
    await service.connected('profile-1');
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function createSession() {
    return service.create({
      profileId: 'profile-1',
      agentKind: 'claude',
      cwd: '/srv/deep-learning',
      title: 'Ablation study',
    });
  }

  it('starts Claude inside tmux in the requested cwd when the session is created', async () => {
    const bundle = await createSession();

    expect(bundle.session.status).toBe('ready');
    expect(bundle.session.cwd).toBe('/srv/deep-learning');
    expect(tmux.created).toHaveLength(1);
    expect(tmux.created[0]?.cwd).toBe('/srv/deep-learning');
    expect(tmux.created[0]?.argv.slice(0, 2)).toEqual(['/usr/bin/sh', '-lc']);
    expect(tmux.created[0]?.argv[2]).toContain(
      "'/home/researcher/.toolchains/node/bin/claude'",
    );
    expect(tmux.created[0]?.argv[2]).toContain(
      "PATH='/home/researcher/.toolchains/node/bin:/usr/bin:/bin'",
    );
    expect(tmux.created[0]?.argv[2]).toContain('--input-format');
    expect(tmux.created[0]?.argv[2]).toContain("'-p'");
    expect(tmux.created[0]?.argv[2]).toContain('--permission-prompt-tool');
    expect(tmux.created[0]?.argv[2]).toContain('raw-events.ndjson');
    expect(tmux.created[0]?.argv[2]).toContain('launch-status');

    const initialize = JSON.parse(tmux.sent[0]?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(tmux.sent[0]?.target).toBe('%9');
    expect(initialize.type).toBe('control_request');
    expect(initialize.request).toMatchObject({ subtype: 'initialize' });
  });

  it('deletes the tmux session, remote metadata, and persisted session record', async () => {
    const bundle = await createSession();
    const deleted: Array<{ sessionId: string; agentKind: string }> = [];
    service.setEvents({
      onSessionChanged: () => undefined,
      onSessionDeleted: (event) => deleted.push(event),
      onTimelineChanged: () => undefined,
      onError: () => undefined,
    });

    await service.delete({ sessionId: bundle.session.id });

    expect(tmux.killed).toEqual(['$7']);
    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(deleted).toEqual([
      { sessionId: bundle.session.id, agentKind: 'claude' },
    ]);
    const cleanup = transport.commands.at(-1) ?? '';
    expect(cleanup).toContain('session_root="$HOME/.cozypad/sessions"');
    expect(cleanup).toContain('attachment_root="$cwd_real/.cozypad/session-tmp"');
    expect(cleanup).toContain('rm -rf -- "$session_dir"');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'sessions.json'), 'utf8'),
    ) as { sessions: unknown[] };
    expect(persisted.sessions).toEqual([]);
  });

  it('forgets a session before killing tmux, so a late update cannot revive it', async () => {
    const bundle = await createSession();
    const changed: string[] = [];
    service.setEvents({
      onSessionChanged: (event) => changed.push(event.session.id),
      onSessionDeleted: () => undefined,
      onTimelineChanged: () => undefined,
      onError: () => undefined,
    });

    // Killing tmux ends the follow stream, whose handlers emit one last update.
    // They only stay quiet if the record is already gone by then.
    let listedDuringKill: string[] = [];
    tmux.onKill = () => {
      listedDuringKill = service
        .list({ profileId: 'profile-1' })
        .map((entry) => entry.session.id);
    };

    await service.delete({ sessionId: bundle.session.id });

    expect(listedDuringKill).toEqual([]);
    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(changed).not.toContain(bundle.session.id);
  });

  it('still removes a session locally when its host is disconnected', async () => {
    const bundle = await createSession();
    const deleted: Array<{ sessionId: string; agentKind: string }> = [];
    const errors: string[] = [];
    service.setEvents({
      onSessionChanged: () => undefined,
      onSessionDeleted: (event) => deleted.push(event),
      onTimelineChanged: () => undefined,
      onError: (event) => errors.push(event.message),
    });
    service.disconnected('profile-1');

    await service.delete({ sessionId: bundle.session.id });

    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(deleted).toEqual([
      { sessionId: bundle.session.id, agentKind: 'claude' },
    ]);
    expect(tmux.killed).toEqual([]);
    expect(errors.join('\n')).toContain('still on the host');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'sessions.json'), 'utf8'),
    ) as { sessions: unknown[] };
    expect(persisted.sessions).toEqual([]);
  });

  it('discovers Linux and the user installation without fixed install paths', async () => {
    const installation = await service.detect({
      profileId: 'profile-1',
      agentKind: 'claude',
    });

    expect(installation).toMatchObject({
      installed: true,
      installationScope: 'user',
      executablePath: '/home/researcher/.toolchains/node/bin/claude',
      environment: {
        osName: 'Linux',
        distribution: 'Ubuntu 24.04 LTS',
        kernelRelease: '6.8.0-test',
        architecture: 'x86_64',
        loginShell: '/usr/bin/zsh',
      },
    });
    const environmentProbe = transport.commands.find((command) =>
      command.includes('__COZYPAD_OS__'),
    );
    const capabilityProbe = transport.commands.find((command) =>
      command.includes('__COZYPAD_EXECUTABLE__'),
    );
    expect(environmentProbe).toContain('-l -i -c env');
    expect(environmentProbe).not.toContain('/home/researcher');
    expect(capabilityProbe).toContain("command -v 'claude'");
    expect(capabilityProbe).toContain("which 'claude'");
  });

  it('rejects an executable whose path is outside the remote user home', async () => {
    transport.executablePath = '/usr/local/bin/claude';
    transport.executableRealPath = '/usr/local/lib/claude/cli.js';

    const installation = await service.detect({
      profileId: 'profile-1',
      agentKind: 'claude',
    });

    expect(installation.installed).toBe(true);
    expect(installation.installationScope).toBe('system');
    expect(installation.supportsStructuredOutput).toBe(false);
    expect(installation.detail).toContain('requires a per-user installation');
  });

  it('launches the explicitly selected dangerous permission mode', async () => {
    await service.create({
      profileId: 'profile-1',
      agentKind: 'claude',
      cwd: '/srv/deep-learning',
      permissionMode: 'dangerouslySkip',
    });

    expect(tmux.created[0]?.argv[2]).toContain('--dangerously-skip-permissions');
    expect(tmux.created[0]?.argv[2]).not.toContain('--permission-prompt-tool');
  });

  it('starts Codex app-server and binds its returned thread before sending turns', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      launchMode: 'workspace-request',
    });

    expect(bundle.session.status).toBe('starting');
    expect(tmux.created[0]?.argv[2]).toContain(
      "'/home/researcher/.local/bin/codex' 'app-server' '--listen' 'stdio://'",
    );
    expect(tmux.sent.map((entry) => JSON.parse(entry.text))).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'initialized', params: {} },
      expect.objectContaining({
        method: 'thread/start',
        params: expect.objectContaining({
          cwd: '/srv/deep-learning',
          approvalPolicy: 'unlessTrusted',
          sandbox: 'workspaceWrite',
        }),
      }),
    ]);

    transport.onStreamLine?.(
      JSON.stringify({
        id: `thread_start_${bundle.session.id}`,
        result: { thread: { id: 'thr_remote_1', sessionId: 'thr_remote_1' } },
      }),
    );
    expect(service.list({ profileId: 'profile-1' })[0]?.session).toMatchObject({
      status: 'ready',
      slashCommands: ['compact', 'diff', 'review', 'status'],
    });

    await service.send({
      sessionId: bundle.session.id,
      text: 'Inspect the experiment',
      attachmentIds: [],
    });
    expect(JSON.parse(tmux.sent.at(-1)?.text ?? '{}')).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thr_remote_1',
        cwd: '/srv/deep-learning',
        input: [{ type: 'text', text: 'Inspect the experiment' }],
      },
    });

    transport.onStreamLine?.(
      JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn_remote_1', status: 'inProgress', items: [] } },
      }),
    );
    transport.onStreamLine?.(
      JSON.stringify({
        id: 41,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'python train.py', reason: 'Runs training' },
      }),
    );
    const approval = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.find((item) => item.kind === 'approval');
    expect(approval?.id).toBe('approval-41');
    await service.resolveApproval({
      sessionId: bundle.session.id,
      itemId: 'approval-41',
      resolution: 'allowed',
    });
    expect(JSON.parse(tmux.sent.at(-1)?.text ?? '{}')).toEqual({
      id: 41,
      result: { decision: 'accept' },
    });

    await service.interrupt({ sessionId: bundle.session.id });
    expect(JSON.parse(tmux.sent.at(-1)?.text ?? '{}')).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thr_remote_1', turnId: 'turn_remote_1' },
    });
  });

  it('runs AGY CLI as an interactive tmux TUI and attaches a real PTY', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'sandbox',
      interactionMode: 'chat',
    });

    expect(bundle.session).toMatchObject({
      agentKind: 'agy',
      interactionMode: 'terminal',
      status: 'ready',
    });
    const launch = tmux.created[0]?.argv[2] ?? '';
    expect(launch).toContain("'/home/researcher/.local/bin/agy' '--sandbox'");
    expect(launch).not.toContain('--print');
    expect(launch).not.toContain('--output-format');

    await expect(
      service.send({
        sessionId: bundle.session.id,
        text: 'This belongs in the TUI',
        attachmentIds: [],
      }),
    ).rejects.toThrow('send input in its terminal');

    await expect(
      service.openTerminal({ sessionId: bundle.session.id, cols: 100, rows: 32 }),
    ).resolves.toEqual({ terminalId: 'terminal-1' });
    expect(transport.terminalWrites).toHaveLength(0);
    expect(transport.terminalCommands.at(-1)).toEqual({
      request: { profileId: 'profile-1', cols: 100, rows: 32 },
      command:
        "tmux -L 'cozypad-test' -f /dev/null set-option -t '$7' status off >/dev/null 2>&1; " +
        "exec tmux -L 'cozypad-test' -f /dev/null attach-session -t '$7'",
    });

    await service.interrupt({ sessionId: bundle.session.id });
    expect(tmux.escaped).toEqual(['%9']);
    expect(tmux.interrupted).toEqual([]);
  });

  it('surfaces the real remote stderr when Claude exits during startup', async () => {
    transport.launchStatus = '2';
    transport.stderrLog = 'claude: unknown option --input-format';

    await expect(createSession()).rejects.toThrow(
      'Claude exited during startup with status 2\n\n' +
        'Remote stderr:\nclaude: unknown option --input-format',
    );
  });

  it('surfaces remote stderr when tmux reports that its server exited', async () => {
    tmux.newSessionError = new Error('server exited unexpectedly');
    transport.stderrLog =
      'Error: --input-format stream-json requires --print mode';

    await expect(createSession()).rejects.toThrow(
      'server exited unexpectedly\n\nRemote stderr:\n' +
        'Error: --input-format stream-json requires --print mode',
    );
  });

  it('surfaces tmux and workspace diagnostics when startup has no stderr', async () => {
    tmux.newSessionError = new Error('server exited unexpectedly');
    transport.startupDiagnostics = [
      'bridge: isolated-tmux-v2',
      'remote: Ubuntu 24.04 LTS / 6.8.0-test / x86_64',
      'user: researcher (uid 1000)',
      'tmux: /usr/bin/tmux; version: tmux 3.4; version exit: 0; socket: cozypad-test',
      'working directory: /srv/deep-learning (accessible)',
      'tmux temp base: /tmp (not-usable)',
    ].join('\n');

    await expect(createSession()).rejects.toThrow(
      'server exited unexpectedly\n\nRemote startup diagnostics:\n' +
        transport.startupDiagnostics,
    );
  });

  it('sends messages and approval decisions over the same tmux pane', async () => {
    const bundle = await createSession();
    await service.send({
      sessionId: bundle.session.id,
      text: 'Run the experiment',
      attachmentIds: [],
    });

    const userFrame = JSON.parse(tmux.sent.at(-1)?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(userFrame).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Run the experiment' },
      session_id: 'default',
    });

    transport.onStreamLine?.(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_permission_1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'python train.py' },
        },
      }),
    );
    const approval = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.find((item) => item.kind === 'approval');
    expect(approval?.id).toBe('approval-req_permission_1');

    await service.resolveApproval({
      sessionId: bundle.session.id,
      itemId: 'approval-req_permission_1',
      resolution: 'allowed',
    });
    const response = JSON.parse(tmux.sent.at(-1)?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(response).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_permission_1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'python train.py' },
        },
      },
    });
    expect(tmux.sent.every((entry) => entry.target === '%9')).toBe(true);
  });

  it('uploads attachments into the session workspace and references them by id', async () => {
    const bundle = await createSession();
    const attachment = await service.uploadAttachment({
      sessionId: bundle.session.id,
      name: '../diagram (final).png',
      mediaType: 'image/png',
      dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
    });

    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0]?.path).toMatch(
      /\/\.cozypad\/session-tmp\/session\/attachments\/[0-9a-f-]+-diagram-final\.png$/u,
    );
    expect([...transport.writes[0]!.data]).toEqual([1, 2, 3, 4]);

    await service.send({
      sessionId: bundle.session.id,
      text: 'Review this architecture',
      attachmentIds: [attachment.id],
    });
    const frame = JSON.parse(tmux.sent.at(-1)?.text ?? '{}') as {
      message?: { content?: string };
    };
    expect(frame.message?.content).toContain('Review this architecture');
    expect(frame.message?.content).toContain(attachment.remotePath);
    expect(frame.message?.content).toContain('use the Read tool');
  });

  it('revives an exited Claude session by resuming its bound conversation', async () => {
    const bundle = await createSession();
    // Bind the identity the way a live stream would, then let the agent die.
    transport.onStreamLine?.(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-abc',
        slash_commands: [],
      }),
    );
    transport.onStreamLine?.('__COZYPAD_AGENT_EXIT__');
    transport.endStream?.();
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('exited');

    const revived = await service.revive({ sessionId: bundle.session.id });

    expect(revived.session.status).toBe('ready');
    // The timeline survives the relaunch; the process does not.
    expect(revived.session.id).toBe(bundle.session.id);
    expect(tmux.created).toHaveLength(2);
    expect(tmux.created[1]?.cwd).toBe('/srv/deep-learning');
    expect(tmux.created[1]?.argv[2]).toContain("'--resume' 'conv-abc'");
    // The dead runtime session was cleared before relaunching under the same name.
    expect(tmux.killed).toContain('$7');
    expect(tmux.created[1]?.name).toBe(bundle.session.id);
  });

  it('revives an exited AGY session by continuing its latest conversation', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'sandbox',
      interactionMode: 'chat',
    });
    transport.onStreamLine?.('__COZYPAD_AGENT_EXIT__');
    transport.endStream?.();
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('exited');

    const revived = await service.revive({ sessionId: bundle.session.id });

    expect(revived.session.status).toBe('ready');
    // The CLI itself remembers the conversation; `--continue` reopens it.
    expect(tmux.created[1]?.argv[2]).toContain("'--continue'");
    expect(tmux.created[1]?.argv[2]).toContain("'--sandbox'");
  });

  it('restores a revived AGY session transcript from the local store only', async () => {
    const localService = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: new MemoryProfileStore([
        {
          id: 'local-machine',
          name: 'This computer',
          host: 'localhost',
          port: 22,
          username: 'me',
          authMethod: 'password',
          hasPassword: false,
          credentialPersisted: false,
        },
      ]),
      storePath: path.join(tempDirectory, 'local-agy-sessions.json'),
      getHostFingerprint: () => 'local',
      isLocalHost: () => true,
      readLocalAgyTranscript: () =>
        Promise.resolve([{ prompt: '出個謎題', assistantText: '好的……' }]),
    });
    await localService.connected('local-machine');
    const bundle = await localService.create({
      profileId: 'local-machine',
      agentKind: 'agy',
      cwd: 'D:/work',
    });

    // A fresh conversation must never present someone else's history.
    await expect(
      localService.readAgyTranscript({ sessionId: bundle.session.id }),
    ).resolves.toEqual({ turns: [] });

    transport.onStreamLine?.('__COZYPAD_AGENT_EXIT__');
    transport.endStream?.();
    await expect
      .poll(
        () => localService.list({ profileId: 'local-machine' })[0]?.session.status,
      )
      .toBe('exited');
    await localService.revive({ sessionId: bundle.session.id });

    await expect(
      localService.readAgyTranscript({ sessionId: bundle.session.id }),
    ).resolves.toEqual({
      turns: [{ prompt: '出個謎題', assistantText: '好的……' }],
    });
  });

  it('leaves a live session alone when asked to revive it', async () => {
    const bundle = await createSession();

    const result = await service.revive({ sessionId: bundle.session.id });

    expect(result.session.status).toBe('ready');
    expect(tmux.created).toHaveLength(1);
  });

  it('watches a remote session through tmux, whose session is what keeps it alive', async () => {
    await createSession();

    const follow = transport.streamCommands.at(-1) ?? '';
    expect(follow).toContain('has-session');
    expect(follow).toContain("tmux -L 'cozypad-test'");
  });

  it('watches a local session without tmux, which the local host does not have', async () => {
    const localService = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: new MemoryProfileStore([
        {
          id: 'local-machine',
          name: 'This computer',
          host: 'localhost',
          port: 22,
          username: 'me',
          authMethod: 'password',
          hasPassword: false,
          credentialPersisted: false,
        },
      ]),
      storePath: path.join(tempDirectory, 'local-sessions.json'),
      getHostFingerprint: () => 'local',
      isLocalHost: () => true,
    });
    await localService.connected('local-machine');

    const bundle = await localService.create({
      profileId: 'local-machine',
      agentKind: 'claude',
      cwd: 'D:/work',
      title: 'Local run',
    });

    expect(bundle.session.status).toBe('ready');
    const follow = transport.streamCommands.at(-1) ?? '';
    // Liveness comes from the launch wrapper's exit status and the session's
    // own storage — a tmux probe here would fail instantly and report the
    // freshly started agent as exited.
    expect(follow).not.toContain('tmux');
    expect(follow).toContain('launch-status');
    expect(follow).toContain('[ -f "$log" ]');
  });

  it('accepts the drive-style attachment directory the local Windows host reports', async () => {
    transport.attachmentDirectory =
      'D:/work/.cozypad/session-tmp/session/attachments';
    const bundle = await createSession();

    const attachment = await service.uploadAttachment({
      sessionId: bundle.session.id,
      name: 'trace.log',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('trace').toString('base64'),
    });

    expect(attachment.remotePath.startsWith('D:/work/')).toBe(true);
    expect(transport.writes[0]?.path).toBe(attachment.remotePath);
  });

  it('answers AskUserQuestion through its correlated control response', async () => {
    const bundle = await createSession();
    await service.send({
      sessionId: bundle.session.id,
      text: 'Prepare a split',
      attachmentIds: [],
    });
    transport.onStreamLine?.(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_question_1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Split',
                question: 'Which validation strategy?',
                options: [
                  { label: 'Fixed seed', description: 'Reproducible split' },
                  { label: 'K-fold', description: 'Cross validation' },
                ],
              },
            ],
          },
        },
      }),
    );

    await service.answerQuestion({
      sessionId: bundle.session.id,
      itemId: 'question-req_question_1:0',
      optionIndex: 1,
    });
    const response = JSON.parse(tmux.sent.at(-1)?.text ?? '{}') as Record<
      string,
      unknown
    >;
    expect(response).toMatchObject({
      type: 'control_response',
      response: {
        request_id: 'req_question_1',
        response: {
          behavior: 'allow',
          updatedInput: {
            answers: { 'Which validation strategy?': 'K-fold' },
          },
        },
      },
    });
  });
});
