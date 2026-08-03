import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeAgySteps,
  readLatestAgyTranscript,
} from '../src/main/agyTranscript';

/** Encode one length-delimited protobuf field. */
function lengthDelimited(field: number, payload: Buffer): Buffer {
  const tag = Buffer.from([(field << 3) | 2]);
  const bytes: number[] = [];
  let remaining = payload.length;
  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.concat([tag, Buffer.from(bytes), payload]);
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
