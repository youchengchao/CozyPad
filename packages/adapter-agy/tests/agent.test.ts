/**
 * The ACP surface, driven by a scripted transport. No agy is spawned.
 */
import {
  PROTOCOL_VERSION,
  type AgentSideConnection,
  type ContentBlock,
  type PromptCapabilities,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGY_CONVERSATION_META_KEY,
  AGY_CONVERSATION_META_KEY_LEGACY,
  AGY_LIMITATIONS,
  AGY_LIMITATIONS_META_KEY,
  AGY_MODEL_CATALOG_TTL_MS,
  AGY_MODEL_CONFIG_ID,
  AGY_MODEL_META_KEY,
  AGY_MODEL_UNPINNED_VALUE,
  AGY_PERMISSION_MODE_ID,
  AGY_RESUME_META_KEY,
  AgyAgent,
  flattenPrompt,
  looksLikeAgyConversationId,
  readConversationMeta,
  readModelMeta,
  resourceLinkPath,
} from '../src/agent.js';
import type {
  AgyModelCatalog,
  AgyTransport,
  AgyTurnEvent,
  AgyTurnRequest,
} from '../src/transport.js';

/**
 * A real agy conversation id shape — a UUID. Tests used to invent ids like
 * `conv-restored`, which is precisely the string `session/resume` now refuses:
 * agy has never minted anything but UUIDs (214/214 files in
 * `~/.gemini/antigravity-cli/conversations/`, and every recorded fixture).
 */
const CONV_A = '11111111-2222-4333-8444-555555555555';
const CONV_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/** Records what the agent sends up to the client. */
function fakeConnection() {
  const notifications: SessionNotification[] = [];
  const connection = {
    async sessionUpdate(params: SessionNotification) {
      notifications.push(params);
    },
  } as unknown as AgentSideConnection;
  return { connection, notifications };
}

/**
 * The model catalog every scripted transport reports unless a test says
 * otherwise. Two real agy ids and the real display names, so an assertion about
 * the picker is an assertion about something a user could actually select.
 */
const CATALOG: AgyModelCatalog = {
  models: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
  ],
  persistedDefault: { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
  diagnostics: [],
};

/** A transport that replays a fixed script and records what it was asked for. */
function scriptedTransport(
  script: AgyTurnEvent[] | ((request: AgyTurnRequest) => AgyTurnEvent[]),
  catalog: AgyModelCatalog = CATALOG,
) {
  const requests: AgyTurnRequest[] = [];
  let modelListCalls = 0;
  const transport: AgyTransport = {
    kind: 'cli',
    async listModels() {
      modelListCalls += 1;
      return catalog;
    },
    runTurn(request) {
      requests.push(request);
      const events = typeof script === 'function' ? script(request) : script;
      return (async function* replay() {
        for (const event of events) yield event;
      })();
    },
    async dispose() {},
  };
  return { transport, requests, modelListCalls: () => modelListCalls };
}

/** The `model` select out of a `configOptions` list, as a select. */
function modelOption(configOptions: SessionConfigOption[] | null | undefined) {
  const found = configOptions?.find((option) => option.id === AGY_MODEL_CONFIG_ID);
  expect(found).toBeDefined();
  expect(found?.type).toBe('select');
  return found as Extract<SessionConfigOption, { type: 'select' }>;
}

function agentWith(transport: AgyTransport, modelCatalogTtlMs?: number) {
  const { connection, notifications } = fakeConnection();
  const logged: string[] = [];
  let counter = 0;
  const agent = new AgyAgent(connection, {
    transport,
    logger: (message) => logged.push(message),
    newSessionId: () => `agy-test-${++counter}`,
    ...(modelCatalogTtlMs === undefined ? {} : { modelCatalogTtlMs }),
  });
  return { agent, notifications, logged };
}

/** A transport whose catalog the test can change between calls, as agy's does. */
function mutableCatalogTransport(initial: AgyModelCatalog) {
  let catalog = initial;
  let calls = 0;
  const transport: AgyTransport = {
    kind: 'cli',
    async listModels() {
      calls += 1;
      return catalog;
    },
    runTurn() {
      return (async function* replay() {
        yield { type: 'end', stopReason: 'end_turn' } as const;
      })();
    },
    async dispose() {},
  };
  return {
    transport,
    calls: () => calls,
    setCatalog: (next: AgyModelCatalog) => {
      catalog = next;
    },
  };
}

