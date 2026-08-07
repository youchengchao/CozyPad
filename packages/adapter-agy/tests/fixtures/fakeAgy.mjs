/**
 * Stands in for the real `agy` executable in the end-to-end test.
 *
 * It is a real process spawned over real pipes; the only thing it fakes is the
 * model. It records the argv it was handed (so the test can prove the prompt
 * survived spawning intact) and replays a recorded transcript byte for byte,
 * in small chunks so the line splitter has to do its job.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const record = process.env.FAKE_AGY_ARGV_LOG;
if (record !== undefined) {
  let calls = [];
  try {
    calls = JSON.parse(readFileSync(record, 'utf8'));
  } catch {
    calls = [];
  }
  calls.push({ argv, cwd: process.cwd() });
  writeFileSync(record, JSON.stringify(calls), 'utf8');
}

// `agy models` is a subcommand, not a turn: it prints `<id>\t<display name>`
// after a progress line and exits. Real ids and real display names, copied from
// `agy models` on agy 1.1.11, so a test asserting on the picker is asserting on
// something a user could actually select. The invocation is recorded above like
// any other, which is why the tests filter turns out of the argv log rather than
// pretending this call does not happen.
if (argv[0] === 'models') {
  process.stdout.write(
    'Fetching available models...\n' +
      'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
  );
  process.exit(0);
}

// A turn that continues a conversation replays the plain transcript; a first
// turn replays the one containing a tool call. `FAKE_AGY_FIXTURE` overrides
// both, so a test can pick a recording that exercises a specific wire shape.
const continuing = argv.includes('--conversation');
const fixture =
  process.env.FAKE_AGY_FIXTURE ?? (continuing ? 'turn-plain.ndjson' : 'turn-with-tool.ndjson');
const body = readFileSync(path.join(here, fixture), 'utf8');

for (let offset = 0; offset < body.length; offset += 7) {
  process.stdout.write(body.slice(offset, offset + 7));
}
process.exit(0);
