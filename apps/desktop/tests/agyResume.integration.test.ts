import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AgentCommunicationService } from '../src/main/agentCommunicationService';
import { latestAgyConversationId } from '../src/main/agyTranscript';
import { LocalAgentRuntime } from '../src/main/localAgentRuntime';
import { MemoryProfileStore } from '../src/main/profileStore';
import { LOCAL_PROFILE, LocalTransport } from '../src/main/transport/localTransport';

interface PersistedSession {
  record: {
    id: string;
    title: string;
    status: string;
    provisionalIdentity: {
      connectionProfileId: string;
      tmuxSessionId: string;
      launchNonce: string;
      agentKind: string;
    };
    identity: unknown;
  };
  paneId: string;
  timeline: unknown[];
  attachments: Record<string, unknown>;
  [key: string]: unknown;
}

interface PersistedStore {
  version: number;
  sessions: PersistedSession[];
}

/**
 * Opt-in smoke test for the actual local AGY executable and the persisted
 * session named "123". It clones the record before exercising Resume, so the
 * user's session store and attachment history are never rewritten.
 */
it.runIf(
  process.platform === 'win32' &&
    process.env.COZYPAD_REAL_AGY_RESUME_TEST === '1',
)(
  'resumes a clone of the real local AGY session named 123',
  async () => {
    const appData = process.env.APPDATA;
    if (appData === undefined) throw new Error('APPDATA is unavailable');
    const realStorePath = path.join(
      appData,
      '@cozypad',
      'desktop',
      'agent-sessions.json',
    );
    const realStore = JSON.parse(
      await fs.readFile(realStorePath, 'utf8'),
    ) as PersistedStore;
    const source = realStore.sessions.find(
      (session) =>
        session.record.title === '123' &&
        session.record.provisionalIdentity.agentKind === 'agy' &&
        session.record.provisionalIdentity.connectionProfileId ===
          LOCAL_PROFILE.id,
    );
    if (source === undefined) {
      throw new Error('The local AGY session named 123 was not found');
    }

    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cozypad-agy-resume-'),
    );
    const storePath = path.join(temporaryDirectory, 'agent-sessions.json');
    const clone = structuredClone(source);
    const testSessionId = randomUUID();
    clone.record = {
      ...clone.record,
      id: testSessionId,
      identity: null,
      status: 'disconnected',
      provisionalIdentity: {
        ...clone.record.provisionalIdentity,
        tmuxSessionId: '$local-stale',
        launchNonce: randomUUID(),
      },
    };
    clone.paneId = '$local-stale';
    clone.timeline = [];
    clone.attachments = {};
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, sessions: [clone] }, null, 2),
      'utf8',
    );

    const transport = new LocalTransport();
    const decoder = new TextDecoder();
    let terminalOutput = '';
    transport.setEvents({
      onConnectionState: () => undefined,
      onTerminalOutput: (_terminalId, data) => {
        terminalOutput = `${terminalOutput}${decoder.decode(data, { stream: true })}`.slice(
          -8_000,
        );
      },
      onTerminalClosed: () => undefined,
    });
    const runtime = new LocalAgentRuntime({
      openTerminal: (request, command) =>
        transport.openTerminal(request, command),
      writeTerminal: (terminalId, data) =>
        transport.writeTerminal(terminalId, data),
      closeTerminal: (terminalId) => transport.forceCloseTerminal(terminalId),
      hasTerminal: (terminalId) => transport.hasTerminal(terminalId),
    });
    const service = new AgentCommunicationService({
      transport,
      tmux: runtime,
      profileStore: new MemoryProfileStore([LOCAL_PROFILE]),
      storePath,
      getHostFingerprint: () => 'local',
      isLocalHost: () => true,
      getLatestLocalAgyConversationId: (window) => latestAgyConversationId(window),
    });

    try {
      // The service only accepts a conversation last written around this
      // session's own last activity; compute the expectation the same way.
      const lastActivityMs = Date.parse(
        (source.record as { updatedAt?: string }).updatedAt ?? '',
      );
      const expectedConversationId = await latestAgyConversationId(
        Number.isFinite(lastActivityMs)
          ? {
              notBefore: lastActivityMs - 30 * 60_000,
              notAfter: lastActivityMs + 30 * 60_000,
            }
          : undefined,
      );
      expect(expectedConversationId).toBeDefined();
      await transport.connect(LOCAL_PROFILE.id);
      await service.load();
      await service.connected(LOCAL_PROFILE.id);
      expect(service.list({ profileId: LOCAL_PROFILE.id })[0]?.session).toMatchObject({
        title: '123',
        status: 'exited',
      });

      const resumed = await service.revive({ sessionId: testSessionId });
      expect(resumed.session).toMatchObject({
        title: '123',
        status: 'ready',
        agentKind: 'agy',
        // A disk-guessed conversation is honest-labelled, never 'continued'.
        resumeContinuity: 'assumed',
      });
      expect(
        resumed.items.some(
          (item) => item.kind === 'notice' && item.text.includes('無法確認'),
        ),
      ).toBe(true);
      const live = await runtime.listSessions();
      expect(live).toHaveLength(1);
      expect(await runtime.hasSession(live[0]!.sessionId)).toBe(true);
      const persisted = JSON.parse(
        await fs.readFile(storePath, 'utf8'),
      ) as PersistedStore;
      expect(
        (
          persisted.sessions[0]?.record.identity as {
            agentConversationId?: string;
          } | null
        )?.agentConversationId,
      ).toBe(expectedConversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        terminalOutput.trim() === ''
          ? message
          : `${message}\n\nCaptured AGY terminal output:\n${terminalOutput}`,
      );
    } finally {
      for (const session of await runtime.listSessions()) {
        await runtime.killSession(session.sessionId);
      }
      await transport.disconnect(LOCAL_PROFILE.id);
      transport.dispose();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);