const textUpdate = (text: string): AgyTurnEvent => ({
  type: 'update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

describe('flattenPrompt', () => {
  it('joins text blocks', () => {
    expect(
      flattenPrompt([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]).text,
    ).toBe('first\nsecond');
  });

  it('keeps resource_link blocks — they are baseline content, not an opt-in', () => {
    // The D3 defect. The official schema makes Text and ResourceLink the two
    // content types every agent must accept; `promptCapabilities` gates only
    // image, audio and embedded resources. Keeping just `type === 'text'`
    // measured 4 blocks in, two file references gone, no error, no diagnostic,
    // `stopReason: end_turn` — and agy answering confidently about files it had
    // never been shown.
    const uri = pathToFileURL(path.resolve('/', 'proj', 'src', 'main.ts')).href;
    const flattened = flattenPrompt([
      { type: 'text', text: 'explain this' },
      { type: 'resource_link', name: 'main.ts', uri },
    ]);
    expect(flattened.text).toContain('explain this');
    expect(flattened.text).toContain('main.ts');
    expect(flattened.text).toContain(path.resolve('/', 'proj', 'src', 'main.ts'));
    // And the file is made readable, not merely mentioned.
    expect(flattened.directories).toEqual([path.resolve('/', 'proj', 'src')]);
    expect(flattened.diagnostics).toEqual([]);
  });

  it('does not add the same directory twice for two files that share one', () => {
    const dir = path.resolve('/', 'proj');
    const flattened = flattenPrompt([
      { type: 'resource_link', name: 'a.ts', uri: pathToFileURL(path.join(dir, 'a.ts')).href },
      { type: 'resource_link', name: 'b.ts', uri: pathToFileURL(path.join(dir, 'b.ts')).href },
    ]);
    expect(flattened.directories).toEqual([dir]);
  });

  it('surfaces a non-file resource_link as text and says why it got no root', () => {
    const flattened = flattenPrompt([
      { type: 'resource_link', name: 'spec', uri: 'https://example.com/spec' },
    ]);
    expect(flattened.text).toContain('https://example.com/spec');
    expect(flattened.directories).toEqual([]);
    // Not represented as a workspace root — so it is reported, never silent.
    expect(flattened.diagnostics).toHaveLength(1);
    expect(flattened.diagnostics[0]).toContain('https://example.com/spec');
  });

  it('rejects content it cannot represent instead of dropping it', () => {
    // image/audio/embeddedContext are all advertised false at initialize, so a
    // client sending one is contradicting what it was told. -32602 is a failure
    // it can see; the old behaviour was to delete the block and answer anyway.
    const attempt = () =>
      flattenPrompt([
        { type: 'text', text: 'first' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ]);
    expect(attempt).toThrow(/image/);
    expect(attempt).toThrow(/Invalid params/);
    expect((() => {
      try {
        attempt();
      } catch (error) {
        return (error as { code?: number }).code;
      }
      return undefined;
    })()).toBe(-32602);
  });
});

/**
 * Every `promptCapabilities` flag, held to what the code actually does.
 *
 * The negative capabilities were pinned; the positive ones were not, and the
 * asymmetry is the whole defect. Flipping `image: false` to `true` at
 * `initialize` passed the entire suite — while `flattenPrompt` went on
 * rejecting image blocks with `-32602`. The test above is why that was
 * possible: it hard-codes the image case and never reads what was advertised,
 * so it agrees with the implementation no matter what the handshake claims.
 *
 * **Advertising something we do not implement is the same defect this migration
 * has been chasing all along**, pointed the other way. `loadSession: true` was
 * exactly this — a capability asserted at `initialize`, believed by a
 * third-party client, and answered with an error code when called; that client
 * exited 4. A `promptCapabilities.image: true` we do not honour costs a user
 * more, not less: the client adapts its interface to what it was told, offers
 * an attach-image button because the spec says it MUST, and the failure lands
 * on the person who used it.
 *
 * So the assertion below is a **biconditional**, and it is deliberately not
 * `expect(image).toBe(false)`. Pinning the literal would freeze the answer and
 * fail the day somebody genuinely implements images. What must hold is that the
 * two agree — whatever we advertise, `flattenPrompt` does. Implement image
 * support and flip the flag, and this test goes green on its own.
 */
describe('promptCapabilities say what flattenPrompt actually accepts', () => {
  /**
   * One minimal block per gated capability, keyed by the flag that gates it.
   *
   * `Exclude<keyof PromptCapabilities, '_meta'>` on purpose: the key set comes
   * from the SDK's own type, so a capability added by a future protocol release
   * makes this table **fail to compile** rather than quietly going untested —
   * which is the only way a list like this stays honest.
   */
  const GATED: Record<
    Exclude<keyof PromptCapabilities, '_meta'>,
    ContentBlock
  > = {
    image: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    audio: { type: 'audio', data: 'UklGRiQAAABXQVZF', mimeType: 'audio/wav' },
    embeddedContext: {
      type: 'resource',
      resource: {
        uri: 'file:///proj/notes.md',
        mimeType: 'text/markdown',
        text: '# notes',
      },
    },
  };

  async function advertisedCapabilities(): Promise<PromptCapabilities> {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return response.agentCapabilities?.promptCapabilities ?? {};
  }

  for (const [capability, block] of Object.entries(GATED) as Array<
    [Exclude<keyof PromptCapabilities, '_meta'>, ContentBlock]
  >) {
    it(`means it when it advertises ${capability}`, async () => {
      const capabilities = await advertisedCapabilities();
      // Absent reads as `false` to a client, so it is graded as `false` here —
      // but this agent writes all three out explicitly, and the assertion
      // after the branch is what keeps it doing so.
      const claimed = capabilities[capability] === true;

      if (claimed) {
        // We told the client to send these. A client that obeys must not be
        // answered with `-32602` for doing what it was told.
        expect(() => flattenPrompt([block])).not.toThrow();
      } else {
        // We told the client not to. If one arrives anyway it must be refused
        // out loud — the one thing that must never happen is the silent drop.
        expect(() => flattenPrompt([block])).toThrow(/Invalid params/);
      }
    });
  }

  it('writes every gated flag out explicitly rather than leaving it absent', async () => {
    // Same reasoning as `loadSession: false` above: absent and `false` mean the
    // same thing on the wire, and spelling it out is what makes the handshake
    // readable in a protocol log — and what makes the table above grade a real
    // claim rather than a missing key.
    const capabilities = await advertisedCapabilities();
    for (const capability of Object.keys(GATED)) {
      expect(typeof capabilities[capability as keyof PromptCapabilities]).toBe(
        'boolean',
      );
    }
  });
});

describe('resourceLinkPath', () => {
  it('resolves a file: URI to a local path', () => {
    const file = path.resolve('/', 'proj', 'a b.txt');
    expect(resourceLinkPath(pathToFileURL(file).href)).toBe(file);
  });

  it('accepts a bare absolute path, which clients do send', () => {
    const file = path.resolve('/', 'proj', 'a.txt');
    expect(resourceLinkPath(file)).toBe(file);
  });

  it('refuses a non-file URI rather than treating it as a path', () => {
    expect(resourceLinkPath('https://example.com/x')).toBeNull();
    expect(resourceLinkPath('zed://agent/thing')).toBeNull();
  });

  it('refuses a relative path — there is nothing to resolve it against', () => {
    expect(resourceLinkPath('src/main.ts')).toBeNull();
  });
});

describe('initialize', () => {
  it('advertises resume, not loadSession — resume is what it implements', async () => {
    // D1/D2. `session/load` must stream the whole conversation history back;
    // agy print mode cannot replay a transcript and this adapter replayed zero
    // notifications, so a third-party client that believed `loadSession: true`
    // called `session/load`, got -32002, and exited 4.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentCapabilities?.loadSession).toBe(false);
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    // agy logs in out of band, so the client is offered no auth methods.
    expect(response.authMethods).toEqual([]);
  });

  it('advertises additionalDirectories, which it now actually honours', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(response.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
  });

  it('tells the client its permission policy will never be consulted', async () => {
    // D7. ACP has no negative capability, and silence reads as "never needed to
    // ask" — which is how a third-party client's --deny-all ran against us with
    // no effect and no complaint. `request_permission` appears 0 times in 23
    // recorded transcripts, including turns where agy really executed list_dir.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const limits = response.agentCapabilities?._meta?.[AGY_LIMITATIONS_META_KEY] as {
      requestsPermission?: boolean;
      permissionMode?: string;
      replaysHistory?: boolean;
      detail?: string;
    };
    expect(limits.requestsPermission).toBe(false);
    expect(limits.permissionMode).toBe(AGY_PERMISSION_MODE_ID);
    expect(limits.replaysHistory).toBe(false);
    expect(limits.detail).toMatch(/always-proceed/);
  });

  it('says the workspace roots do not confine agy, because nothing tested that', async () => {
    // J3. `--add-dir` was measured for INCLUSION — "can agy find the directory
    // we named" — and the result was then written up as scoping. CONFINEMENT was
    // never measured, and the recording in tests/fixtures/turn-tool-error.ndjson
    // is evidence against it: one turn in which agy ran
    // `cmd /c dir Z:\no-such-drive-here`, grepped its own scratch directory and
    // fetched http://127.0.0.1:9/, none of them under the workspace, with no
    // permission request the client could have refused. Silence in ACP reads as
    // a guarantee, so the negative is stated.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const limits = response.agentCapabilities?._meta?.[AGY_LIMITATIONS_META_KEY] as {
      confinesToWorkspace?: boolean;
      pinSurvivesResume?: boolean;
      pinRestoreMetaKey?: string;
      workspaceDetail?: string;
    };
    expect(limits.confinesToWorkspace).toBe(false);
    expect(limits.pinSurvivesResume).toBe(false);
    // Told as an instruction, not just a complaint: this is the key to send back.
    expect(limits.pinRestoreMetaKey).toBe('cozypad.dev/agy-model');
    expect(limits.workspaceDetail).toMatch(/not.*sandbox|never as a sandbox/i);
  });

  it('answers with the latest version it speaks when asked for one it does not', async () => {
    // D6. `Math.min(client, PROTOCOL_VERSION)` cannot express "I do not speak
    // that": asked for 0 it answered 0, claiming a wire format this build has
    // never emitted, and the client had no reason to disconnect.
    const { agent, logged } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({ protocolVersion: 0, clientCapabilities: {} });
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(logged.join('\n')).toMatch(/protocol_version/);
  });

  it('echoes a version it does speak', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('session modes', () => {
  it('opens every session in the one mode agy has: no approval', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(session.modes?.currentModeId).toBe(AGY_PERMISSION_MODE_ID);
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual([
      AGY_PERMISSION_MODE_ID,
    ]);
    expect(session.modes?.availableModes[0]?.description).toMatch(/always-proceed/);
  });

  it('accepts the mode it advertised', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await expect(
      agent.setSessionMode({ sessionId, modeId: AGY_PERMISSION_MODE_ID }),
    ).resolves.toEqual({});
  });

  it('refuses a mode that would imply approval it cannot perform', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await expect(agent.setSessionMode({ sessionId, modeId: 'ask' })).rejects.toMatchObject({
      code: -32602,
    });
  });
});

describe('readModelMeta', () => {
  // P1 at the unit. ACP types `_meta` as `{ type: ['object','null'],
  // additionalProperties: true }`, so no schema validator can say anything about
  // what is inside it — a clean schema check is not evidence about any of these
  // cases, and hand-forged blocks pass it. Only these assertions cover them.

  it('separates "the client said nothing" from "the client said do not pin"', () => {
    expect(readModelMeta(undefined)).toEqual({ kind: 'absent' });
    expect(readModelMeta(null)).toEqual({ kind: 'absent' });
    expect(readModelMeta({})).toEqual({ kind: 'absent' });
    // The block this adapter itself emits for an unpinned session, and the one
    // AGY_LIMITATIONS.pinRestoreMetaKey tells clients to persist. It used to come
    // back as the same `null` as an absent key, and a `??` chain then resolved it
    // into whatever pin the process was holding.
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { pinned: false, modelId: null } })).toEqual({
      kind: 'unpinned',
    });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { modelId: AGY_MODEL_UNPINNED_VALUE } })).toEqual({
      kind: 'unpinned',
    });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: AGY_MODEL_UNPINNED_VALUE })).toEqual({
      kind: 'unpinned',
    });
    // `pinned: false` on its own is still a statement, even without a modelId.
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { pinned: false } })).toEqual({
      kind: 'unpinned',
    });
  });

  it('reads a pin from either shape a client could have stored', () => {
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: 'claude-sonnet-4-6' })).toEqual({
      kind: 'pinned',
      modelId: 'claude-sonnet-4-6',
    });
    expect(
      readModelMeta({ [AGY_MODEL_META_KEY]: { pinned: true, modelId: 'claude-sonnet-4-6' } }),
    ).toEqual({ kind: 'pinned', modelId: 'claude-sonnet-4-6' });
  });

  it('lets modelId outrank pinned, because only modelId reaches argv', () => {
    // The forged shape: `pinned: true` with nothing to pin to. Reading the flag
    // instead of the id would send this straight back down the P1 path.
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { pinned: true, modelId: null } })).toEqual({
      kind: 'unpinned',
    });
  });

  it('treats what it cannot read as absent, never as an instruction to unpin', () => {
    // Garbage must not be able to drop a pin. Falling back to the in-process pin
    // is at least attributable — the resume report calls it `in-process`.
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: null })).toEqual({ kind: 'absent' });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: 42 })).toEqual({ kind: 'absent' });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: [] })).toEqual({ kind: 'absent' });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: '' })).toEqual({ kind: 'absent' });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { modelId: 42 } })).toEqual({ kind: 'absent' });
    expect(readModelMeta({ [AGY_MODEL_META_KEY]: { pinned: 'yes' } })).toEqual({ kind: 'absent' });
  });
});

