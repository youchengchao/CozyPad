import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TmuxSessionInfo } from '@cozypad/tmux-runtime';
import {
  AgentCommunicationService,
  STORE_VERSION,
  buildAttachmentUnpackScript,
  createAttachmentArchive,
} from '../src/main/agentCommunicationService';
import { MemoryProfileStore } from '../src/main/profileStore';
import type { TransportPort } from '../src/main/transport/TransportPort';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK9sAAAAASUVORK5CYII=',
  'base64',
);

class FakeTransport {
  readonly commands: string[] = [];
  readonly streamCommands: string[] = [];
  readonly writes: Array<{ path: string; data: Uint8Array }> = [];
  onStreamLine: ((line: string) => void) | null = null;
  readonly streams: Array<{
    onLine(line: string): void;
    end(): void;
  }> = [];
  attachmentDirectory = '/srv/deep-learning/.cozypad/session-tmp/session/attachments';
  attachmentBatchOutput = '__COZYPAD_ATTACHMENT_BATCH__=ok';
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
    if (command.includes('__COZYPAD_ATTACHMENT_BATCH__')) {
      return Promise.resolve(this.attachmentBatchOutput);
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
      const stream = {
        onLine,
        end: () => resolve(''),
      };
      this.streams.push(stream);
      this.endStream = stream.end;
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

function readTarEntries(data: Uint8Array): Map<string, Buffer> {
  const archive = Buffer.from(data);
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.byteLength; ) {
    const name = archive.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/u, '');
    if (name === '') break;
    const sizeText = archive
      .subarray(offset + 124, offset + 136)
      .toString('ascii')
      .replace(/\0.*$/u, '')
      .trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const contentStart = offset + 512;
    entries.set(name, archive.subarray(contentStart, contentStart + size));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
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
  sendTextError: Error | null = null;
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
    if (this.sendTextError !== null) return Promise.reject(this.sendTextError);
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
    // A fire-and-forget persist can still be writing the store when the test
    // ends; on Windows that makes the first rmdir EBUSY. Retry briefly.
    await fs.rm(tempDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
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

    // SPEC 219-221/1481: an agent that publishes a Conversation ID stays
    // Starting until the id arrives; only system/init flips it to ready.
    expect(bundle.session.status).toBe('starting');
    transport.onStreamLine?.(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-init-1',
        slash_commands: [],
      }),
    );
    expect(service.list({ profileId: 'profile-1' })[0]?.session.status).toBe(
      'ready',
    );
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

    const result = await service.delete({ sessionId: bundle.session.id });

