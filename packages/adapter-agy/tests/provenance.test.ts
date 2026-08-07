/**
 * The fixtures claim to be verbatim recordings. This is the check that keeps the
 * claim honest.
 *
 * A recording is only worth anything if you can tell it apart from something
 * somebody typed. Nothing in the bytes themselves says which one you are looking
 * at, so the guarantee has to come from process: `fixtures/record.mjs` writes
 * them, `fixtures/README.md` records what was run and what came out, and this
 * file fails if the two stop agreeing. Editing a fixture by hand — the exact
 * mistake that once put a guessed `TOOL_EXECUTION_ERROR` into the wire types —
 * now breaks the suite unless you also edit the README, which is a change a
 * reviewer can see.
 *
 * It follows that the md5s here are not correctness assertions. Re-recording is
 * *supposed* to change them; it is just supposed to change the README too.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgyLine } from '../src/wire.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface ProvenanceRow {
  readonly name: string;
  readonly md5: string;
  readonly bytes: number;
}

/**
 * Rows look like:
 * `| `turn-plain.ndjson` | 2026-08-07 | `55175b…` | 2985 | ✗ none |`
 */
function readProvenanceTable(): ProvenanceRow[] {
  const readme = readFileSync(path.join(fixtures, 'README.md'), 'utf8');
  const row = /^\|\s*`([\w.-]+\.ndjson)`\s*\|[^|]*\|\s*`([0-9a-f]{32})`\s*\|\s*(\d+)\s*\|/gm;
  const rows: ProvenanceRow[] = [];
  for (const match of readme.matchAll(row)) {
    rows.push({ name: match[1]!, md5: match[2]!, bytes: Number(match[3]!) });
  }
  return rows;
}

function recordedFixtures(): string[] {
  return readdirSync(fixtures)
    .filter((name) => name.endsWith('.ndjson'))
    .sort();
}

describe('fixture provenance', () => {
  const rows = readProvenanceTable();

  it('finds a provenance table to check against', () => {
    // A README whose table stopped parsing would make every check below vacuous.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('documents every recording that is checked in', () => {
    expect([...rows.map((entry) => entry.name)].sort()).toEqual(recordedFixtures());
  });

  it.each(rows)(
    'matches the recorded md5 and size for $name',
    ({ name, md5, bytes }: ProvenanceRow) => {
      const contents = readFileSync(path.join(fixtures, name));
      expect(contents.length).toBe(bytes);
      expect(createHash('md5').update(contents).digest('hex')).toBe(md5);
    },
  );

  it.each(recordedFixtures())('is intact NDJSON end to end: %s', (name) => {
    // Catches a truncated or half-written recording, which would otherwise show
    // up much later as a fixture that quietly asserts less than it looks like.
    const lines = readFileSync(path.join(fixtures, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => parseAgyLine(line) === undefined)).toEqual([]);
    // Every recorded turn ends with agy's own verdict; missing it means the
    // capture stopped early.
    expect(parseAgyLine(lines.at(-1)!)?.event).toBe('result');
  });
});