describe('model selection', () => {
  // F1. `buildAgyArgv` never emitted `--model`, so every turn ran on whatever
  // `~/.gemini/antigravity-cli/settings.json` held — `Gemini 3.6 Flash (Low)` on
  // the machine this was measured on, while every fixture in this package was
  // recorded on Sonnet. A third-party client had no field to ask with and this
  // adapter had none to read. ACP's answer is a `category: "model"` select
  // returned from `session/new` plus `session/set_config_option`.

  it('offers the models agy lists, as an ACP config option', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const option = modelOption(session.configOptions);
    expect(option.category).toBe('model');
    expect(option.options.map((entry) => ('value' in entry ? entry.value : entry.group))).toEqual([
      AGY_MODEL_UNPINNED_VALUE,
      'claude-sonnet-4-6',
      'gemini-3.6-flash-low',
    ]);
  });

  it('starts unpinned, and says which model that actually means', async () => {
    // The state that used to be invisible. `currentValue` is a real selectable
    // value rather than an absent field, and the name of the model agy would
    // silently use is in the option the client renders.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const option = modelOption(session.configOptions);
    expect(option.currentValue).toBe(AGY_MODEL_UNPINNED_VALUE);
    const unpinned = option.options[0] as { name: string };
    expect(unpinned.name).toContain('Gemini 3.6 Flash (Low)');
    expect(session._meta?.[AGY_MODEL_META_KEY]).toMatchObject({
      pinned: false,
      modelId: null,
      agySavedDefault: { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
    });
  });

  it('sends no --model until one is chosen, rather than resolving the default itself', async () => {
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    // `null`, not 'gemini-3.6-flash-low'. Filling it in here would make the turn
    // look pinned while argv still carried no flag — and would silently change
    // which model runs if agy's own default and its settings file disagreed.
    expect(requests[0]?.model).toBeNull();
  });

  it('passes the chosen model to every later turn', async () => {
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const set = await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    expect(modelOption(set.configOptions).currentValue).toBe('claude-sonnet-4-6');

    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] });
    expect(requests.map((request) => request.model)).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(agent.modelFor(sessionId)).toBe('claude-sonnet-4-6');
  });

  it('reports the model on every prompt response, pinned or not', async () => {
    // A result whose model is unrecorded cannot be compared with a later one,
    // and neither ACP nor agy's own wire output names it anywhere else.
    const { transport } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });

    const unpinned = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(unpinned._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: false, modelId: null });

    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    const pinned = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'y' }] });
    expect(pinned._meta?.[AGY_MODEL_META_KEY]).toMatchObject({
      pinned: true,
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('can be put back to unpinned, and says what that means again', async () => {
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: AGY_MODEL_UNPINNED_VALUE,
    });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBeNull();
  });

  it('refuses a model agy does not offer, instead of putting it in argv', async () => {
    // Accepting it costs a spawn and ~5s, and the reason ends up in agy's
    // stderr where no client sees it.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const failure = await agent
      .setSessionConfigOption({ sessionId, configId: AGY_MODEL_CONFIG_ID, value: 'gpt-5' })
      .then(() => null, (error: unknown) => error as { code?: number; message?: string });
    expect(failure?.code).toBe(-32602);
    expect(failure?.message).toContain('claude-sonnet-4-6');
    expect(agent.modelFor(sessionId)).toBeNull();
  });

  it('refuses a config option it never advertised', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await expect(
      agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('refuses a config option for a session it does not have', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    await expect(
      agent.setSessionConfigOption({
        sessionId: 'agy-never',
        configId: AGY_MODEL_CONFIG_ID,
        value: 'claude-sonnet-4-6',
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it('offers only the unpinned value when agy could not be asked, and says why', async () => {
    // A transport that cannot list models must not advertise a picker that
    // cannot work — the same rule as the single session mode. The reason
    // travels with the option instead of dying in a log.
    const { transport } = scriptedTransport([], {
      models: [],
      persistedDefault: null,
      diagnostics: ['`agy.exe models` exited with code 1'],
    });
    const { agent } = agentWith(transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const option = modelOption(session.configOptions);
    expect(option.options).toHaveLength(1);
    expect(option._meta?.catalogDiagnostics).toEqual(['`agy.exe models` exited with code 1']);
    await expect(
      agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: AGY_MODEL_CONFIG_ID,
        value: 'claude-sonnet-4-6',
      }),
    ).rejects.toThrow(/could not retrieve agy's model list/);
  });

  it('says a missing catalog is temporary, in the same words on both paths', async () => {
    // P6. `setSessionConfigOption` still said "no model can be pinned in this
    // process" — restart-required phrasing left behind by the round-8 fix that
    // made it untrue, since a failed `agy models` is retried and the very same
    // session can pin a model seconds later. `resumeSession` already said "right
    // now". Two messages about one state must not disagree about whether the
    // user has to restart anything.
    const empty: AgyModelCatalog = {
      models: [],
      persistedDefault: null,
      diagnostics: ['`agy.exe models` exited with code 1'],
    };
    const { transport } = scriptedTransport([], empty);
    const { agent } = agentWith(transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });

    const fromConfig = await agent
      .setSessionConfigOption({
        sessionId: session.sessionId,
        configId: AGY_MODEL_CONFIG_ID,
        value: 'claude-sonnet-4-6',
      })
      .then(() => null, (error: unknown) => error as { message?: string });
    const fromResume = await agent
      .resumeSession({
        sessionId: CONV_A,
        cwd: '/w',
        mcpServers: [],
        _meta: { [AGY_MODEL_META_KEY]: { modelId: 'claude-sonnet-4-6' } },
      })
      .then(() => null, (error: unknown) => error as { message?: string });

    expect(fromConfig?.message).toMatch(/pinned right now/);
    expect(fromResume?.message).toMatch(/pinned right now/);
    expect(fromConfig?.message).not.toMatch(/in this process/);
    expect(fromResume?.message).not.toMatch(/in this process/);
  });

  it('opens a usable session even when the transport throws listing models', async () => {
    const transport: AgyTransport = {
      kind: 'cli',
      async listModels() {
        throw new Error('agy is not logged in');
      },
      runTurn() {
        return (async function* replay() {
          yield { type: 'end', stopReason: 'end_turn' } as const;
        })();
      },
      async dispose() {},
    };
    const { agent, logged } = agentWith(transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(modelOption(session.configOptions).options).toHaveLength(1);
    expect(logged.join('\n')).toContain('agy is not logged in');
    // And the session still runs turns — a missing picker is not a dead session.
    const turn = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    });
    expect(turn.stopReason).toBe('end_turn');
  });

  it('asks the transport for the catalog once, however many sessions open', async () => {
    const { transport, modelListCalls } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const first = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(modelListCalls()).toBe(1);
  });

  it('two sessions opened at once still cost one catalog call', async () => {
    // The retry added for J2 must not become a call per request: a usable
    // catalog is still cached, and concurrent openers share the in-flight call.
    const { transport, modelListCalls } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const [first] = await Promise.all([
      agent.newSession({ cwd: '/w', mcpServers: [] }),
      agent.newSession({ cwd: '/w', mcpServers: [] }),
    ]);
    await agent.setSessionConfigOption({
      sessionId: first.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    expect(modelListCalls()).toBe(1);
  });

  it('re-asks the transport once its own catalog entry is stale', async () => {
    // P2. The agent-level cache had no expiry and is the only production caller
    // of `transport.listModels()`, so one successful `agy models` froze the model
    // list for the life of the process — and the transport's stale-while-
    // revalidate path became unreachable code that its own test still passed on.
    // A model agy retires upstream then stays in the picker, is accepted by
    // set_config_option, reaches argv, and fails inside agy seconds later.
    const retired: AgyModelCatalog = {
      models: [{ id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }],
      persistedDefault: { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
      diagnostics: [],
    };
    const { transport, calls, setCatalog } = mutableCatalogTransport(CATALOG);
    const { agent } = agentWith(transport, 1);

    const first = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(modelOption(first.configOptions).options).toHaveLength(3);
    expect(calls()).toBe(1);

    // agy retires a model. Nothing restarts.
    setCatalog(retired);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(calls()).toBeGreaterThan(1);
    expect(
      modelOption(second.configOptions).options.map((entry) =>
        'value' in entry ? entry.value : entry.group,
      ),
    ).toEqual([AGY_MODEL_UNPINNED_VALUE, 'gemini-3.6-flash-low']);

    // And the validation that exists to keep a dead id out of argv now works on
    // the list agy actually offers, which is the whole point of re-asking.
    await expect(
      agent.setSessionConfigOption({
        sessionId: second.sessionId,
        configId: AGY_MODEL_CONFIG_ID,
        value: 'claude-sonnet-4-6',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('holds a fresh catalog rather than re-asking on every single request', async () => {
    // The other half: re-asking must stay a burst limiter. A default-configured
    // agent serves a whole interaction from one call.
    const { transport, calls } = mutableCatalogTransport(CATALOG);
    const { agent } = agentWith(transport);
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'x' }] });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: AGY_MODEL_UNPINNED_VALUE,
    });
    expect(calls()).toBe(1);
  });

  it('shares one in-flight catalog call even with no cache to serve from', async () => {
    // The TTL must not re-open the "N concurrent session/new cost N subprocesses"
    // hole it was added to close: expiry decides when to ask again, not how many
    // callers may ask at once.
    const { transport, calls } = mutableCatalogTransport(CATALOG);
    const { agent } = agentWith(transport, 0);
    await Promise.all([
      agent.newSession({ cwd: '/w', mcpServers: [] }),
      agent.newSession({ cwd: '/w', mcpServers: [] }),
      agent.newSession({ cwd: '/w', mcpServers: [] }),
    ]);
    expect(calls()).toBe(1);
  });

  it('resumes unpinned when the client carries nothing, and does not whisper it', async () => {
    // J4. The reset is correct — the process that held the choice is gone — but
    // a desktop that resumes and prompts without re-sending set_config_option
    // then runs on agy's saved default. `pinned: false` in a bag nobody reads is
    // not enough; the resume report states it and the log line says it too.
    const { agent, logged } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({ sessionId: CONV_A, cwd: '/w', mcpServers: [] });
    expect(modelOption(resumed.configOptions).currentValue).toBe(AGY_MODEL_UNPINNED_VALUE);
    expect(resumed._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: false });
    const report = resumed._meta?.[AGY_RESUME_META_KEY] as { model?: { detail?: string } };
    expect(report.model).toMatchObject({ pinned: false, modelId: null });
    expect(report.model?.detail).toMatch(/NOT PINNED/);
    expect(logged.join('\n')).toMatch(/resumed WITHOUT a model pin/);
  });

  it('restores a pin the client carried back, so the next turn is still reproducible', async () => {
    // J4, the other half: the pin rides the same `_meta` block this adapter
    // reports on every prompt response, exactly as the conversation id does. The
    // load-bearing assertion is the last one — argv, not the echo.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent, logged } = agentWith(transport);
    const resumed = await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: {
        [AGY_CONVERSATION_META_KEY]: CONV_A,
        [AGY_MODEL_META_KEY]: { pinned: true, modelId: 'claude-sonnet-4-6' },
      },
    });
    expect(modelOption(resumed.configOptions).currentValue).toBe('claude-sonnet-4-6');
    expect(resumed._meta?.[AGY_MODEL_META_KEY]).toMatchObject({
      pinned: true,
      modelId: 'claude-sonnet-4-6',
    });
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: true, modelId: 'claude-sonnet-4-6', source: 'client-meta' },
    });
    expect(logged.join('\n')).not.toMatch(/WITHOUT a model pin/);

    await agent.prompt({ sessionId: 'agy-test-stored', prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('keeps the pin when the session is still in this process — a reconnect loses nothing', async () => {
    // A resume of a session we are still holding is not a restart: the adapter
    // that made the choice is the one running. Resetting there would be a
    // downgrade with no cause at all.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent, logged } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });

    const resumed = await agent.resumeSession({ sessionId, cwd: '/w', mcpServers: [] });
    expect(modelOption(resumed.configOptions).currentValue).toBe('claude-sonnet-4-6');
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: true, modelId: 'claude-sonnet-4-6', source: 'in-process' },
    });
    expect(logged.join('\n')).not.toMatch(/WITHOUT a model pin/);

    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('accepts a bare model id as well as the block it emits', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({
      sessionId: CONV_A,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: 'claude-sonnet-4-6' },
    });
    expect(agent.modelFor(CONV_A)).toBe('claude-sonnet-4-6');
    expect(resumed._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: true });
  });

  it('treats a carried "not pinned" block as unpinned rather than as an id', async () => {
    // A client that stored the unpinned block verbatim sends back
    // `{ pinned: false, modelId: null }`, and the sentinel value is not a model
    // id either. Both mean the same thing: no --model.
    const { agent } = agentWith(scriptedTransport([]).transport);
    await agent.resumeSession({
      sessionId: CONV_A,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { pinned: false, modelId: null } },
    });
    expect(agent.modelFor(CONV_A)).toBeNull();
    await agent.resumeSession({
      sessionId: CONV_B,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { modelId: AGY_MODEL_UNPINNED_VALUE } },
    });
    expect(agent.modelFor(CONV_B)).toBeNull();
  });

  it('does not upgrade an explicit "not pinned" from the client into a pin', async () => {
    // P1, and the worst shape a defect in this package can have: not a loud
    // failure, a confidently wrong record. `readModelMeta` folded
    // `{ pinned: false, modelId: null }` — the exact block `modelMeta()` emits
    // and `AGY_LIMITATIONS.pinRestoreMetaKey` tells clients to persist — into the
    // same `null` as "the key was absent entirely". `carriedModel ?? known?.model`
    // then fell through to the in-process pin, so a client faithfully carrying
    // "unpinned" across a reconnect got back `pinned: true`, a picker agreeing,
    // and a `--model` in the next turn's argv. The experiment record said the run
    // was pinned; it was pinned to something the client had just unpinned.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent, logged } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });

    const resumed = await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { pinned: false, modelId: null } },
    });

    expect(resumed._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: false, modelId: null });
    expect(modelOption(resumed.configOptions).currentValue).toBe(AGY_MODEL_UNPINNED_VALUE);
    expect(agent.modelFor(sessionId)).toBeNull();
    // Attributed, not mourned: the client asked for this, so the report must not
    // say the pin was lost with the process — that is a different fact.
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: false, modelId: null, source: 'client-unpinned' },
    });
    expect(logged.join('\n')).toMatch(/explicit "not pinned"/);

    // The load-bearing assertion: argv, not the echo.
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBeNull();
  });

  it('treats the unpinned sentinel from the client as a decision too', async () => {
    // The other spelling of the same instruction, over the same reconnect.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { modelId: AGY_MODEL_UNPINNED_VALUE } },
    });
    expect(agent.modelFor(sessionId)).toBeNull();
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBeNull();
  });

  it('lets a null modelId beat a pinned:true flag, because only one of them names a model', async () => {
    // `pinned` is descriptive; `modelId` is what reaches argv. A block claiming
    // `pinned: true` with no id names nothing to pin to, and resolving that into
    // whatever this process happens to hold is how the forged-`_meta` case turns
    // into a wrong record. `_meta` is `additionalProperties: true` in ACP, so no
    // schema check will ever catch this shape — only this behaviour will.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { pinned: true, modelId: null } },
    });
    expect(agent.modelFor(sessionId)).toBeNull();
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBeNull();
  });

  it('still falls back to the in-process pin when the client carried no model block', async () => {
    // The half that must not regress while the above is fixed: silence is not an
    // instruction, so a reconnect that says nothing about the model keeps the pin
    // this process is still holding.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    const resumed = await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      // A conversation id and nothing else — the realistic reconnect payload.
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    expect(agent.modelFor(sessionId)).toBe('claude-sonnet-4-6');
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: true, source: 'in-process' },
    });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('says which of the two unpinned resumes happened, because they are different facts', async () => {
    // "You asked for no pin" and "the pin died with the process that held it"
    // want different things from the reader, and one report text for both is how
    // a client learns to ignore the field.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const lost = await agent.resumeSession({ sessionId: CONV_A, cwd: '/w', mcpServers: [] });
    expect(lost._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: false, source: 'none' },
    });
    const asked = await agent.resumeSession({
      sessionId: CONV_B,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { pinned: false, modelId: null } },
    });
    expect(asked._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: false, source: 'client-unpinned' },
    });
  });

  it('refuses a carried model agy does not offer instead of dropping to the default', async () => {
    // The downgrade this feature exists to prevent: a client that asked to
    // resume *on a named model* and silently got agy's persisted default would
    // have no way to tell. -32602, and the session is not created.
    const { agent } = agentWith(scriptedTransport([]).transport);
    await expect(
      agent.resumeSession({
        sessionId: CONV_A,
        cwd: '/w',
        mcpServers: [],
        _meta: { [AGY_MODEL_META_KEY]: { modelId: 'gpt-4o-mini' } },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(agent.modelFor(CONV_A)).toBeNull();
  });

  it('recovers model pinning after one `agy models` failure, in old and new sessions', async () => {
    // J2. `agy models` failing once used to disable pinning for the whole
    // process: the empty catalog was cached in both the transport and the agent
    // (`this.#catalog ??= …`, and the load never rejects), so every later
    // set_config_option answered -32602 — including in sessions opened after agy
    // had recovered — and every turn ran on agy's persisted default. It failed
    // loudly, but the only cure was restarting the adapter.
    let broken = true;
    let listCalls = 0;
    const transport: AgyTransport = {
      kind: 'cli',
      async listModels() {
        listCalls += 1;
        return broken
          ? { models: [], persistedDefault: null, diagnostics: ['`agy models` exited with code 1'] }
          : CATALOG;
      },
      runTurn() {
        return (async function* replay() {
          yield { type: 'end', stopReason: 'end_turn' } as const;
        })();
      },
      async dispose() {},
    };
    const { agent } = agentWith(transport);

    const first = await agent.newSession({ cwd: '/w', mcpServers: [] });
    // The failure is visible: the picker has only the "not pinned" entry, and
    // choosing a real model is refused with the reason attached.
    expect(modelOption(first.configOptions).options).toHaveLength(1);
    await expect(
      agent.setSessionConfigOption({
        sessionId: first.sessionId,
        configId: AGY_MODEL_CONFIG_ID,
        value: 'claude-sonnet-4-6',
      }),
    ).rejects.toMatchObject({ code: -32602 });

    broken = false;

    // A session opened after agy recovered can pin — the empty catalog was not
    // kept, so the transport is asked again.
    const second = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(modelOption(second.configOptions).options).toHaveLength(3);
    const configured = await agent.setSessionConfigOption({
      sessionId: second.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    expect(configured._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: true });

    // And so can the session that was open while agy was down.
    await agent.setSessionConfigOption({
      sessionId: first.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    expect(agent.modelFor(first.sessionId)).toBe('claude-sonnet-4-6');
    expect(listCalls).toBeGreaterThan(1);
  });

});

describe('prompt', () => {
  it('forwards every update to the client under the session id', async () => {
    const { transport } = scriptedTransport([
      { type: 'conversation', conversationId: 'conv-a' },
      textUpdate('hello '),
      textUpdate('world'),
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent, notifications } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });

    const response = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });

    expect(response.stopReason).toBe('end_turn');
    expect(notifications.map((n) => n.sessionId)).toEqual([sessionId, sessionId]);
    expect(
      notifications
        .map((n) => n.update)
        .flatMap((update) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? [update.content.text]
            : [],
        )
        .join(''),
    ).toBe('hello world');
  });

  it('carries the conversation id into the next turn — this is multi-turn context', async () => {
    const { transport, requests } = scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: 'conv-b' }]
        : []),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });

    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] });

    expect(requests.map((request) => request.conversationId)).toEqual([null, 'conv-b']);
    expect(requests.map((request) => request.prompt)).toEqual(['one', 'two']);
    expect(agent.conversationIdFor(sessionId)).toBe('conv-b');
  });

  it('passes the session cwd to the transport', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/some/project', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.cwd).toBe('/some/project');
  });

  it("passes the session's additionalDirectories to the transport", async () => {
    // D5's other half: ACP lets a client widen a session's filesystem scope and
    // this field was read by nothing at all.
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({
      cwd: '/some/project',
      additionalDirectories: ['/other/lib'],
      mcpServers: [],
    });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.additionalDirectories).toEqual(['/other/lib']);
  });

  it('adds the directory of every file the prompt references', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/some/project', mcpServers: [] });
    const referenced = path.resolve('/', 'elsewhere', 'notes.md');
    await agent.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'summarise' },
        { type: 'resource_link', name: 'notes.md', uri: pathToFileURL(referenced).href },
      ],
    });
    expect(requests[0]?.additionalDirectories).toEqual([path.resolve('/', 'elsewhere')]);
    // The reference reached agy as text as well, or it has no idea which file.
    expect(requests[0]?.prompt).toContain('notes.md');
    expect(requests[0]?.prompt).toContain(referenced);
  });

  it('reports an unrepresentable prompt block instead of running the turn', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await expect(
      agent.prompt({
        sessionId,
        prompt: [
          { type: 'text', text: 'look' },
          { type: 'audio', data: 'x', mimeType: 'audio/wav' },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    // And agy was never launched with a prompt missing half its content.
    expect(requests).toEqual([]);
  });

  it('logs a reference it could not turn into a workspace root', async () => {
    const { transport } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent, logged } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({
      sessionId,
      prompt: [{ type: 'resource_link', name: 'spec', uri: 'https://example.com/spec' }],
    });
    expect(logged.join('\n')).toContain('https://example.com/spec');
  });

  it('reports the transport stop reason unchanged', async () => {
    const { transport } = scriptedTransport([{ type: 'end', stopReason: 'refusal' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(
      (await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })).stopReason,
    ).toBe('refusal');
  });

  it('logs diagnostics instead of sending them to the client', async () => {
    const { transport } = scriptedTransport([
      { type: 'diagnostic', diagnostic: { reason: 'unmapped_step_type', detail: '{"a":1}' } },
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent, notifications, logged } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(notifications).toEqual([]);
    // Listed in full rather than filtered: the model line is a diagnostic too,
    // and an unpinned turn saying so in the log is a deliberate part of F1.
    expect(logged).toEqual([
      `[model] session ${sessionId} has no model pinned; this turn runs on agy's ` +
        `saved default ("Gemini 3.6 Flash (Low)")`,
      '[unmapped_step_type] {"a":1}',
    ]);
  });

  it('rejects a prompt for a session that does not exist, with a code the client can branch on', async () => {
    // D4. A bare `Error` reaches the client as -32603 "Internal error", which
    // means "the agent broke" — indistinguishable from "your session expired,
    // reopen it", and only one of those is worth retrying.
    const { agent } = agentWith(scriptedTransport([]).transport);
    await expect(
      agent.prompt({ sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toMatchObject({ code: -32002 });
    await expect(
      agent.prompt({ sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/unknown session nope/);
  });

  it('gives each session its own conversation', async () => {
    const { transport, requests } = scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: `conv-for-${request.prompt}` }]
        : []),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);
    const { agent } = agentWith(transport);
    const first = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const second = await agent.newSession({ cwd: '/w', mcpServers: [] });

    await agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'a' }] });
    await agent.prompt({ sessionId: second.sessionId, prompt: [{ type: 'text', text: 'b' }] });
    await agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'c' }] });

    expect(requests.map((request) => request.conversationId)).toEqual([
      null,
      null,
      'conv-for-a',
    ]);
  });
});

