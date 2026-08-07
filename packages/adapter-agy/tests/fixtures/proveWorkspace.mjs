// Live check: WHICH lever actually moves agy's workspace — the process cwd, or
// `--add-dir`? One lever per run, because a run that sets both proves neither.
//
//   node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever add-dir-only
//   node packages/adapter-agy/tests/fixtures/proveWorkspace.mjs --lever cwd-only
//   node .../proveWorkspace.mjs --lever cwd-only --dry-run   # asserts argv, spends nothing
//
// Checked in for the same reason `record.mjs` is: the answer to "does agy honour
// this flag" decides whether the adapter is telling the truth about which
// directory it just answered about, and "I ran it once and it worked" is not
// something a later reader should have to take on faith. Each lever costs one
// real agy call (Sonnet, per docs/ACP-MIGRATION.md's testing convention).
//
// ## Why one lever at a time
//
// `cliTransport.ts` sets BOTH `cwd: request.cwd` and `--add-dir <cwd>`. An
// earlier version of this script did too — it spawned in an empty sibling
// directory *and* passed `--add-dir`, saw the marker file, and concluded
// "`--add-dir` works". That conclusion did not follow from that experiment in
// only one direction: the marker showing up was consistent with `--add-dir`
// working, but the run could not say whether the cwd alone would also have done
// it, and it is the *cwd-only* answer that decides what CozyPad can promise on
// the remote/SSH path, where the spawn cwd may not be ours to set.
//
// So each run disables one lever:
//
//   the-workspace   holds a uniquely-named marker file
//   process-cwd     empty
//
//   --lever add-dir-only   spawn cwd = process-cwd (WRONG), argv has --add-dir the-workspace
//   --lever cwd-only       spawn cwd = the-workspace (RIGHT), argv has NO --add-dir at all
//
// In both cases: marker listed → the lever under test moved the workspace.
//
// ## Why the model is pinned, and pinned through the shipped builder
//
// argv comes from the shipped `buildAgyArgv`, not a copy of it, *including the
// `--model` flag* — which the builder now emits, so this is the configuration
// the adapter really launches rather than an approximation with a flag stapled
// on afterwards. It is pinned to Sonnet rather than left unset because an unset
// model means agy's persisted default, which is whatever the user last picked in
// another tool: an experiment whose model can change between two runs cannot be
// re-run to check a result.
//
// Node 24 strips the types; the hook below only maps the `./x.js` specifiers
// TypeScript emits onto their `.ts` sources.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register(
  `data:text/javascript,
   import { existsSync } from 'node:fs';
   import { fileURLToPath, pathToFileURL } from 'node:url';
   export async function resolve(specifier, context, next) {
     const parent = context.parentURL ?? '';
     if (specifier.startsWith('.') && specifier.endsWith('.js') && parent.endsWith('.ts')) {
       const candidate = fileURLToPath(new URL(specifier, parent)).replace(/\\.js$/, '.ts');
       if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
     }
     return next(specifier, context);
   }`,
  import.meta.url,
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-sonnet-4-6';
const MARKER = 'zorblax-9471-workspace-marker.txt';
const LEVERS = ['add-dir-only', 'cwd-only'];

const leverFlag = process.argv.indexOf('--lever');
const lever = leverFlag === -1 ? 'add-dir-only' : process.argv[leverFlag + 1];
if (!LEVERS.includes(lever)) {
  console.error(`--lever must be one of: ${LEVERS.join(', ')} (got ${String(lever)})`);
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');

const source = path.join(HERE, '..', '..', 'src', 'cliTransport.ts');
if (!existsSync(source)) {
  console.error(`cannot find ${source}`);
  process.exit(2);
}
const { buildAgyArgv } = await import(pathToFileURL(source).href);

const root = mkdtempSync(path.join(os.tmpdir(), 'cozypad-agy-workspace-'));
const workspace = path.join(root, 'the-workspace');
const elsewhere = path.join(root, 'process-cwd');
mkdirSync(workspace);
mkdirSync(elsewhere);
writeFileSync(path.join(workspace, MARKER), 'marker for the workspace-lever proof\n');
writeFileSync(path.join(workspace, 'second-file.md'), '# second\n');

// No path in the prompt. Naming the directory would let agy answer correctly by
// reading an absolute path it was handed, which proves nothing about scope.
const shipped = buildAgyArgv({
  prompt:
    'Use list_dir to list the files in your workspace. ' +
    'Then reply with only the file names you found, one per line, and nothing else.',
  cwd: workspace,
  additionalDirectories: [],
  conversationId: null,
  model: MODEL,
});

/** Drop every `--add-dir <value>` pair, leaving the rest of shipping argv intact. */
function withoutAddDir(argv) {
  const kept = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--add-dir') {
      index += 1;
      continue;
    }
    kept.push(argv[index]);
  }
  return kept;
}