    expect(tmux.killed).toEqual(['$7']);
    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(deleted).toEqual([
      { sessionId: bundle.session.id, agentKind: 'claude' },
    ]);
    // SPEC 1509-1511: each scope reports its own outcome.
    expect(result.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'localIndex', outcome: 'done' }),
        expect.objectContaining({ scope: 'process', outcome: 'done' }),
        expect.objectContaining({ scope: 'remoteEvents', outcome: 'done' }),
        expect.objectContaining({ scope: 'remoteAttachments', outcome: 'done' }),
        expect.objectContaining({
          scope: 'nativeConversation',
          outcome: 'unsupported',
        }),
      ]),
    );
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

    const result = await service.delete({ sessionId: bundle.session.id });

    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(deleted).toEqual([
      { sessionId: bundle.session.id, agentKind: 'claude' },
    ]);
    expect(tmux.killed).toEqual([]);
    // SPEC 1512-1513: remote scopes are not attempted while disconnected —
    // the result reports them unfinished with the residual paths, and no
    // red error banner fires for a deletion that worked locally.
    expect(errors).toEqual([]);
    expect(
      result.scopes
        .filter((scope) => scope.outcome === 'skipped')
        .map((scope) => scope.scope)
        .sort(),
    ).toEqual(['process', 'remoteAttachments', 'remoteEvents']);
    expect(
      result.scopes.find((scope) => scope.scope === 'remoteEvents')
        ?.residualPath,
    ).toContain('.cozypad/sessions/');
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
          approvalPolicy: 'untrusted',
          sandbox: 'workspace-write',
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

  it('uploads one archive per attachment batch and references every file by id', async () => {
    const bundle = await createSession();
    const [image, notes] = await service.uploadAttachments({
      sessionId: bundle.session.id,
      attachments: [
        {
          name: '../diagram (final).png',
          mediaType: 'image/png',
          dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        },
        {
          name: 'notes.txt',
          mediaType: 'text/plain',
          dataBase64: Buffer.from('read me').toString('base64'),
        },
      ],
    });

    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0]?.path).toMatch(
      /\/\.cozypad\/session-tmp\/session\/attachments\/\.cozypad-attachment-batch-[0-9a-f-]+\.tar$/u,
    );
    const archived = readTarEntries(transport.writes[0]!.data);
    expect(archived.get(image!.remotePath.split('/').at(-1)!)).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(archived.get(notes!.remotePath.split('/').at(-1)!)).toEqual(
      Buffer.from('read me'),
    );
    expect(
      transport.commands.some(
        (command) => command.includes('tar -xf') && command.includes('__COZYPAD_ATTACHMENT_BATCH__'),
      ),
    ).toBe(true);

    await service.send({
      sessionId: bundle.session.id,
      text: 'Review this architecture',
      attachmentIds: [image!.id, notes!.id],
    });
    const frame = JSON.parse(tmux.sent.at(-1)?.text ?? '{}') as {
      message?: { content?: string };
    };
    expect(frame.message?.content).toContain('Review this architecture');
    expect(frame.message?.content).toContain(`@${image!.remotePath}`);
    expect(frame.message?.content).toContain(`@${notes!.remotePath}`);
    const userMessage = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.find((item) => item.kind === 'message' && item.role === 'user');
    expect(userMessage).toMatchObject({
      text: 'Review this architecture',
      attachments: [
        expect.objectContaining({
          id: image!.id,
          name: image!.name,
          mediaType: 'image/png',
          remotePath: image!.remotePath,
        }),
        expect.objectContaining({
          id: notes!.id,
          name: notes!.name,
          mediaType: 'text/plain',
          remotePath: notes!.remotePath,
        }),
      ],
    });

    const reopened = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: new MemoryProfileStore([
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
      ]),
      storePath: path.join(tempDirectory, 'sessions.json'),
      getHostFingerprint: () => 'SHA256:test-host',
    });
    await reopened.load();
    await reopened.connected('profile-1');
    const restoredUserMessage = reopened
      .list({ profileId: 'profile-1' })[0]
      ?.items.find((item) => item.kind === 'message' && item.role === 'user');
    expect(restoredUserMessage).toMatchObject({
      text: 'Review this architecture',
      attachments: [
        expect.objectContaining({ id: image!.id, remotePath: image!.remotePath }),
        expect.objectContaining({ id: notes!.id, remotePath: notes!.remotePath }),
      ],
    });
  });

  it('keeps a live session ready and its uploaded attachment retryable when turn delivery fails', async () => {
    const bundle = await createSession();
    const [screenshot] = await service.uploadAttachments({
      sessionId: bundle.session.id,
      attachments: [
        {
          name: 'retry-screenshot.png',
          mediaType: 'image/png',
          dataBase64: ONE_PIXEL_PNG.toString('base64'),
        },
      ],
    });
    tmux.sendTextError = new Error('tmux pane temporarily rejected input');

    await expect(
      service.send({
        sessionId: bundle.session.id,
        text: 'Inspect this',
        attachmentIds: [screenshot!.id],
      }),
    ).rejects.toThrow('temporarily rejected input');

    const failed = service.list({ profileId: 'profile-1' })[0]!;
    expect(failed.session.status).toBe('ready');
    expect(
      failed.items.some(
        (item) => item.kind === 'message' && item.role === 'user' && item.text === 'Inspect this',
      ),
    ).toBe(false);
    expect(failed.items.at(-1)).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: expect.stringContaining('temporarily rejected input'),
    });

    tmux.sendTextError = null;
    await expect(
      service.send({
        sessionId: bundle.session.id,
        text: 'Inspect this',
        attachmentIds: [screenshot!.id],
      }),
    ).resolves.toBeUndefined();
    const retried = service.list({ profileId: 'profile-1' })[0]!;
    expect(retried.session.status).toBe('running');
    expect(retried.items.at(-1)).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'Inspect this',
      attachments: [expect.objectContaining({ id: screenshot!.id })],
    });
  });

  it('builds an attachment batch that a real tar implementation can unpack', async () => {
    const available = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    if (available.status !== 0) return;
    const bundle = await createSession();
    const screenshot = ONE_PIXEL_PNG;

    const [attachment] = await service.uploadAttachments({
      sessionId: bundle.session.id,
      attachments: [
        {
          name: 'pasted screenshot.png',
          mediaType: 'image/png',
          dataBase64: screenshot.toString('base64'),
        },
      ],
    });

    const archive = Buffer.from(transport.writes[0]!.data);
    const listed = spawnSync('tar', ['-tf', '-'], { input: archive, encoding: 'utf8' });
    expect(listed.stderr).toBe('');
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe(attachment!.remotePath.split('/').at(-1));

    const extracted = spawnSync(
      'tar',
      ['-xOf', '-', attachment!.remotePath.split('/').at(-1)!],
      { input: archive },
    );
    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toEqual(screenshot);
  });

  it.runIf(process.platform === 'win32')(
    'unpacks a screenshot archive through the same Git Bash drive-path flow as the app',
    async () => {
      const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
      if (available.status !== 0) return;
      const attachmentDirectory = path
        .join(tempDirectory, 'attachments')
        .replace(/\\/gu, '/');
      const archivePath = `${attachmentDirectory}/batch.tar`;
      const storageName = 'screenshot.png';
      const landedPath = `${attachmentDirectory}/${storageName}`;
      const screenshot = ONE_PIXEL_PNG;
      await fs.mkdir(attachmentDirectory, { recursive: true });
      await fs.writeFile(
        archivePath,
        createAttachmentArchive([{ name: storageName, data: screenshot }]),
      );

      const unpacked = spawnSync(
        bash,
        [
          '-lc',
          buildAttachmentUnpackScript(
            attachmentDirectory,
            archivePath,
            [landedPath],
          ),
        ],
        { encoding: 'utf8' },
      );

      expect(unpacked.stderr).toBe('');
      expect(unpacked.status).toBe(0);
      expect(unpacked.stdout).toContain('__COZYPAD_ATTACHMENT_BATCH__=ok');
      await expect(fs.readFile(landedPath)).resolves.toEqual(screenshot);
      await expect(fs.stat(archivePath)).rejects.toThrow();
    },
  );

  it('cleans a partial batch and records no attachments when unpacking fails', async () => {
    const bundle = await createSession();
    transport.attachmentBatchOutput = '__ERROR__\tUnable to unpack the attachment batch';

    await expect(
      service.uploadAttachments({
        sessionId: bundle.session.id,
        attachments: [
          {
            name: 'broken.png',
            mediaType: 'image/png',
            dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow('Unable to unpack the attachment batch');

    expect(transport.writes).toHaveLength(1);
    expect(transport.commands.at(-1)).toContain('rm -f --');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'sessions.json'), 'utf8'),
    ) as { sessions: Array<{ attachments: Record<string, unknown> }> };
    expect(persisted.sessions[0]?.attachments).toEqual({});
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

    // The relaunched process must re-announce its conversation id before the
    // session may claim ready (SPEC 219-221).
    expect(revived.session.status).toBe('starting');
    transport.onStreamLine?.(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-abc',
        slash_commands: [],
      }),
    );
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('ready');
    // The timeline survives the relaunch; the process does not.
    expect(revived.session.id).toBe(bundle.session.id);
    expect(tmux.created).toHaveLength(2);
    expect(tmux.created[1]?.cwd).toBe('/srv/deep-learning');
    expect(tmux.created[1]?.argv[2]).toContain("'--resume' 'conv-abc'");
    // The dead runtime session was cleared before relaunching under the same name.
    expect(tmux.killed).toContain('$7');
    expect(tmux.created[1]?.name).toBe(bundle.session.id);
  });

  it('enters an errored session without restarting when its runtime is still alive', async () => {
    const bundle = await createSession();
    const internal = service as unknown as {
      sessions: Map<
        string,
        { record: { status: 'error' | 'ready' } }
      >;
    };
    internal.sessions.get(bundle.session.id)!.record.status = 'error';

    const resumed = await service.revive({ sessionId: bundle.session.id });

    expect(resumed.session.status).toBe('ready');
    expect(tmux.created).toHaveLength(1);
    expect(tmux.killed).toHaveLength(0);
    expect(transport.streams).toHaveLength(1);
  });

  it('revives a disconnected AGY session after its local runtime was lost', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      interactionMode: 'terminal',
    });
    const internal = service as unknown as {
      sessions: Map<
        string,
        { record: { status: 'disconnected' | 'ready' } }
      >;
    };
    internal.sessions.get(bundle.session.id)!.record.status = 'disconnected';
    tmux.alive = false;

    const resumed = await service.revive({ sessionId: bundle.session.id });

    expect(resumed.session.status).toBe('ready');
    expect(tmux.created).toHaveLength(2);
    expect(tmux.killed).toContain('$7');
    expect(tmux.created[1]?.argv[2]).toContain("'--continue'");
  });

  it('ignores a late exit from the old follower after replacing an errored runtime', async () => {
    const bundle = await createSession();
    const oldStream = transport.streams[0]!;
    const internal = service as unknown as {
      sessions: Map<
        string,
        { record: { status: 'error' | 'ready' } }
      >;
    };
    internal.sessions.get(bundle.session.id)!.record.status = 'error';
    tmux.alive = false;

    const resumed = await service.revive({ sessionId: bundle.session.id });

    // Claude re-announces its id before the relaunch may claim ready.
    expect(resumed.session.status).toBe('starting');
    expect(tmux.created).toHaveLength(2);
    expect(transport.streams).toHaveLength(2);
    transport.streams[1]!.onLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-late-1',
        slash_commands: [],
      }),
    );
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('ready');

    oldStream.onLine('__COZYPAD_AGENT_EXIT__');
    oldStream.end();
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('ready');
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

  it('safely binds and restores an AGY session transcript from the local store', async () => {
    let transcriptConversationId: string | undefined;
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
      getLatestLocalAgyConversationId: () => Promise.resolve('agy-conv-123'),
      readLocalAgyTranscript: (conversationId) => {
        transcriptConversationId = conversationId;
        return Promise.resolve([{ prompt: '出個謎題', assistantText: '好的……' }]);
      },
    });
    await localService.connected('local-machine');
    const bundle = await localService.create({
      profileId: 'local-machine',
      agentKind: 'agy',
      cwd: 'D:/work',
    });

    // A fresh conversation must never present history without proof that the
    // native conversation belongs to this CozyPad turn.
    await expect(
      localService.readAgyTranscript({ sessionId: bundle.session.id }),
    ).resolves.toEqual({ turns: [] });
    await expect(
      localService.readAgyTranscript({
        sessionId: bundle.session.id,
        expectedPrompt: 'not this conversation',
      }),
    ).resolves.toEqual({ turns: [] });
    const beforeMatch = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'local-agy-sessions.json'), 'utf8'),
    ) as { sessions: Array<{ record: { identity: unknown } }> };
    expect(beforeMatch.sessions[0]?.record.identity).toBeNull();

    await expect(
      localService.readAgyTranscript({
        sessionId: bundle.session.id,
        expectedPrompt: '出個謎題',
      }),
    ).resolves.toEqual({
      turns: [{ prompt: '出個謎題', assistantText: '好的……' }],
    });

    transport.onStreamLine?.('__COZYPAD_AGENT_EXIT__');
    transport.endStream?.();
    await expect
      .poll(
        () => localService.list({ profileId: 'local-machine' })[0]?.session.status,
      )
      .toBe('exited');
    await localService.revive({ sessionId: bundle.session.id });

    expect(tmux.created[1]?.argv[2]).toContain(
      "'--conversation' 'agy-conv-123'",
    );
    expect(tmux.created[1]?.argv[2]).not.toContain("'--continue'");

    await expect(
      localService.readAgyTranscript({ sessionId: bundle.session.id }),
    ).resolves.toEqual({
      turns: [{ prompt: '出個謎題', assistantText: '好的……' }],
    });
    expect(transcriptConversationId).toBe('agy-conv-123');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'local-agy-sessions.json'), 'utf8'),
    ) as {
      sessions: Array<{
        record: { identity: { agentConversationId: string } | null };
      }>;
    };
    expect(persisted.sessions[0]?.record.identity?.agentConversationId).toBe(
      'agy-conv-123',
    );
  });

  it('leaves a live session alone when asked to revive it', async () => {
    const bundle = await createSession();
    transport.onStreamLine?.(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'conv-live-1',
        slash_commands: [],
      }),
    );

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

    // Still starting: Claude has not announced its conversation id yet
    // (SPEC 219-221); this test is about the follow command, not the id.
    expect(bundle.session.status).toBe('starting');
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

    const [attachment] = await service.uploadAttachments({
      sessionId: bundle.session.id,
      attachments: [
        {
          name: 'trace.log',
          mediaType: 'text/plain',
          dataBase64: Buffer.from('trace').toString('base64'),
        },
      ],
    });

    expect(attachment!.remotePath.startsWith('D:/work/')).toBe(true);
    expect(transport.writes[0]?.path).toMatch(/^D:\/work\/.*\.tar$/u);
    const unpackCommand = transport.commands.find((command) =>
      command.includes('__COZYPAD_ATTACHMENT_BATCH__'),
    );
    expect(unpackCommand).toContain('command -v cygpath');
    expect(unpackCommand).toContain('archive_for_tar="$(cygpath -u "$archive")"');
    expect(unpackCommand).toContain(
      'attachment_dir_for_tar="$(cygpath -u "$attachment_dir")"',
    );
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

  it('answers a Codex permissions approval with a granted profile, not a decision', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      launchMode: 'workspace-request',
    });
    transport.onStreamLine?.(
      JSON.stringify({
        id: `thread_start_${bundle.session.id}`,
        result: { thread: { id: 'thr_perm_1', sessionId: 'thr_perm_1' } },
      }),
    );
    transport.onStreamLine?.(
      JSON.stringify({
        id: 88,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_perm_1',
          turnId: 'turn_1',
          itemId: 'perm_1',
          cwd: '/srv/deep-learning',
          reason: 'Needs network access',
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      }),
    );

    // The request must surface as an operable card — registering it as a
    // pending control with no card left the turn waiting forever.
    const approval = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.find((item) => item.kind === 'approval');
    expect(approval?.id).toBe('approval-88');
    expect(service.list({ profileId: 'profile-1' })[0]?.session.status).toBe(
      'waiting_approval',
    );

    await service.resolveApproval({
      sessionId: bundle.session.id,
      itemId: 'approval-88',
      resolution: 'allowed',
    });
    // PermissionsRequestApprovalResponse (generate-ts v2): a granted profile
    // plus scope — {decision} would be schema-invalid for this method.
    expect(JSON.parse(tmux.sent.at(-1)?.text ?? '{}')).toEqual({
      id: 88,
      result: { permissions: { network: { enabled: true } }, scope: 'turn' },
    });
  });

  it('holds a mixed question batch until every question in the request has a card', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      launchMode: 'workspace-request',
    });
    transport.onStreamLine?.(
      JSON.stringify({
        id: `thread_start_${bundle.session.id}`,
        result: { thread: { id: 'thr_mixed_1', sessionId: 'thr_mixed_1' } },
      }),
    );
    transport.onStreamLine?.(
      JSON.stringify({
        id: 'input-1',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'q-seed',
              header: 'Seed',
              question: 'Which seed?',
              options: [
                { label: '42', description: 'Baseline' },
                { label: '123', description: 'Ablation' },
              ],
            },
            // Free-form question: no options, not yet representable as a card.
            { id: 'q-notes', header: 'Notes', question: 'Anything else?', options: null, isOther: true },
          ],
        },
      }),
    );
    // Both questions surface: the free-form one as an unrepresentable card
    // with the raw content and a decline path (SPEC 3.4.6), not a silent drop.
    const questionItems = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.filter(
        (item): item is Extract<(typeof item), { kind: 'question' }> =>
          item.kind === 'question',
      );
    expect(questionItems).toHaveLength(2);
    expect(questionItems?.[1]).toMatchObject({
      id: 'question-input-1:1',
      unrepresentable: true,
      batchId: 'input-1',
      options: [],
    });

    const framesBefore = tmux.sent.length;
    await service.answerQuestion({
      sessionId: bundle.session.id,
      itemId: 'question-input-1:0',
      optionIndex: 0,
    });

    // One question of the request cannot be answered by a card; replying now
    // would hand Codex a partial answer set as if it were final.
    expect(tmux.sent.length).toBe(framesBefore);
    expect(service.list({ profileId: 'profile-1' })[0]?.session.status).toBe(
      'waiting_approval',
    );

    // Declining answers the whole request: Codex gets a JSON-RPC error and
    // every sibling card of the batch closes with it.
    await service.declineQuestion({
      sessionId: bundle.session.id,
      itemId: 'question-input-1:1',
    });
    expect(JSON.parse(tmux.sent.at(-1)?.text ?? '{}')).toEqual({
      id: 'input-1',
      error: { code: -32800, message: 'Declined by the CozyPad user' },
    });
    const closed = service
      .list({ profileId: 'profile-1' })[0]
      ?.items.filter(
        (item): item is Extract<(typeof item), { kind: 'question' }> =>
          item.kind === 'question',
      );
    expect(closed?.[1]?.declined).toBe(true);
    expect(service.list({ profileId: 'profile-1' })[0]?.session.status).toBe(
      'running',
    );
  });

  it('marks the boundary when Codex rebinds to a new native conversation', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      launchMode: 'workspace-request',
    });
    transport.onStreamLine?.(
      JSON.stringify({
        id: `thread_start_${bundle.session.id}`,
        result: { thread: { id: 'thr_first', sessionId: 'thr_first' } },
      }),
    );
    // A different thread id later means the old native conversation is gone;
    // the timeline must say so instead of impersonating agent memory
    // (SPEC 275-278).
    transport.onStreamLine?.(
      JSON.stringify({
        method: 'thread/started',
        params: { thread: { id: 'thr_second' } },
      }),
    );

    const listed = service.list({ profileId: 'profile-1' })[0];
    const notice = listed?.items.find((item) => item.kind === 'notice');
    expect(notice?.kind === 'notice' && notice.text).toContain('新的原生對話');
    expect(listed?.session.conversationBound).toBe(true);
    expect(listed?.session.resumeContinuity).toBe('new');
    // SPEC 1445: the menu can tell CozyPad-completed commands from agent ones.
    expect(listed?.session.slashCommandOwners).toEqual({
      compact: 'agent',
      diff: 'cozypad',
      review: 'agent',
      status: 'cozypad',
    });
  });

  it('expires pending approvals and questions when the agent process exits', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      launchMode: 'workspace-request',
    });
    transport.onStreamLine?.(
      JSON.stringify({
        id: `thread_start_${bundle.session.id}`,
        result: { thread: { id: 'thr_exp_1', sessionId: 'thr_exp_1' } },
      }),
    );
    await service.send({
      sessionId: bundle.session.id,
      text: 'Clean the build tree',
      attachmentIds: [],
    });
    transport.onStreamLine?.(
      JSON.stringify({
        method: 'item/started',
        params: { item: { type: 'agentMessage', id: 'msg-exp-1', text: '' } },
      }),
    );
    transport.onStreamLine?.(
      JSON.stringify({
        method: 'item/started',
        params: {
          item: { type: 'commandExecution', id: 'cmd-exp-1', command: 'rm -rf build', cwd: '/srv' },
        },
      }),
    );
    transport.onStreamLine?.(
      JSON.stringify({
        id: 91,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'rm -rf build', reason: 'Cleans the tree' },
      }),
    );
    transport.onStreamLine?.('__COZYPAD_AGENT_EXIT__');
    transport.endStream?.();
    await expect
      .poll(() => service.list({ profileId: 'profile-1' })[0]?.session.status)
      .toBe('exited');

    // SPEC 3.4.12: the asking generation is gone — the card keeps its content
    // but is Expired, not a pending card whose buttons can only throw.
    const items = service.list({ profileId: 'profile-1' })[0]?.items ?? [];
    const approval = items.find((item) => item.kind === 'approval');
    expect(approval?.kind === 'approval' && approval.resolution).toBe('expired');
    // SPEC 1321-1325: nothing may still look like it is running after exit.
    const assistant = items.find(
      (item) => item.kind === 'message' && item.role === 'assistant',
    );
    expect(
      assistant?.kind === 'message' &&
        assistant.streaming !== true &&
        assistant.interrupted === true,
    ).toBe(true);
    const tool = items.find((item) => item.kind === 'tool_call');
    expect(tool?.kind === 'tool_call' && tool.status).toBe('unknown');
    await expect(
      service.resolveApproval({
        sessionId: bundle.session.id,
        itemId: 'approval-91',
        resolution: 'allowed',
      }),
    ).rejects.toThrow();
  });
});