describe('cancel', () => {
  it('aborts the signal the turn is running under', async () => {
    let seen: AbortSignal | undefined;
    let reached: () => void = () => {};
    const reachedTransport = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transport: AgyTransport = {
      kind: 'cli',
      async listModels() {
        return CATALOG;
      },
      runTurn(request) {
        seen = request.signal;
        reached();
        return (async function* replay() {
          // Waits for the abort, the way a real child process does.
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          yield { type: 'end', stopReason: 'cancelled' } as const;
        })();
      },
      async dispose() {},
    };
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const turn = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    await reachedTransport;
    await agent.cancel({ sessionId });
    expect((await turn).stopReason).toBe('cancelled');
    expect(seen?.aborted).toBe(true);
  });

  it('cancels a turn that has not reached the transport yet', async () => {
    // `prompt` now awaits the model catalog before spawning. With the abort
    // controller installed after that await — where it used to be — a cancel
    // arriving in that window found `session.abort` still null, did nothing,
    // and agy was launched for a turn nobody was waiting for.
    const { transport, requests } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const turn = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    await agent.cancel({ sessionId });
    expect((await turn).stopReason).toBe('cancelled');
    expect(requests).toEqual([]);
  });

  it('is a no-op for an unknown or idle session', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    await expect(agent.cancel({ sessionId: 'nope' })).resolves.toBeUndefined();
  });
});