const args = lever === 'cwd-only' ? withoutAddDir(shipped) : shipped;
const spawnCwd = lever === 'cwd-only' ? workspace : elsewhere;

const executable = process.platform === 'win32' ? 'agy.exe' : 'agy';
console.error(`lever                 ${lever}`);
console.error(`$ ${executable} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
console.error(
  `  spawn cwd: ${spawnCwd}   ` +
    (lever === 'cwd-only' ? '(the workspace)' : '(deliberately NOT the workspace)'),
);

// --- assertions on argv, run in both modes -----------------------------------
//
// These used to be absent from `--dry-run` entirely: it printed argv and then
// called `process.exit(0)` unconditionally, so its exit code said "fine" no
// matter what the builder had produced — including a build that emitted no
// `--add-dir` at all, which is the exact defect the live run exists to detect.
const problems = [];
const addDirIndex = args.indexOf('--add-dir');
if (lever === 'add-dir-only') {
  if (addDirIndex === -1) problems.push('argv carries no --add-dir');
  else if (args[addDirIndex + 1] !== workspace) {
    problems.push(`--add-dir is ${JSON.stringify(args[addDirIndex + 1])}, expected the workspace`);
  }
  if (args.filter((a) => a === '--add-dir').length !== 1) {
    problems.push('expected exactly one --add-dir');
  }
  if (spawnCwd === workspace) problems.push('spawn cwd must NOT be the workspace for this lever');
} else {
  if (addDirIndex !== -1) problems.push('argv still carries --add-dir; the lever is not isolated');
  if (spawnCwd !== workspace) problems.push('spawn cwd must be the workspace for this lever');
}
const modelIndex = args.indexOf('--model');
if (modelIndex === -1 || args[modelIndex + 1] !== MODEL) {
  problems.push(`argv does not pin --model ${MODEL}; buildAgyArgv must emit it`);
}
if (!args.includes('--output-format') || !args.includes('stream-json')) {
  problems.push('argv lost --output-format stream-json');
}

if (problems.length > 0) {
  console.error(`\nARGV ASSERTIONS FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.error('argv assertions       ok');

if (dryRun) {
  console.error('\n--dry-run: agy was not spawned. Exit code reflects the argv assertions above.');
  process.exit(0);
}

let stdout = '';
let stderr = '';
const child = spawn(executable, args, {
  cwd: spawnCwd,
  env: { ...process.env, NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
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
  const events = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  const tools = events
    .filter((e) => e.event === 'step_update' && e.step_update?.step_type === 'tool')
    .map((e) => ({
      state: e.step_update.state,
      tool: e.step_update.tool_name,
      parameters: e.step_update.tool_info?.parameters,
      output: e.step_update.tool_info?.output,
    }));
  const init = events.find((e) => e.event === 'init');
  const result = events.find((e) => e.event === 'result')?.result;

  const sawMarker =
    (result?.response ?? '').includes(MARKER) ||
    tools.some((step) => (step.output ?? '').includes(MARKER));
  const toolTouchedWorkspace = tools.some((step) =>
    JSON.stringify(step.parameters ?? {}).includes(JSON.stringify(workspace).slice(1, -1)),
  );

  console.error(
    [
      '',
      `lever                 ${lever}`,
      `exit                  ${code}`,
      `result.status         ${result?.status}`,
      `init.cwd              ${init?.init?.cwd}`,
      `init.permission_mode  ${init?.init?.permission_mode}`,
      `tool steps            ${JSON.stringify(tools, null, 2)}`,
      `response              ${JSON.stringify(result?.response)}`,
      stderr === '' ? 'stderr                (empty)' : `stderr                ${stderr.trimEnd()}`,
      '',
      `marker file seen               ${sawMarker}`,
      `tool ran inside the workspace  ${toolTouchedWorkspace}`,
      '',
      sawMarker
        ? `VERDICT: ${lever} moves agy's workspace.`
        : `VERDICT: ${lever} does NOT move agy's workspace on this agy build.`,
    ].join('\n'),
  );
  process.exitCode = sawMarker ? 0 : 1;
});
