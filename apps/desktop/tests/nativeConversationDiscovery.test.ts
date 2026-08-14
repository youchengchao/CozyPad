import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverStoredAgentSessions } from '../src/main/nativeConversationDiscovery';

describe('native conversation discovery', () => {
  let homeDirectory: string;

  beforeEach(async () => {
    homeDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cozypad-native-discovery-'),
    );
  });

  afterEach(async () => {
    await fs.rm(homeDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  it('enumerates every AGY database in the target home and ignores unrelated files', async () => {
    const directory = path.join(
      homeDirectory,
      '.gemini',
      'antigravity-cli',
      'conversations',
    );
    await fs.mkdir(directory, { recursive: true });
    const older = path.join(
      directory,
      '00000000-0000-0000-0000-000000000001.db',
    );
    const newer = path.join(
      directory,
      '00000000-0000-0000-0000-000000000002.db',
    );
    await Promise.all([
      fs.writeFile(older, 'older'),
      fs.writeFile(newer, 'newer'),
      fs.writeFile(path.join(directory, 'not-a-conversation.db'), 'ignored'),
    ]);
    await fs.utimes(older, new Date('2026-08-13T10:00:00Z'), new Date('2026-08-13T10:00:00Z'));
    await fs.utimes(newer, new Date('2026-08-14T10:00:00Z'), new Date('2026-08-14T10:00:00Z'));

    await expect(discoverStoredAgentSessions('agy', homeDirectory)).resolves.toEqual([
      {
        sessionId: '00000000-0000-0000-0000-000000000002',
        cwd: homeDirectory,
        title: 'AGY conversation · 2026-08-14 10:00 UTC',
        updatedAt: '2026-08-14T10:00:00.000Z',
      },
      {
        sessionId: '00000000-0000-0000-0000-000000000001',
        cwd: homeDirectory,
        title: 'AGY conversation · 2026-08-13 10:00 UTC',
        updatedAt: '2026-08-13T10:00:00.000Z',
      },
    ]);
  });

  it('reads Codex metadata and the first real user message from nested rollout files', async () => {
    const directory = path.join(homeDirectory, '.codex', 'sessions', '2026', '08', '14');
    await fs.mkdir(directory, { recursive: true });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const file = path.join(directory, `rollout-2026-08-14T10-00-00-${sessionId}.jsonl`);
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-08-14T10:00:00Z',
          payload: {
            id: sessionId,
            cwd: '/srv/project',
            timestamp: '2026-08-14T10:00:00Z',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: '<environment_context>hidden</environment_context>' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Fix the session refresh race' },
        }),
      ].join('\n'),
      'utf8',
    );
    await fs.utimes(file, new Date('2026-08-14T10:00:00Z'), new Date('2026-08-14T10:00:00Z'));

    await expect(discoverStoredAgentSessions('codex', homeDirectory)).resolves.toEqual([
      {
        sessionId,
        cwd: '/srv/project',
        title: 'Fix the session refresh race',
        updatedAt: '2026-08-14T10:00:00.000Z',
      },
    ]);
  });

  it('returns an empty list when the agent has no supported native store', async () => {
    await expect(
      discoverStoredAgentSessions('claude', homeDirectory),
    ).resolves.toEqual([]);
  });
});