describe('the conversation id crossing the ACP boundary', () => {
  const namesConversation = (id: string) =>
    scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: id }]
        : []),
      textUpdate('hi'),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);

  it('reports it on the prompt response, which every turn produces', async () => {
    const { agent } = agentWith(namesConversation('conv-x').transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const response = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(response._meta?.[AGY_CONVERSATION_META_KEY]).toBe('conv-x');
  });

  it('reports it on a turn that ends without producing a single update', async () => {
    const { transport } = scriptedTransport([
      { type: 'conversation', conversationId: 'conv-silent' },
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent, notifications } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const response = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(notifications).toEqual([]);
    expect(response._meta?.[AGY_CONVERSATION_META_KEY]).toBe('conv-silent');
  });

  it('repeats it on every session update, so a half-finished turn is still resumable', async () => {
    const { agent, notifications } = agentWith(namesConversation('conv-x').transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(notifications).not.toEqual([]);
    expect(
      notifications.map((n) => n._meta?.[AGY_CONVERSATION_META_KEY]),
    ).toEqual(notifications.map(() => 'conv-x'));
  });

  it('never announces a null conversation, even though _meta is always sent', async () => {
    // The model report made `_meta` unconditional, so "no conversation yet" can
    // no longer be expressed by omitting the whole bag — it has to be the key
    // that is absent. A `null` under this key would be worse than either: a
    // client persisting `_meta[key]` would store `null` and resume with it.
    const { transport } = scriptedTransport([
      textUpdate('hi'),
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent, notifications } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const response = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    // Session updates still carry nothing but the conversation id, so a stream
    // of chunks does not repeat the model block on every frame.
    expect(notifications[0]?._meta).toBeUndefined();
    expect(response._meta).toBeDefined();
    expect(AGY_CONVERSATION_META_KEY in (response._meta ?? {})).toBe(false);
  });

  it('is the round trip: what one agent hands out, a restarted agent resumes with', async () => {
    // Two AgyAgent instances, no shared state — the same situation as a client
    // reconnecting to a freshly launched adapter process.
    const first = agentWith(namesConversation(CONV_A).transport);
    const { sessionId } = await first.agent.newSession({ cwd: '/w', mcpServers: [] });
    const turn = await first.agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    });

    const carried = turn._meta?.[AGY_CONVERSATION_META_KEY];
    expect(carried).toBe(CONV_A);

    const second = scriptedTransport([{ type: 'end' as const, stopReason: 'end_turn' as const }]);
    const restarted = agentWith(second.transport);
    await restarted.agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: carried },
    });
    await restarted.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] });

    // Without this the second turn starts a brand-new agy conversation.
    expect(second.requests[0]?.conversationId).toBe(CONV_A);
  });

  it('is namespaced, so it cannot collide with a spec field or another agent', async () => {
    // F3. This key used to be the bare string `conversationId` while the
    // limitations key next to it was namespaced with a comment explaining
    // exactly why bare keys are unsafe. It is the load-bearing one: a collision
    // does not drop a field, it resumes someone else's conversation.
    expect(AGY_CONVERSATION_META_KEY).toContain('cozypad.dev/');
    const { agent } = agentWith(namesConversation(CONV_A).transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const response = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    // The old bare key is accepted on input, never emitted.
    expect(AGY_CONVERSATION_META_KEY_LEGACY in (response._meta ?? {})).toBe(false);
  });

  it('still reads the pre-namespace key on input, for one version', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent, logged } = agentWith(transport);
    await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY_LEGACY]: CONV_B },
    });
    await agent.prompt({ sessionId: 'agy-test-stored', prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.conversationId).toBe(CONV_B);
    // Accepted, but not silently: a client left on the old key is told.
    expect(logged.join('\n')).toContain(AGY_CONVERSATION_META_KEY_LEGACY);
  });

  it('prefers the namespaced key when a client sends both', () => {
    expect(
      readConversationMeta({
        [AGY_CONVERSATION_META_KEY_LEGACY]: CONV_B,
        [AGY_CONVERSATION_META_KEY]: CONV_A,
      }),
    ).toEqual({ conversationId: CONV_A, key: AGY_CONVERSATION_META_KEY });
  });
});

