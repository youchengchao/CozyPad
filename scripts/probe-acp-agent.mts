/**
 * Drive a real ACP agent through packages/acp-client and record what happens.
 *
 * One code path for every agent — that is the claim this migration rests on, so
 * the probe deliberately special-cases nothing but the spawn line.
 *
 * Usage: tsx probe-agents.mts <claude|codex> [prompt]
 *
 * Safety rules enforced here, each from a real incident:
 *  - `shell: false`. On Windows the shell concatenates argv into one unescaped
 *    string; a prompt with a space is shredded and the agent answers a
 *    different question in plain text.
 *  - Spawned as `node <dist/index.js>`, never through the `.CMD` shim, which
 *    would require a shell.
 *  - The agent is IDENTIFIED from its own initialize/model list BEFORE any
 *    prompt is sent. An earlier run reached the wrong agent through a CLI
 *    default and spent the user's paid quota.
 *  - Claude is pinned to Sonnet, and a match on /opus/ aborts. Standing rule.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectAcpAgentProcess } from '../packages/acp-client/src/index';

const require = createRequire('file:///D:/CozyPad/');

interface AgentSpec {
  /** An npm package whose `bin` is the agent, or a local entry file. */
  readonly package?: string;
  readonly localEntry?: string;
  readonly label: string;
  readonly wantModel: RegExp | null;
  readonly forbidModel: RegExp | null;
}

const AGENTS: Record<string, AgentSpec> = {
  claude: {
    package: '@zed-industries/claude-agent-acp',
    label: 'claude-agent-acp',
    wantModel: /sonnet/i,
    forbidModel: /opus/i,
  },
  codex: {
    package: '@agentclientprotocol/codex-acp',
    label: 'codex-acp',
    wantModel: null,
    forbidModel: null,
  },
  // Ours. Same client, same protocol, same probe — only the spawn line differs,
  // which is the entire claim being tested.
  agy: {
    localEntry: fileURLToPath(new URL('./agy-acp-entry.mts', import.meta.url)),
    label: 'adapter-agy',
    wantModel: /sonnet/i,
    forbidModel: /opus/i,
  },
};

const which = process.argv[2] ?? '';
const spec = AGENTS[which];
if (!spec) {
  console.error(`usage: tsx probe-agents.mts <${Object.keys(AGENTS).join('|')}> [prompt]`);
  process.exit(2);
}
const PROMPT = process.argv[3] ?? 'Reply with exactly: OK';

// A local TypeScript entry needs tsx; a published agent is plain JS and is run
// by node directly. Either way the argv is built as an array — `shell: true`
// would concatenate it into one unescaped string on Windows.
let command = process.execPath;
let entry: string;
if (spec.localEntry !== undefined) {
  entry = spec.localEntry;
  command = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
} else {
  const pkgJson = require(`${spec.package}/package.json`) as {
    bin: string | Record<string, string>;
  };
  entry = path.join(
    path.dirname(require.resolve(`${spec.package}/package.json`)),
    typeof pkgJson.bin === 'string' ? pkgJson.bin : Object.values(pkgJson.bin)[0]!,
  );
}
const argv = command === process.execPath ? [entry] : [command, entry];
const exe = process.execPath;

const OUT = 'D:/CozyPad/.probe/out';  // gitignored: real transcripts, real quota
mkdirSync(OUT, { recursive: true });
const WORKSPACE = path.join(OUT, `ws-${which}`);
mkdirSync(WORKSPACE, { recursive: true });

const log = (...a: unknown[]): void => console.error('[probe]', ...a);
log('agent :', spec.label);
log('entry :', entry);

log('argv  :', JSON.stringify([exe, ...argv]));
const child = spawn(exe, argv, {
  cwd: WORKSPACE,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env, NO_COLOR: '1' },
});

const stderrTail: string[] = [];
child.stderr!.setEncoding('utf8');
child.stderr!.on('data', (chunk: string) => {
  stderrTail.push(chunk);
  if (stderrTail.length > 80) stderrTail.shift();
});

const updates: unknown[] = [];
const permissionRequests: unknown[] = [];

