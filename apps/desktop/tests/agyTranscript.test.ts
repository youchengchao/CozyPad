import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_AGY_TRANSCRIPT_TEXT,
  decodeAgySteps,
  latestAgyConversationId,
  readLatestAgyTranscript,
} from '../src/main/agyTranscript';

describe('latestAgyConversationId time window', () => {
  it('only accepts a conversation written around the session own activity', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cozypad-agy-home-'));
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    await mkdir(dir, { recursive: true });
    const anchor = Date.now() - 60 * 60_000;
    const write = async (name: string, mtimeMs: number) => {
      const file = path.join(dir, name);
      await writeFile(file, 'x');
      await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
    };
    // This session's own conversation: last written just before its exit.
    await write('mine.db', anchor - 5 * 60_000);
    // Someone else used AGY afterwards; the unfiltered "latest" is theirs,
    // which is exactly the wrong-session binding the window prevents.
    await write('newer-foreign.db', anchor + 45 * 60_000);
    await write('older-foreign.db', anchor - 6 * 60 * 60_000);

    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(await latestAgyConversationId()).toBe('newer-foreign');
      expect(
        await latestAgyConversationId({
          notBefore: anchor - 30 * 60_000,
          notAfter: anchor + 30 * 60_000,
        }),
      ).toBe('mine');
      expect(
        await latestAgyConversationId({ notBefore: anchor + 90 * 60_000 }),
      ).toBeUndefined();
    } finally {
      homedir.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});

/** Encode one length-delimited protobuf field. */
function protoVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([
    protoVarint((field << 3) | 2),
    protoVarint(payload.length),
    payload,
  ]);
}

const text = (field: number, value: string) =>
  lengthDelimited(field, Buffer.from(value, 'utf8'));

describe('AGY conversation decoding', () => {
  it('rebuilds user and assistant turns from protobuf step rows', () => {
    const turns = decodeAgySteps([
      // User text sits in field 2; other fields are ids and metadata.
      {
        step_type: 14,
        step_payload: Buffer.concat([
          text(12, 'cc0577fd-a50a-4d02-933f-3c0afd49bd21'),
          text(2, '出個謎題讓我做選擇題'),
        ]),
      },
      // Unknown step types carry telemetry and must not become turns.
      { step_type: 98, step_payload: text(12, 'meta') },
      // The assistant reply is field 1; field 3 is thinking and is ignored.
      {
        step_type: 15,
        step_payload: Buffer.concat([
          text(1, '好的，這是一個經典謎題……'),
          text(3, '**Crafting the Riddle** internal thinking'),
        ]),
      },
      { step_type: 14, step_payload: text(2, 'B') },
      { step_type: 15, step_payload: text(1, '答對了！') },
    ]);

    expect(turns).toEqual([
      { prompt: '出個謎題讓我做選擇題', assistantText: '好的，這是一個經典謎題……' },
      { prompt: 'B', assistantText: '答對了！' },
    ]);
  });

  it('unwraps the AGY 1.1.10 user and assistant payload envelopes', () => {
    const markdown = '```mermaid\ngraph TD\nA-->B\n```';
    const turns = decodeAgySteps([
      {
        step_type: 14,
        step_payload: lengthDelimited(
          19,
          Buffer.concat([text(2, 'render a diagram'), text(3, 'duplicate display data')]),
        ),
      },
      {
        step_type: 15,
        step_payload: lengthDelimited(
          20,
          Buffer.concat([text(1, markdown), text(8, 'duplicate display data')]),
        ),
      },
    ]);

    expect(turns).toEqual([
      { prompt: 'render a diagram', assistantText: markdown },
    ]);
  });

  it('preserves Markdown well beyond the former 40,000 character clamp', () => {
    const markdown = [
      '# Diagram',
      '',
      '```mermaid',
      ...Array<string>(8_000).fill('A-->B'),
      '```',
    ].join('\n');
    const turns = decodeAgySteps([
      { step_type: 14, step_payload: text(2, 'render this') },
      { step_type: 15, step_payload: text(1, markdown) },
    ]);

    expect(markdown.length).toBeGreaterThan(40_000);
    expect(turns[0]?.assistantText).toBe(markdown);
  });

  it('still clamps pathological transcript fields at 512 KiB', () => {
    const oversized = 'x'.repeat(MAX_AGY_TRANSCRIPT_TEXT + 100);
    const turns = decodeAgySteps([
      { step_type: 14, step_payload: text(2, 'large reply') },
      { step_type: 15, step_payload: text(1, oversized) },
    ]);

    expect(turns[0]?.assistantText).toHaveLength(MAX_AGY_TRANSCRIPT_TEXT);
  });
  it('reads the user text when it is nested one message deep', () => {
    const turns = decodeAgySteps([
      {
        step_type: 14,
        step_payload: lengthDelimited(2, text(1, 'nested prompt')),
      },
    ]);

    expect(turns).toEqual([{ prompt: 'nested prompt', assistantText: '' }]);
  });

  it('survives malformed payloads without throwing', () => {
    expect(
      decodeAgySteps([
        { step_type: 14, step_payload: Buffer.from([0xff, 0xff, 0xff]) },
        { step_type: 15, step_payload: null },
      ]),
    ).toEqual([]);
  });

  // Runs only where a real AGY store exists — this machine has one, CI won't.
  it.runIf(
    existsSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations')),
  )('reads the real conversation store on this machine', async () => {
    const turns = await readLatestAgyTranscript();

    expect(Array.isArray(turns)).toBe(true);
    for (const turn of turns) {
      expect(typeof turn.prompt).toBe('string');
      expect(typeof turn.assistantText).toBe('string');
    }
  });
});