describe('resumeSession', () => {
  it('is the only session-restoring method this agent has', () => {
    // D1/D2 as a structural assertion. `session/load` is contractually a history
    // replay; leaving a handler in place would make the SDK register the method
    // and the client would be back to believing a claim we cannot honour. With
    // no handler the client gets -32601 Method not found — which, paired with
    // `loadSession: false` at initialize, is consistent.
    expect((agentWith(scriptedTransport([]).transport).agent as { loadSession?: unknown })
      .loadSession).toBeUndefined();
  });

  it('refuses to resume a session it cannot resume, instead of starting a new one', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    // An id this agent minted, from a process that is gone, with no _meta: there
    // is no conversation id anywhere. Reporting success here is the M3 defect.
    await expect(
      agent.resumeSession({ sessionId: 'agy-test-gone', cwd: '/w', mcpServers: [] }),
    ).rejects.toThrow(/cannot resume session agy-test-gone/);
    await expect(
      agent.prompt({ sessionId: 'agy-test-gone', prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/unknown session/);
    expect(requests).toEqual([]);
  });

  it('resumes a still-live session that has not had a turn yet', async () => {
    const { transport } = scriptedTransport([{ type: 'end', stopReason: 'end_turn' }]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    // No turn has run, so there is no agy conversation — and nothing to lose.
    const resumed = await agent.resumeSession({ sessionId, cwd: '/w', mcpServers: [] });
    expect(AGY_CONVERSATION_META_KEY in (resumed._meta ?? {})).toBe(false);
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      conversationId: null,
      source: 'none',
    });
  });

  it('echoes the conversation id it resolved, so the client can confirm', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    expect(resumed._meta?.[AGY_CONVERSATION_META_KEY]).toBe(CONV_A);
  });

  it('restates the permission mode, because a resumed session is still ungated', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({
      sessionId: CONV_A,
      cwd: '/w',
      mcpServers: [],
    });
    expect(resumed.modes?.currentModeId).toBe(AGY_PERMISSION_MODE_ID);
  });

  it('carries additionalDirectories into the resumed session', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    await agent.resumeSession({
      sessionId: CONV_A,
      cwd: '/w',
      additionalDirectories: ['/other/lib'],
      mcpServers: [],
    });
    await agent.prompt({ sessionId: CONV_A, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.additionalDirectories).toEqual(['/other/lib']);
  });

  it('ignores a _meta conversation id that is not a non-empty string', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    await agent.resumeSession({
      sessionId: CONV_B,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: '' },
    });
    await agent.prompt({ sessionId: CONV_B, prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.conversationId).toBe(CONV_B);
  });

  it('treats a non-prefixed session id as an agy conversation id', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    await agent.resumeSession({ sessionId: CONV_A, cwd: '/w', mcpServers: [] });
    await agent.prompt({
      sessionId: CONV_A,
      prompt: [{ type: 'text', text: 'continue' }],
    });
    expect(requests[0]?.conversationId).toBe(CONV_A);
  });

  it('prefers a conversation id supplied in _meta', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_B },
    });
    await agent.prompt({ sessionId: 'agy-test-stored', prompt: [{ type: 'text', text: 'x' }] });
    expect(requests[0]?.conversationId).toBe(CONV_B);
  });
});

