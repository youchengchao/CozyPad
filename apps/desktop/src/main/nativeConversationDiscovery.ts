import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AcpDiscoveredSession } from './acp/acpAgentRuntime';

const AGY_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/iu;
const CODEX_ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const MAX_TITLE_CHARACTERS = 120;
const DISCOVERY_CONCURRENCY = 8;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function titleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => titleText(entry))
      .filter((entry): entry is string => entry !== undefined);
    return parts.length === 0 ? undefined : parts.join(' ');
  }
  const object = recordOf(value);
  if (object === null) return undefined;
  return titleText(object['text'] ?? object['message'] ?? object['content']);
}

function normalizeTitle(value: unknown): string | undefined {
  const text = titleText(value)?.replace(/\s+/gu, ' ').trim();
  if (
    text === undefined ||
    text === '' ||
    text.startsWith('<environment_context>') ||
    text.startsWith('<permissions')
  ) {
    return undefined;
  }
  const characters = [...text];
  return characters.length <= MAX_TITLE_CHARACTERS
    ? text
    : `${characters.slice(0, MAX_TITLE_CHARACTERS - 1).join('')}…`;
}

function timestampTitle(agent: 'AGY' | 'Codex', updatedAt: string): string {
  return `${agent} conversation · ${updatedAt.replace('T', ' ').slice(0, 16)} UTC`;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function nativeHomeDirectory(probedHome: string): string {
  if (process.platform !== 'win32') return probedHome;
  // The local environment probe runs in Git Bash and reports /c/Users/..., a
  // valid shell path but not a path Node's Windows fs can open. Remote Windows
  // hosts are unsupported, so a POSIX-shaped value here always means local.
  return /^[A-Za-z]:[\\/]/u.test(probedHome) || /^\\\\/u.test(probedHome)
    ? probedHome
    : os.homedir();
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(DISCOVERY_CONCURRENCY, values.length) },
      async () => {
        while (next < values.length) {
          const index = next;
          next += 1;
          results[index] = await mapper(values[index]!);
        }
      },
    ),
  );
  return results;
}

async function listAgyConversations(
  homeDirectory: string,
): Promise<AcpDiscoveredSession[]> {
  const directory = path.join(
    homeDirectory,
    '.gemini',
    'antigravity-cli',
    'conversations',
  );
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = entries.filter(
    (entry) => entry.isFile() && AGY_CONVERSATION_ID.test(entry.name),
  );
  const sessions = await mapConcurrent(files, async (entry) => {
    try {
      const stat = await fs.stat(path.join(directory, entry.name));
      const updatedAt = stat.mtime.toISOString();
      return {
        sessionId: path.basename(entry.name, '.db'),
        // AGY's database has no stable workspace column. The conversation id
        // is authoritative for resume; home is the safest valid launch cwd.
        cwd: homeDirectory,
        title: timestampTitle('AGY', updatedAt),
        updatedAt,
      } satisfies AcpDiscoveredSession;
    } catch {
      // A conversation can disappear while the directory is being scanned.
      return null;
    }
  });
  return sessions
    .filter(isNotNull)
    .sort((left, right) =>
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
    );
}

async function codexFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      continue;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && CODEX_ROLLOUT.test(entry.name)) files.push(file);
      // Deliberately do not follow symlinks out of Codex's session tree.
    }
  }
  return files;
}

async function readCodexConversation(
  file: string,
  homeDirectory: string,
): Promise<AcpDiscoveredSession | null> {
  const filenameMatch = CODEX_ROLLOUT.exec(path.basename(file));
  let sessionId = filenameMatch?.[1];
  let cwd: string | undefined;
  let updatedAt: string | undefined;
  let title: string | undefined;
  let input: ReturnType<typeof createReadStream> | null = null;
  let lines: readline.Interface | null = null;
  try {
    input = createReadStream(file, { encoding: 'utf8' });
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let row: Record<string, unknown> | null;
      try {
        row = recordOf(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = recordOf(row?.['payload']);
      if (row?.['type'] === 'session_meta' && payload !== null) {
        sessionId =
          nonEmptyString(payload['id']) ??
          nonEmptyString(payload['session_id']) ??
          sessionId;
        cwd = nonEmptyString(payload['cwd']) ?? cwd;
        updatedAt =
          nonEmptyString(payload['timestamp']) ??
          nonEmptyString(row['timestamp']) ??
          updatedAt;
      } else if (
        row?.['type'] === 'event_msg' &&
        payload?.['type'] === 'user_message'
      ) {
        title =
          normalizeTitle(payload['message']) ??
          normalizeTitle(payload['text_elements']) ??
          title;
      }
      if (sessionId !== undefined && cwd !== undefined && title !== undefined) break;
    }
  } catch {
    return null;
  } finally {
    lines?.close();
    input?.destroy();
  }
  if (sessionId === undefined) return null;
  const stat = await fs.stat(file).catch(() => null);
  // session_meta.timestamp is the creation time. The rollout mtime tracks the
  // latest turn and is what a recently continued conversation must sort by.
  const normalizedUpdatedAt =
    stat?.mtime.toISOString() ??
    (updatedAt !== undefined && Number.isFinite(Date.parse(updatedAt))
      ? new Date(updatedAt).toISOString()
      : new Date(0).toISOString());
  return {
    sessionId,
    cwd: cwd ?? homeDirectory,
    title: title ?? timestampTitle('Codex', normalizedUpdatedAt),
    updatedAt: normalizedUpdatedAt,
  };
}

async function listCodexConversations(
  homeDirectory: string,
): Promise<AcpDiscoveredSession[]> {
  const root = path.join(homeDirectory, '.codex', 'sessions');
  const files = await codexFiles(root);
  const sessions = await mapConcurrent(files, (file) =>
    readCodexConversation(file, homeDirectory),
  );
  return sessions
    .filter(isNotNull)
    .sort((left, right) =>
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
    );
}

/**
 * Enumerates conversations in the target user's own home directory.
 *
 * This runs inside the target-host process. It therefore discovers the remote
 * user's history for an SSH connection and the desktop user's history locally;
 * the renderer never reads either home directory directly.
 */
export function discoverStoredAgentSessions(
  agentKind: string,
  homeDirectory: string,
): Promise<AcpDiscoveredSession[]> {
  const nativeHome = nativeHomeDirectory(homeDirectory);
  if (agentKind === 'agy') return listAgyConversations(nativeHome);
  if (agentKind === 'codex') return listCodexConversations(nativeHome);
  return Promise.resolve([]);
}
