// Fixture recorder. Checked in so a fixture's provenance is a command anyone can
// re-run, not a claim in a commit message.
//
//   node tests/fixtures/record.mjs                 # list the recordings
//   node tests/fixtures/record.mjs turn-tool-error # re-record one
//
// It writes agy's stdout to `<name>.ndjson` in this directory **verbatim** —
// same bytes, no reformatting, no editing — and prints exit code, byte count and
// md5 so README.md can be updated from real output. See README.md for the
// results of the recordings that are checked in.
//
// Two constraints are deliberate, not incidental:
//   * `--model claude-sonnet-4-6`. Recording without it silently uses whatever
//     default is configured, which makes the fixture unattributable.
//   * `shell: false`. On Windows `shell: true` concatenates argv into one
//     unescaped string; the prompt is shredded at its first space, and
//     `--output-format` goes with it. agy then answers a *different, empty*
//     prompt in plain text and the recording is worthless.
//
// Every recording runs in a scratch sandbox under the OS temp directory, never
// in the repo: these prompts tell agy to run hostile commands and list whatever
// directory it is pointed at.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-sonnet-4-6';

/**
 * Each recording seeds a sandbox, then sends one prompt. The prompts fight two
 * strong habits of the model: checking whether a step will work before running
 * it, and skipping a step it expects to fail. Both produce a turn with no tool
 * steps at all, which records nothing.
 */
const RECORDINGS = {
  // Tools that execute and *then* fail — the `state: "ERROR"` shape, plus the
  // counter-example that a non-zero shell exit is still DONE. Five steps, chosen
  // so that some fail the way we want and some deliberately do not.
  'turn-tool-error': {
    seed: (sandbox) => writeFileSync(path.join(sandbox, 'alpha.txt'), 'hello\n'),
    prompt: () =>
      'Run every one of these five steps with your tools, in this exact order. ' +
      'Do NOT check first whether a step will work, do NOT skip a step because you expect it to fail, ' +
      'and do NOT create or modify any file. I am testing error reporting, so failures are the point.\n' +
      '1. run_command: cmd /c exit 7\n' +
      '2. run_command: cmd /c dir Z:\\no-such-drive-here\n' +
      '3. grep_search for the regular expression [ (a single open square bracket, an invalid regex) in this directory\n' +
      '4. read_url_content on http://127.0.0.1:9/\n' +
      '5. command_status for command id 999999\n' +
      'Then reply with one line per step: the step number and whether the tool errored.',
  },

  // A tool that returns output (the regression that left completed tool cards
  // blank), next to a call agy refuses *before* running it — which emits an
  // `error_message` step and no tool step at all.
  'turn-tool-output': {
    seed: (sandbox) => {
      writeFileSync(path.join(sandbox, 'alpha.txt'), 'hello\n');
      writeFileSync(path.join(sandbox, 'beta.txt'), 'bye\n');
    },
    prompt: (sandbox) =>
      `Do these two things with your tools, in order. 1) List the files in the directory ${sandbox}. ` +
      `2) Read the file ${path.join(sandbox, 'definitely-missing-file.txt')} and tell me exactly what ` +
      'error you got. Do not create any files.',
  },

  // The two below were recorded earlier, before the `--model` convention, and
  // their checked-in bytes therefore came from whatever model agy defaulted to.
  // Their recipes are here so all four fixtures are re-derivable rather than
  // only the two that were re-recorded; re-running them will *not* reproduce the
  // checked-in bytes (see README.md).
  'turn-plain': {
    seed: () => {},
    prompt: () =>
      'Try to read the file ./NOPE_XYZ_123.txt in this directory (it does not exist). ' +
      'Then reply with only the word DONE. Do not create the file, do not investigate further.',
  },

  // Kept because its `list_dir` produced *no* `output` key at all — the shape
  // that hid the dropped-output bug. Note what actually happened, because the
  // seeded files are a red herring: agy resolved "this directory" to its own
  // scratch dir (`~/.gemini/antigravity-cli/scratch`), not to `cwd`, and that
  // directory was empty. Re-running will only reproduce the no-output shape
  // while agy's scratch dir stays empty.
  'turn-with-tool': {
    seed: (sandbox) => {
      writeFileSync(path.join(sandbox, 'alpha.txt'), 'a\n');
      writeFileSync(path.join(sandbox, 'beta.txt'), 'b\n');
    },
    prompt: () =>
      'Use your list_dir tool on this directory, then reply with only the number of entries. ' +
      'Then use your view_file tool on ./MISSING_ZZZ.txt which does not exist, and reply DONE.',
  },
};

const name = process.argv[2];
if (name === undefined || !Object.hasOwn(RECORDINGS, name)) {
  console.error(`usage: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} <name>`);
  console.error(`names: ${Object.keys(RECORDINGS).join(', ')}`);
  process.exit(2);
}

const recording = RECORDINGS[name];
// Fixed name, wiped first: a stale file from a previous run would change what
// `list_dir` reports and quietly make the recording irreproducible.
const sandbox = path.join(os.tmpdir(), `cozypad-agy-fixture-${name}`);
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
recording.seed(sandbox);

const prompt = recording.prompt(sandbox);
const executable = process.platform === 'win32' ? 'agy.exe' : 'agy';
const args = ['-p', prompt, '--output-format', 'stream-json', '--model', MODEL];
const target = path.join(HERE, `${name}.ndjson`);

console.error(`$ ${executable} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
console.error(`  cwd: ${sandbox}`);

const started = Date.now();
const child = spawn(executable, args, {
  cwd: sandbox,
  env: { ...process.env, NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

/** Collected as decoded text: a multi-byte character can straddle a chunk. */
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stderr.write('.');
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.on('close', (code) => {
  writeFileSync(target, stdout, 'utf8');
  const bytes = Buffer.byteLength(stdout, 'utf8');
  const md5 = createHash('md5').update(Buffer.from(stdout, 'utf8')).digest('hex');
  console.error(
    [
      '',
      `exit      ${code}`,
      `elapsed   ${((Date.now() - started) / 1000).toFixed(1)}s`,
      `bytes     ${bytes}`,
      `md5       ${md5}`,
      `written   ${target}`,
      stderr === '' ? 'stderr    (empty)' : `stderr    ${stderr.trimEnd()}`,
      '',
      'Now update README.md with the date, agy --version, and the md5 above.',
    ].join('\n'),
  );
});