describe('resumeSession validates the id it is handed', () => {
  // F4. Measured before this existed: `session/resume` with
  // `sessionId: 'nope-does-not-exist'` returned OK and echoed the string back as
  // the conversation id. The -32002 path only ever protected ids this adapter
  // had minted itself; anything foreign was believed.

  it('refuses a session id that cannot be an agy conversation id', async () => {
    const { transport, requests } = scriptedTransport([
      { type: 'end', stopReason: 'end_turn' },
    ]);
    const { agent } = agentWith(transport);
    const failure = await agent
      .resumeSession({ sessionId: 'nope-does-not-exist', cwd: '/w', mcpServers: [] })
      .then(() => null, (error: unknown) => error as { code?: number; message?: string });
    expect(failure?.code).toBe(-32602);
    expect(failure?.message).toMatch(/not the shape of an agy conversation id/);
    // And no session was registered behind the refusal.
    await expect(
      agent.prompt({ sessionId: 'nope-does-not-exist', prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toMatchObject({ code: -32002 });
    expect(requests).toEqual([]);
  });

  it('refuses a malformed conversation id sent in _meta', async () => {
    const { agent } = agentWith(scriptedTransport([]).transport);
    const failure = await agent
      .resumeSession({
        sessionId: 'agy-test-stored',
        cwd: '/w',
        mcpServers: [],
        _meta: { [AGY_CONVERSATION_META_KEY]: 'e1d0d96e-c2b1-4a49-bc5b' },
      })
      .then(() => null, (error: unknown) => error as { code?: number; message?: string });
    // A truncated paste is the realistic case, and it used to read as success.
    expect(failure?.code).toBe(-32602);
  });

  it('says plainly that a client-supplied id was only shape-checked', async () => {
    // Shape is all this transport can check: agy print mode has no way to ask
    // "does this conversation exist" short of spending a turn. Saying so is the
    // difference between a resume the client can trust and one it cannot.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    const report = resumed._meta?.[AGY_RESUME_META_KEY] as {
      source?: string;
      detail?: string;
    };
    expect(report.source).toBe('client-meta');
    expect(report.detail).toMatch(/NOT proof/);
  });

  it('does not grade a compliant client down to "shape-checked only"', async () => {
    // P4. `source` was set to 'client-meta' the moment `_meta` carried an id,
    // without ever comparing it to the one this process watched agy mint. So the
    // client that does exactly what this adapter documents — persist the id,
    // send it back on resume — was reported as the *least* trustworthy input,
    // and `cliTransport` suppresses the `conversation` event once a conversation
    // id is passed in, so the session could never recover the provenance either.
    const { transport } = scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: CONV_A }]
        : []),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });

    const resumed = await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      conversationId: CONV_A,
      source: 'observed',
    });
  });

  it('keeps "client-meta" when the carried id is one this process never watched', async () => {
    // Matching an id we only ever took on trust upgrades nothing.
    const { agent } = agentWith(scriptedTransport([]).transport);
    await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    const again = await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    expect(again._meta?.[AGY_RESUME_META_KEY]).toMatchObject({ source: 'client-meta' });
  });

  it('reports no boolean a resume can never earn', async () => {
    // `verified` was `source === 'observed'`, and every compliant client took the
    // `_meta` branch, so it was false for everyone who followed the instructions
    // and true only for a client that sent nothing. Even repaired it would be a
    // boolean promising more than a shape check can deliver: watching agy mint an
    // id is not evidence the conversation still exists. `source` and `detail` say
    // both of those things without a checkmark for a client to render.
    const { agent } = agentWith(scriptedTransport([]).transport);
    const resumed = await agent.resumeSession({
      sessionId: 'agy-test-stored',
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_A },
    });
    const report = resumed._meta?.[AGY_RESUME_META_KEY] as Record<string, unknown>;
    expect('verified' in report).toBe(false);
    expect(report.source).toBe('client-meta');
  });

  it('logs a carried id that disagrees with the one it is holding, and believes the client', async () => {
    // Two ids for one session is a client bug or a mixed-up store, and it decides
    // which agy conversation the next turn continues. It must not be silent.
    const { transport, requests } = scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: CONV_A }]
        : []),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);
    const { agent, logged } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });

    const resumed = await agent.resumeSession({
      sessionId,
      cwd: '/w',
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: CONV_B },
    });
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      conversationId: CONV_B,
      source: 'client-meta',
    });
    expect(logged.join('\n')).toMatch(/disagrees with the id this process holds/);
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'y' }] });
    expect(requests[1]?.conversationId).toBe(CONV_B);
  });

  it('calls a conversation id observed only when it watched agy mint it', async () => {
    const { transport } = scriptedTransport((request) => [
      ...(request.conversationId === null
        ? [{ type: 'conversation' as const, conversationId: CONV_A }]
        : []),
      { type: 'end' as const, stopReason: 'end_turn' as const },
    ]);
    const { agent } = agentWith(transport);
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    const resumed = await agent.resumeSession({ sessionId, cwd: '/w', mcpServers: [] });
    const report = resumed._meta?.[AGY_RESUME_META_KEY] as Record<string, unknown>;
    expect(report).toMatchObject({ conversationId: CONV_A, source: 'observed' });
    // Even here there is no claim the conversation is still there — agy print
    // mode cannot be asked that without spending a turn, and the detail says so
    // rather than letting `observed` read as a liveness check.
    expect(String(report.detail)).toMatch(/not a liveness check/);
  });

  it('accepts the shape agy actually mints, and only that', () => {
    // Evidence, not taste: every one of the 214 files in
    // ~/.gemini/antigravity-cli/conversations/ is <uuid>.db, and so is the id in
    // every recorded fixture in this package.
    expect(looksLikeAgyConversationId('e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3')).toBe(true);
    expect(looksLikeAgyConversationId('E1D0D96E-C2B1-4A49-BC5B-E3B216059AD3')).toBe(true);
    expect(looksLikeAgyConversationId('nope-does-not-exist')).toBe(false);
    expect(looksLikeAgyConversationId('e1d0d96e-c2b1-4a49-bc5b-e3b216059ad')).toBe(false);
    expect(looksLikeAgyConversationId('e1d0d96ec2b14a49bc5be3b216059ad3')).toBe(false);
    expect(looksLikeAgyConversationId('')).toBe(false);
  });
});