const handle = connectAcpAgentProcess({
  child: child as never,
  label: spec.label,
  handlers: {
    onSessionUpdate: (event: never) => {
      updates.push(event);
      const raw = event as unknown as Record<string, never>;
      const update = (raw['update'] ?? raw) as Record<string, never>;
      const kind = String(update['sessionUpdate'] ?? raw['kind'] ?? '(?)');
      const content = update['content'] as { text?: string } | undefined;
      const text = content?.text ?? (update['title'] as string | undefined) ?? '';
      log(`  <- ${kind}${text ? ': ' + JSON.stringify(text.slice(0, 90)) : ''}`);
    },
    requestPermission: async (request: never) => {
      permissionRequests.push(request);
      log('  ! agent asked permission:', JSON.stringify(request).slice(0, 160));
      // "Say OK" needs no tools, so anything asking here is a surprise worth
      // seeing. Refused rather than rubber-stamped.
      return { outcome: { outcome: 'cancelled' } } as never;
    },
  },
  timeouts: { default: 60_000, prompt: 180_000 },
  onStall: (event) => log('  ... stalled:', event.method, event.reason),
});

const record: Record<string, unknown> = { agent: spec.label, entry, prompt: PROMPT };

try {
  log('-> initialize');
  const init = await handle.initialize();
  record['initialize'] = init;
  log('   protocolVersion  =', init.protocolVersion);
  log('   authMethods      =', JSON.stringify((init.authMethods ?? []).map((m) => m.id)));
  log('   agentCapabilities=', JSON.stringify(init.agentCapabilities ?? {}).slice(0, 240));

  log('-> session/new  cwd =', WORKSPACE);
  const session = await handle.newSession({ cwd: WORKSPACE, mcpServers: [] });
  record['newSession'] = session;
  const sessionId = session.sessionId;
  log('   sessionId =', sessionId);

  const options = ((session as unknown as Record<string, unknown>)['configOptions'] ??
    []) as Array<Record<string, never>>;
  record['configOptions'] = options;
  const modelOption = options.find((o) => o['id'] === 'model' || o['configId'] === 'model');
  if (modelOption) {
    const choices = (modelOption['options'] ?? []) as Array<Record<string, unknown>>;
    record['modelChoices'] = choices;
    log('   model options:', JSON.stringify(choices.map((c) => c['optionId'] ?? c['id'] ?? c['value'])).slice(0, 400));
    if (spec.wantModel) {
      const pick = choices.find((c) => spec.wantModel!.test(JSON.stringify(c)));
      if (!pick) throw new Error(`no model matching ${spec.wantModel} — refusing to run on an unknown model`);
      if (spec.forbidModel?.test(JSON.stringify(pick))) {
        throw new Error(`picked model looks forbidden: ${JSON.stringify(pick)}`);
      }
      const id = String(pick['optionId'] ?? pick['id'] ?? pick['value']);
      log('-> session/set_config_option model =', id);
      record['setModel'] = await handle.setSessionConfigOption({
        sessionId,
        configId: 'model',
        value: id,
      });
      record['pinnedModel'] = id;
    }
  } else {
    log('   (no model config option advertised)');
  }

  log('-> session/prompt', JSON.stringify(PROMPT));
  const started = Date.now();
  const reply = await handle.prompt({
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  });
  record['promptMs'] = Date.now() - started;
  record['promptResponse'] = reply;
  log('   stopReason =', reply.stopReason, `(${record['promptMs']}ms)`);

  record['updates'] = updates;
  record['updateKinds'] = updates.map((e) => {
    const raw = e as Record<string, never>;
    const update = (raw['update'] ?? raw) as Record<string, never>;
    return String(update['sessionUpdate'] ?? raw['kind'] ?? '(?)');
  });
  record['permissionRequests'] = permissionRequests;
  record['ok'] = true;
  log('OK:', (record['updateKinds'] as string[]).length, 'updates,', permissionRequests.length, 'permission requests');
} catch (error) {
  record['ok'] = false;
  record['error'] = { name: (error as Error)?.name, message: String((error as Error)?.message ?? error) };
  record['updates'] = updates;
  log('FAILED:', (error as Error)?.name, String((error as Error)?.message ?? error).slice(0, 500));
} finally {
  record['stderrTail'] = stderrTail.join('').slice(-4000);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const file = path.join(OUT, `${which}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  log('record ->', file);
  process.exit(record['ok'] ? 0 : 1);
}
