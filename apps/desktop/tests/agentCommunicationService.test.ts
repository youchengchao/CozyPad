import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TmuxSessionInfo } from '@cozypad/tmux-runtime';
import type { ChatItem } from '@cozypad/contracts';
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
            '__COZYPAD_VERSION__=',
            '__COZYPAD_VERSION_STATUS__=124',
            '__COZYPAD_HELP_STATUS__=124',
            '__COZYPAD_HELP_OUTPUT_BEGIN__',
            '__COZYPAD_HELP_OUTPUT_END__',
            '__COZYPAD_PROTOCOL_HELP_STATUS__=0',
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

  fsRealpath(inputPath: string): Promise<string> {
    return Promise.resolve(inputPath);
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
  let acpPrompts: { sessionId: string; text: string }[];
  /** Set by a test that needs delivery to fail. */
  let acpPromptError: Error | null;
  let storedDiscovery: (
    agentKind: string,
    homeDirectory: string,
  ) => Promise<
    Array<{
      sessionId: string;
      cwd: string;
      title?: string;
      updatedAt?: string;
    }>
  >;
  let acpRuntime: {
    has(sessionId: string): boolean;
    discover?(
      agentKind: string,
      cwd: string,
      remote?: boolean,
    ): Promise<Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>>;
    start(
      sessionId: string,
      cwd: string,
      agentKind?: string,
      continuation?: {
        acpSessionId: string;
        history?: readonly ChatItem[];
        resumeMeta?: Readonly<Record<string, unknown>>;
      },
    ): Promise<{
      acpSessionId: string;
      continued: boolean;
      configOptions: unknown;
      modes: { currentModeId?: string; availableModes: { id: string; name?: string }[] };
    }>;
    setConfigOption(
      sessionId: string,
      configId: string,
      value: string,
    ): Promise<unknown>;
    prompt(sessionId: string, text: string): Promise<string>;
    cancel(sessionId: string): Promise<void>;
    resolveControl(sessionId: string, requestId: string, optionId?: string | null): void;
    stop(sessionId: string): void;
  };
  let service: AgentCommunicationService;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cozypad-agent-test-'));
    transport = new FakeTransport();
    tmux = new FakeTmux();
    acpPrompts = [];
    acpPromptError = null;
    storedDiscovery = async () => [];
    acpRuntime = {
      has: () => true,
      start: async () => ({
        acpSessionId: 'acp-test',
        continued: false,
        configOptions: [],
        modes: { availableModes: [] },
      }),
      setConfigOption: async () => [],
      prompt: async (sessionId, text) => {
        acpPrompts.push({ sessionId, text });
        if (acpPromptError !== null) throw acpPromptError;
        return 'end_turn';
      },
      cancel: async () => undefined,
      resolveControl: () => undefined,
      stop: () => undefined,
    };
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
      // These tests are about the agent path, not about which host it runs on.
      // The remote case has its own describe at the end of this file.
      isLocalHost: () => true,
      acp: acpRuntime,
      discoverStoredSessions: (agentKind, homeDirectory) =>
        storedDiscovery(agentKind, homeDirectory),
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

  it('uses the host-canonical workspace for tmux and session identity', async () => {
    vi.spyOn(transport, 'fsRealpath').mockResolvedValue('/srv/canonical-project');

    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'claude',
      cwd: '/srv/link/../project',
    });

    expect(tmux.created[0]?.cwd).toBe('/srv/canonical-project');
    expect(bundle.session.cwd).toBe('/srv/canonical-project');
    expect(bundle.session.projectId).toBe('/srv/canonical-project');
  });

  it('registers ACP-native conversations so archive covers pre-existing sessions', async () => {
    const boundRuntime = Object.assign(acpRuntime, { spawnReady: true });
    boundRuntime.discover = async function (this: typeof boundRuntime) {
      // AcpAgentRuntime.discover reads its spawn functions from `this`. This
      // catches service code that extracts the method and invokes it unbound.
      expect(this).toBe(boundRuntime);
      expect(this.spawnReady).toBe(true);
      return [
        {
          sessionId: 'native-conversation-1',
          cwd: '/srv/native-project',
          title: 'Existing native conversation',
          updatedAt: '2026-08-14T12:00:00.000Z',
        },
      ];
    };

    await service.detect({ profileId: 'profile-1', agentKind: 'claude' });
    const listed = service.list({ profileId: 'profile-1', archive: 'all' });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.session).toMatchObject({
      title: 'Existing native conversation',
      cwd: '/srv/native-project',
      status: 'exited',
      conversationBound: true,
    });
    await expect(
      service.archive({ sessionId: listed[0]!.session.id }),
    ).resolves.toMatchObject({ session: { archivedAt: expect.any(String) } });
  });

  it('rescans native conversations when a cached agent is selected again', async () => {
    let discovery = 0;
    acpRuntime.discover = async () => {
      discovery += 1;
      return [
        {
          sessionId: `native-conversation-${discovery}`,
          cwd: `/srv/native-project-${discovery}`,
          updatedAt: `2026-08-14T1${discovery}:00:00.000Z`,
        },
      ];
    };

    await service.detect({ profileId: 'profile-1', agentKind: 'codex' });
    await service.detect({ profileId: 'profile-1', agentKind: 'codex' });

    expect(discovery).toBe(2);
    expect(
      service
        .list({ profileId: 'profile-1', archive: 'all' })
        .filter((bundle) => bundle.session.agentKind === 'codex'),
    ).toHaveLength(2);
  });

  it('imports AGY home-store conversations without relying on ACP session/list', async () => {
    storedDiscovery = async (agentKind, homeDirectory) => {
      expect(agentKind).toBe('agy');
      expect(homeDirectory).toBe('/home/researcher');
      return [
        {
          sessionId: '00000000-0000-0000-0000-000000000123',
          cwd: homeDirectory,
          title: 'AGY conversation · 2026-08-14 12:00 UTC',
          updatedAt: '2026-08-14T12:00:00.000Z',
        },
      ];
    };

    await service.detect({ profileId: 'profile-1', agentKind: 'agy' });

    expect(
      service
        .list({ profileId: 'profile-1', archive: 'all' })
        .find((bundle) => bundle.session.agentKind === 'agy')?.session,
    ).toMatchObject({
      title: 'AGY conversation · 2026-08-14 12:00 UTC',
      cwd: '/home/researcher',
      conversationBound: true,
    });
  });

  it('drops native discovery that finishes after the host disconnects', async () => {
    type NativeSession = {
      sessionId: string;
      cwd: string;
      title?: string;
      updatedAt?: string;
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishDiscovery!: (sessions: NativeSession[]) => void;
    storedDiscovery = () => {
      markStarted();
      return new Promise<NativeSession[]>((resolve) => {
        finishDiscovery = resolve;
      });
    };

    const detection = service.detect({ profileId: 'profile-1', agentKind: 'agy' });
    await started;
    service.disconnected('profile-1');
    finishDiscovery([
      {
        sessionId: '00000000-0000-0000-0000-000000000999',
        cwd: '/home/researcher',
      },
    ]);
    await detection;
    await service.connected('profile-1');

    expect(
      service
        .list({ profileId: 'profile-1', archive: 'all' })
        .some(
          (bundle) =>
            bundle.session.title === 'Imported AGY conversation' &&
            bundle.session.conversationBound,
        ),
    ).toBe(false);
  });

  it('archives the full conversation and restores it without auto-starting', async () => {
    const bundle = await createSession();

    const archived = await service.archive({ sessionId: bundle.session.id });
    expect(archived.session.archivedAt).not.toBeNull();
    expect(archived.session.status).toBe('exited');
    expect(service.list({ profileId: 'profile-1' })).toEqual([]);
    expect(
      service.list({ profileId: 'profile-1', archive: 'archived' }),
    ).toHaveLength(1);

    const restored = await service.restore({ sessionId: bundle.session.id });
    expect(restored.session.archivedAt).toBeNull();
    expect(restored.session.status).toBe('exited');
    expect(service.list({ profileId: 'profile-1' })).toHaveLength(1);
  });

  it('merges concurrent clients so neither host session is lost', async () => {
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box alias',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    const second = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: profiles,
      storePath: path.join(tempDirectory, 'sessions.json'),
      getHostFingerprint: () => 'SHA256:test',
      isLocalHost: () => true,
      acp: acpRuntime,
    });
    await second.load();
    await second.connected('profile-1');

    const [firstCreated, secondCreated] = await Promise.all([
      service.create({
        profileId: 'profile-1',
        agentKind: 'claude',
        cwd: '/srv/deep-learning',
        title: 'Client one',
      }),
      second.create({
        profileId: 'profile-1',
        agentKind: 'claude',
        cwd: '/srv/deep-learning',
        title: 'Client two',
      }),
    ]);

    const listed = service.list({ profileId: 'profile-1', archive: 'all' });
    expect(listed.map((entry) => entry.session.id).sort()).toEqual(
      [firstCreated.session.id, secondCreated.session.id].sort(),
    );

    await service.shutdown('profile-1');
    expect(
      second
        .list({ profileId: 'profile-1', archive: 'all' })
        .find((entry) => entry.session.id === secondCreated.session.id)?.session
        .status,
    ).toBe('ready');
  });

  it('prevents two clients from driving the same live Agent conversation', async () => {
    const profiles = new MemoryProfileStore([
      {
        id: 'profile-1',
        name: 'Research box alias',
        host: 'lab.example',
        port: 22,
        username: 'researcher',
        authMethod: 'password',
        hasPassword: true,
        credentialPersisted: false,
      },
    ]);
    const second = new AgentCommunicationService({
      transport: transport as unknown as TransportPort,
      tmux,
      profileStore: profiles,
      storePath: path.join(tempDirectory, 'sessions.json'),
      getHostFingerprint: () => 'SHA256:test',
      isLocalHost: () => true,
      acp: { ...acpRuntime, has: () => false },
    });
    await second.load();
    await second.connected('profile-1');
    const created = await createSession();

    await expect(
      second.send({
        sessionId: created.session.id,
        text: 'race this turn',
        attachmentIds: [],
      }),
    ).rejects.toThrow('active in another CozyPad client');
    expect(acpPrompts).toEqual([]);

    await service.shutdown('profile-1');
    await second.revive({ sessionId: created.session.id });
    await expect(
      second.send({
        sessionId: created.session.id,
        text: 'after ownership was released',
        attachmentIds: [],
      }),
    ).resolves.toBeUndefined();
    expect(acpPrompts).toEqual([
      {
        sessionId: created.session.id,
        text: 'after ownership was released',
      },
    ]);
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
    expect(
      service.list({ profileId: 'profile-1', archive: 'all' }),
    ).toEqual([]);

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

  it('accepts AGY from the user home without waiting for version or help', async () => {
    const installation = await service.detect({
      profileId: 'profile-1',
      agentKind: 'agy',
    });

    expect(installation).toMatchObject({
      installed: true,
      installationScope: 'user',
      executablePath: '/home/researcher/.local/bin/agy',
      supportsStructuredOutput: true,
      supportsResume: true,
    });
    expect(installation.launchModes.map((mode) => mode.id)).toContain('default');
    const capabilityProbe = transport.commands.find((command) =>
      command.includes("command -v 'agy'"),
    );
    expect(capabilityProbe).not.toContain('cozypad_optional --version');
    expect(capabilityProbe).not.toContain('cozypad_optional --help');
  });

  it('says so when the agent offers no mode matching the requested permissions', async () => {
    // Permission flags no longer ride the pane script — the pane is a
    // placeholder and the mode goes to the agent via session/set_mode. When
    // the agent advertises nothing that matches, the session must say the
    // choice did not take rather than silently running with defaults.
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'claude',
      cwd: '/srv/deep-learning',
      permissionMode: 'dangerouslySkip',
    });

    expect(tmux.created[0]?.argv[2]).toContain('sleep 3600');
    expect(
      bundle.items.some(
        (item) => item.kind === 'notice' && item.text.includes('bypassPermissions'),
      ),
    ).toBe(true);
  });


  it('opens AGY as a chat session, not as a terminal', async () => {
    // This test used to assert the opposite, and it was right to fail: agy ran
    // as an interactive TUI that CozyPad drove and read back off a 120x40
    // screen. That path concatenated the user's prompts, dropped the first
    // character of each, and turned quoted phrases in prose into a fake option
    // menu — measured against agy's own conversation store. It speaks ACP
    // through packages/adapter-agy now.
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'default',
    });

    expect(bundle.session).toMatchObject({
      agentKind: 'agy',
      status: 'ready',
    });

    // The refusal that used to greet anyone who typed into an agy session is
    // gone. Sending is a normal turn now.
    await expect(
      service.send({
        sessionId: bundle.session.id,
        text: 'This is an ordinary message',
        attachmentIds: [],
      }),
    ).resolves.toBeUndefined();
    expect(acpPrompts).toEqual([
      { sessionId: bundle.session.id, text: 'This is an ordinary message' },
    ]);
  });

  const pendingApproval = (id: string): Extract<ChatItem, { kind: 'approval' }> => ({
    kind: 'approval',
    id,
    timestamp: new Date().toISOString(),
    riskSummary: 'Run tests',
    resolution: 'pending',
    options: [
      { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  });

  const statusOf = (sessionId: string) =>
    service
      .list({ profileId: 'profile-1' })
      .find((bundle) => bundle.session.id === sessionId)?.session.status;

  async function createSessionWithHeldTurn(): Promise<{
    sessionId: string;
    turn: Promise<void>;
    releaseTurn: (stopReason: string) => void;
  }> {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'default',
    });
    let release: ((stopReason: string) => void) | undefined;
    acpRuntime.prompt = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const turn = service.send({
      sessionId: bundle.session.id,
      text: 'go',
      attachmentIds: [],
    });
    // send() reaches the agent only after its own awaits; the turn is not
    // held until the fake prompt has actually been entered.
    await vi.waitFor(() => {
      if (release === undefined) throw new Error('turn not started yet');
    });
    return {
      sessionId: bundle.session.id,
      turn,
      releaseTurn: (stopReason: string) => release!(stopReason),
    };
  }

  it('shows waiting_approval while an approval card is pending, and only then', async () => {
    const { sessionId, turn, releaseTurn } = await createSessionWithHeldTurn();
    expect(statusOf(sessionId)).toBe('running');

    service.replaceTimeline(sessionId, [pendingApproval('a1')]);
    expect(statusOf(sessionId)).toBe('waiting_approval');

    service.replaceTimeline(sessionId, [
      { ...pendingApproval('a1'), resolution: 'allowed' },
    ]);
    expect(statusOf(sessionId)).toBe('running');

    releaseTurn('end_turn');
    await turn;
    expect(statusOf(sessionId)).toBe('ready');
  });

  it('answers "allowed" with allow_once even when allow_always is listed first', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'default',
    });
    const resolved: { requestId: string; optionId: string | null | undefined }[] = [];
    acpRuntime.resolveControl = (_sessionId, requestId, optionId) => {
      resolved.push({ requestId, optionId });
    };
    service.replaceTimeline(bundle.session.id, [pendingApproval('a1')]);

    await service.resolveApproval({
      sessionId: bundle.session.id,
      itemId: 'a1',
      resolution: 'allowed',
    });

    expect(resolved).toEqual([{ requestId: 'a1', optionId: 'once' }]);
  });

  it('sends the exact option the card named, overriding the fallback mapping', async () => {
    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'default',
    });
    const resolved: (string | null | undefined)[] = [];
    acpRuntime.resolveControl = (_sessionId, _requestId, optionId) => {
      resolved.push(optionId);
    };
    service.replaceTimeline(bundle.session.id, [pendingApproval('a1')]);

    await service.resolveApproval({
      sessionId: bundle.session.id,
      itemId: 'a1',
      resolution: 'allowed',
      optionId: 'always',
    });

    expect(resolved).toEqual(['always']);
  });

  it('leaves an interrupted turn running until the agent honours the cancel', async () => {
    const { sessionId, turn, releaseTurn } = await createSessionWithHeldTurn();
    const cancelled: string[] = [];
    acpRuntime.cancel = async (target) => {
      cancelled.push(target);
    };

    await service.interrupt({ sessionId });

    expect(cancelled).toEqual([sessionId]);
    // Still the agent's turn: 'ready' here with activeTurn set is the state
    // that used to refuse every later send while hiding the Stop button.
    expect(statusOf(sessionId)).toBe('running');

    releaseTurn('cancelled');
    await turn;
    expect(statusOf(sessionId)).toBe('ready');
    acpRuntime.prompt = async () => 'end_turn';
    await expect(
      service.send({ sessionId, text: 'next', attachmentIds: [] }),
    ).resolves.toBeUndefined();
  });

  it('clears a stale turn on interrupt when no agent process exists', async () => {
    const { sessionId, turn, releaseTurn } = await createSessionWithHeldTurn();
    releaseTurn('end_turn');
    await turn;
    acpRuntime.prompt = () => new Promise<string>(() => undefined);
    const secondTurn = service.send({ sessionId, text: 'again', attachmentIds: [] });
    acpRuntime.has = () => false;

    await service.interrupt({ sessionId });

    expect(statusOf(sessionId)).toBe('ready');
    secondTurn.catch(() => undefined);
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
    // What reached the agent, rather than what was written into a pane. The
    // paths matter more than the mechanism did: an agent whose
    // promptCapabilities.image is false can only get a file by being told
    // where it is.
    const sent = acpPrompts.at(-1)?.text ?? '';
    expect(sent).toContain('Review this architecture');
    expect(sent).toContain(`@${image!.remotePath}`);
    expect(sent).toContain(`@${notes!.remotePath}`);
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
    // Delivery fails at the agent now, not at a tmux pane. What the test is
    // really about is unchanged: a turn that never reached the agent must
    // leave the session usable and the uploaded attachment resendable.
    acpPromptError = new Error('agent temporarily rejected input');

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

    acpPromptError = null;
    await expect(
      service.send({
        sessionId: bundle.session.id,
        text: 'Inspect this',
        attachmentIds: [screenshot!.id],
      }),
    ).resolves.toBeUndefined();
    const retried = service.list({ profileId: 'profile-1' })[0]!;
    // 'ready', not 'running': `session/prompt` resolving IS the end of the
    // turn, so the session is usable again the moment send() returns. Leaving
    // it 'running' is what made the second message impossible — the guard at
    // the top of send() rejected it with "Agent is waiting for the current turn
    // to finish", forever.
    expect(retried.session.status).toBe('ready');
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



  it('persists and resumes the Codex ACP session id', async () => {
    const starts: Array<{
      agentKind: string | undefined;
      continuation: { acpSessionId: string } | undefined;
    }> = [];
    acpRuntime.start = async (_sessionId, _cwd, agentKind, continuation) => {
      starts.push({ agentKind, continuation });
      return {
        acpSessionId: 'codex-thread-1',
        continued: continuation?.acpSessionId === 'codex-thread-1',
        configOptions: [],
        modes: { availableModes: [] },
      };
    };

    const installation = await service.detect({
      profileId: 'profile-1',
      agentKind: 'codex',
    });
    expect(installation.supportsResume).toBe(true);
    expect(installation.resumeStartsNewConversation).toBeUndefined();

    const bundle = await service.create({
      profileId: 'profile-1',
      agentKind: 'codex',
      cwd: '/srv/deep-learning',
      title: 'Codex continuity',
      launchMode: 'workspace-request',
    });
    service.noteAgentExit(bundle.session.id, 'test restart');

    const resumed = await service.revive({ sessionId: bundle.session.id });

    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      agentKind: 'codex',
      continuation: { acpSessionId: 'codex-thread-1' },
    });
    expect(resumed.session.resumeContinuity).toBe('continued');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDirectory, 'sessions.json'), 'utf8'),
    ) as {
      sessions: Array<{
        record: { identity?: { agentConversationId?: string } | null };
      }>;
    };
    expect(persisted.sessions[0]?.record.identity?.agentConversationId).toBe(
      'codex-thread-1',
    );
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

