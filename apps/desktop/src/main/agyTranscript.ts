import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgyRecoveredTurn } from '@cozypad/contracts';

/**
 * Reads a conversation back out of AGY's own store.
 *
 * AGY keeps each conversation as a SQLite database of protobuf-encoded steps
 * under `~/.gemini/antigravity-cli/conversations/`. The CLI's TUI never
 * reveals a conversation id, so after `--continue` relaunches "the most
 * recent conversation" the matching heuristic here is the same one: the most
 * recently written database is the conversation that was just resumed.
 *
 * The schema was mapped from real databases on this machine, not from any
 * specification: `steps.step_type` 14 carries the user's message in field 2,
 * and 15 carries the assistant's markdown reply in field 1. Everything else —
 * tool calls, thinking, telemetry — is deliberately ignored; the goal is the
 * transcript the user saw, not a replay of the run.
 */

const CONVERSATIONS_DIR = () =>
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

const USER_STEP = 14;
const ASSISTANT_STEP = 15;
const MAX_TURNS = 200;
const MAX_TEXT = 40_000;

interface ProtoField {
  field: number;
  wire: number;
  bytes?: Buffer;
}

/** Top-level fields of one protobuf message; stops silently on malformed data. */
function protoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  const varint = (): bigint | null => {
    let value = 0n;
    let shift = 0n;
    while (pos < buffer.length) {
      const byte = buffer[pos]!;
      pos += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 63n) return null;
    }
    return null;
  };
  while (pos < buffer.length) {
    const tag = varint();
    if (tag === null) return fields;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) return fields;
    if (wire === 0) {
      if (varint() === null) return fields;
      fields.push({ field, wire });
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4;
      if (pos > buffer.length) return fields;
      fields.push({ field, wire });
    } else if (wire === 2) {
      const length = varint();
      if (length === null) return fields;
      const size = Number(length);
      if (size < 0 || pos + size > buffer.length) return fields;
      fields.push({ field, wire, bytes: buffer.subarray(pos, pos + size) });
      pos += size;
    } else {
      return fields;
    }
  }
  return fields;
}

/** Whether the bytes decode to text a transcript could plausibly contain. */
function asText(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  if (text.includes('�')) return null;
  // Printable + common whitespace only; control bytes mean nested protobuf.
  if (!/^[\t\n\r\x20-\x7e -￿]*$/u.test(text)) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_TEXT);
}

function textOfField(payload: Buffer, wanted: number): string | null {
  const parts: string[] = [];
  for (const entry of protoFields(payload)) {
    if (entry.field !== wanted || entry.bytes === undefined) continue;
    const direct = asText(entry.bytes);
    if (direct !== null) {
      parts.push(direct);
      continue;
    }
    // The value may be one level of message around the string.
    for (const inner of protoFields(entry.bytes)) {
      if (inner.field !== 1 || inner.bytes === undefined) continue;
      const nested = asText(inner.bytes);
      if (nested !== null) parts.push(nested);
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

async function latestConversationDb(): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(CONVERSATIONS_DIR());
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const file = path.join(CONVERSATIONS_DIR(), name);
    try {
      const stat = await fs.stat(file);
      if (newest === null || stat.mtimeMs > newest.mtime) {
        newest = { file, mtime: stat.mtimeMs };
      }
    } catch {
      // A database removed mid-scan simply is not the newest one.
    }
  }
  return newest?.file ?? null;
}

/** Rebuild the visible transcript from a conversation's raw step rows. */
export function decodeAgySteps(
  rows: ReadonlyArray<{ step_type: number; step_payload: Uint8Array | null }>,
): AgyRecoveredTurn[] {
  const turns: AgyRecoveredTurn[] = [];
  for (const row of rows) {
    if (row.step_payload === null) continue;
    const payload = Buffer.from(row.step_payload);
    if (row.step_type === USER_STEP) {
      const prompt = textOfField(payload, 2);
      if (prompt !== null) turns.push({ prompt, assistantText: '' });
    } else if (row.step_type === ASSISTANT_STEP) {
      const text = textOfField(payload, 1);
      if (text === null) continue;
      const current = turns.at(-1);
      if (current === undefined) {
        turns.push({ prompt: '', assistantText: text });
      } else {
        current.assistantText =
          current.assistantText === '' ? text : `${current.assistantText}\n\n${text}`;
      }
    }
  }
  return turns.slice(-MAX_TURNS);
}

/**
 * The transcript of the most recently used AGY conversation on this machine,
 * oldest turn first. Returns [] whenever anything is missing or unreadable —
 * a restored transcript is a nicety, never worth failing a session over.
 */
export async function readLatestAgyTranscript(): Promise<AgyRecoveredTurn[]> {
  const file = await latestConversationDb();
  if (file === null) return [];
  try {
    // Imported lazily: node:sqlite is present in Electron's Node, but a mock
    // run or a test harness must not fail at import time if it ever is not.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT step_type, step_payload FROM steps ORDER BY idx')
        .all() as Array<{ step_type: number; step_payload: Uint8Array | null }>;
      return decodeAgySteps(rows);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