describe('an unreadable session store degrades the agent page, not the app', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cozypad-store-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  function serviceFor(
    storePath: string,
    recovered: { reason: string; backupPath: string | null }[],
  ): AgentCommunicationService {
    return new AgentCommunicationService({
      transport: new FakeTransport() as unknown as TransportPort,
      tmux: new FakeTmux(),
      profileStore: new MemoryProfileStore([]),
      storePath,
      getHostFingerprint: () => 'SHA256:test',
      onStoreRecovered: (info) => recovered.push(info),
    });
  }

  it.each([
    ['a version this build does not read', JSON.stringify({ version: 99, sessions: [] }), /store version 99/],
    ['a file that is not JSON', 'not json at all', /not valid JSON/],
    ['an object with no session list', JSON.stringify({ version: 1 }), /no session list/],
  ])('starts empty and reports the reason: %s', async (_label, contents, reasonPattern) => {
    // Each of these used to throw out of `load()`. The only caller is
    // `createServices()` in main.ts, which ran in the same `try` as
    // `registerIpc()` — so the whole of `window.cozypad` went undefined and
    // files, terminal, monitor and settings died with the agent page.
    //
    // A version bump is not hypothetical here: the ACP cutover changes this
    // store, and running an older build once against a newer store is exactly
    // the version-99 row.
    const storePath = path.join(directory, 'sessions.json');
    await fs.writeFile(storePath, contents, 'utf8');
    const recovered: { reason: string; backupPath: string | null }[] = [];

    await expect(serviceFor(storePath, recovered).load()).resolves.toBeUndefined();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.reason).toMatch(reasonPattern);
    // Moved aside, not deleted: a session list is worth recovering by hand.
    expect(recovered[0]?.backupPath).toBe(`${storePath}.unreadable.bak`);
    await expect(fs.readFile(`${storePath}.unreadable.bak`, 'utf8')).resolves.toBe(contents);
  });

  it('still reports nothing when the store simply does not exist', async () => {
    // A first run is not a recovery, and must not warn about one.
    const recovered: { reason: string; backupPath: string | null }[] = [];
    await serviceFor(path.join(directory, 'absent.json'), recovered).load();
    expect(recovered).toEqual([]);
  });

  it('writes the version it claims to read, so a round-trip never quarantines itself', async () => {
    // The reported number and the compared number were the same literal in two
    // places. Pinning both against the exported constant is what keeps a future
    // bump from telling the user their own store is foreign.
    const storePath = path.join(directory, 'roundtrip.json');
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: STORE_VERSION, sessions: [] }),
      'utf8',
    );
    const recovered: { reason: string; backupPath: string | null }[] = [];
    await serviceFor(storePath, recovered).load();
    expect(recovered).toEqual([]);
  });
});