describe('AGY_LIMITATIONS', () => {
  it('reports every negative capability as false, by literal value', () => {
    // This block is the *only* place a client learns what this adapter cannot
    // do, and every field in it is a boolean whose wrong value is still a valid
    // boolean — nothing downstream type-checks, throws or logs if one flips.
    //
    // `pinsModelByDefault` is why this test exists. It appeared once in `src`
    // and zero times in `tests`: flipping it to `true` passed all 376 tests and
    // all four tsc projects. A client reading `true` would conclude a new
    // session is already on a chosen model, skip `session/set_config_option`,
    // and run the whole turn on agy's persisted default (locally: Gemini 3.6
    // Flash Low) — while the `cozypad.dev/agy-model` block on the very same
    // response still said `pinned: false`. For the CV experiments this adapter
    // exists to make reproducible, that is a run recorded against a model that
    // did not produce it.
    //
    // Asserted as literals rather than as `toBe(false)` on a variable, so the
    // failure message names the field that changed.
    expect(AGY_LIMITATIONS.requestsPermission).toBe(false);
    expect(AGY_LIMITATIONS.replaysHistory).toBe(false);
    expect(AGY_LIMITATIONS.pinsModelByDefault).toBe(false);
    expect(AGY_LIMITATIONS.confinesToWorkspace).toBe(false);
    expect(AGY_LIMITATIONS.pinSurvivesResume).toBe(false);
    expect(AGY_LIMITATIONS.transport).toBe('cli');
    expect(AGY_LIMITATIONS.permissionMode).toBe(AGY_PERMISSION_MODE_ID);
    expect(AGY_LIMITATIONS.pinRestoreMetaKey).toBe(AGY_MODEL_META_KEY);
  });

  it('has exactly these keys, so a new capability cannot ship unclaimed', () => {
    // A field added here without a value asserted above is the same hole this
    // suite just closed, one field later. Pinning the key set means the next
    // one has to come with a test.
    expect(Object.keys(AGY_LIMITATIONS).sort()).toEqual([
      'confinesToWorkspace',
      'detail',
      'permissionMode',
      'pinRestoreMetaKey',
      'pinSurvivesResume',
      'pinsModelByDefault',
      'replaysHistory',
      'requestsPermission',
      'transport',
      'workspaceDetail',
    ]);
  });

  it('spells out in prose what the booleans only imply', () => {
    // The booleans are for code; these two strings are what a user actually
    // reads in a UI. Emptying either is invisible to every other assertion.
    expect(AGY_LIMITATIONS.detail).toMatch(/never sends\s+session\/request_permission/);
    expect(AGY_LIMITATIONS.workspaceDetail).toMatch(/never as a sandbox boundary/);
  });
});

describe('AGY_MODEL_CATALOG_TTL_MS', () => {
  it('expires the agent-level catalog after one minute', () => {
    // `AgyAgent` caches `transport.listModels()` behind this, and the cache is
    // what a client's model picker is built from. Nothing asserted the number,
    // so `Number.MAX_SAFE_INTEGER` passed the whole suite — which is exactly
    // the "a working catalog is cached for the life of the process" defect that
    // `cliTransport.test.ts` documents having already fixed once, re-introduced
    // one layer up where that test cannot see it.
    expect(AGY_MODEL_CATALOG_TTL_MS).toBe(60_000);
  });

  it('is shorter than the transport it caches, which is the whole point', () => {
    // Two caches in series: this one in front of the transport's own. If the
    // outer one outlived the inner one, the transport's stale-while-revalidate
    // refresh would never be reached — the inner cache would be correct and
    // unreachable. 600_000 is `AgyCliTransportOptions.modelListTtlMs`'s default,
    // pinned by its own test in `cliTransport.test.ts`.
    expect(AGY_MODEL_CATALOG_TTL_MS).toBeLessThan(600_000);
  });
});