describe('a remote session uses ACP over the selected host', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cozypad-remote-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  it('passes the remote cwd and transport flag to ACP', async () => {
    const starts: unknown[][] = [];
    const remote = new AgentCommunicationService({
      transport: new FakeTransport() as unknown as TransportPort,
      tmux: new FakeTmux(),
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
      storePath: path.join(directory, 'remote.json'),
      getHostFingerprint: () => 'SHA256:test',
      acp: {
        has: () => false,
        start: async (...args) => {
          starts.push(args);
          return {
            acpSessionId: 'acp-test',
            continued: false,
            configOptions: [],
            modes: { availableModes: [] },
          };
        },
        setConfigOption: async () => [],
        prompt: async () => 'end_turn',
        cancel: async () => undefined,
        resolveControl: () => undefined,
        stop: () => undefined,
      },
    });
    await remote.connected('profile-1');

    const bundle = await remote.create({
      profileId: 'profile-1',
      agentKind: 'agy',
      cwd: '/srv/deep-learning',
      launchMode: 'default',
    });

    expect(bundle.session.status).toBe('ready');
    expect(starts).toEqual([
      [
        bundle.session.id,
        '/srv/deep-learning',
        'agy',
        undefined,
        undefined,
        true,
      ],
    ]);
  });
});
