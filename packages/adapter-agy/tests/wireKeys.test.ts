/**
 * The `_meta` wire keys, pinned as **literal strings**.
 *
 * These keys are a persistence contract, not an implementation detail: a
 * third-party client stores what this adapter puts in `_meta` and sends it back
 * on `session/resume`. Renaming one does not break a build and does not fail a
 * request — it silently orphans every session anyone had already stored.
 *
 * Every other test in this package imports the constant and uses it on **both**
 * sides of its assertion, which is a tautology: it passes for any value the
 * constant happens to have. Measured — `AGY_MODEL_META_KEY`,
 * `AGY_RESUME_META_KEY` and `AGY_LIMITATIONS_META_KEY` could each be changed to
 * a bare unnamespaced string with the whole suite still green, and
 * `AGY_CONVERSATION_META_KEY` was pinned only by `toContain('cozypad.dev/')`, so
 * renaming it to `cozypad.dev/xyz` survived too.
 *
 * So this file spells the strings out, and then checks them again where they
 * actually appear on the wire — the constant being right is not the same claim
 * as the payload carrying it.
 */
import { PROTOCOL_VERSION, type AgentSideConnection } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  AGY_CONVERSATION_META_KEY,
  AGY_CONVERSATION_META_KEY_LEGACY,
  AGY_LIMITATIONS_META_KEY,
  AGY_MODEL_CONFIG_ID,
  AGY_MODEL_META_KEY,
  AGY_MODEL_UNPINNED_VALUE,
  AGY_PERMISSION_MODE_ID,
  AGY_RESUME_META_KEY,
  AgyAgent,
} from '../src/agent.js';
import type { AgyModelCatalog, AgyTransport } from '../src/transport.js';

const CONV = '11111111-2222-4333-8444-555555555555';

const CATALOG: AgyModelCatalog = {
  models: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
  ],
  persistedDefault: { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
  diagnostics: [],
};

function agentWith(): AgyAgent {
  const transport: AgyTransport = {
    kind: 'cli',
    async listModels() {
      return CATALOG;
    },
    runTurn() {
      return (async function* replay() {
        yield { type: 'conversation', conversationId: CONV } as const;
        yield { type: 'end', stopReason: 'end_turn' } as const;
      })();
    },
    async dispose() {},
  };
  const connection = {
    async sessionUpdate() {},
  } as unknown as AgentSideConnection;
  return new AgyAgent(connection, { transport, newSessionId: () => 'agy-wire-1' });
}

describe('the `_meta` wire keys', () => {
  it('are exactly these strings, and changing one is a breaking change', () => {
    // If you are here because this test failed: the constant moved, and every
    // client that persisted the old key can no longer resume. That may still be
    // the right call — but it is a wire break, so bump it deliberately and
    // handle the old key on input the way AGY_CONVERSATION_META_KEY_LEGACY is
    // handled, rather than editing this line to match.
    expect(AGY_CONVERSATION_META_KEY).toBe('cozypad.dev/agy-conversation-id');
    expect(AGY_MODEL_META_KEY).toBe('cozypad.dev/agy-model');
    expect(AGY_RESUME_META_KEY).toBe('cozypad.dev/agy-resume');
    expect(AGY_LIMITATIONS_META_KEY).toBe('cozypad.dev/agy-limitations');
    // Input-only, and deliberately bare: it is the pre-namespace spelling this
    // adapter still accepts for one version. Pinned so it cannot drift either.
    expect(AGY_CONVERSATION_META_KEY_LEGACY).toBe('conversationId');
  });

  it('are namespaced, which is what the docstrings promise and nothing enforced', () => {
    // `AGY_LIMITATIONS_META_KEY` says "Namespaced so it cannot collide with a
    // future spec field or another agent's extension" — a claim no assertion
    // was making. A bare key here does not drop a field or raise an error; it
    // makes two agents' extensions the same field.
    for (const key of [
      AGY_CONVERSATION_META_KEY,
      AGY_MODEL_META_KEY,
      AGY_RESUME_META_KEY,
      AGY_LIMITATIONS_META_KEY,
    ]) {
      expect(key.startsWith('cozypad.dev/')).toBe(true);
      expect(key.slice('cozypad.dev/'.length)).not.toBe('');
    }
  });

  it('are the keys the payloads actually carry — not just the constants', async () => {
    // The constant being right is one claim; the wire carrying it is the other.
    // These literals are written out on purpose: no constant appears on either
    // side of an assertion below.
    const agent = agentWith();

    const initialize = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(
      Object.keys(initialize.agentCapabilities?._meta ?? {}),
    ).toContain('cozypad.dev/agy-limitations');

    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(Object.keys(session._meta ?? {})).toContain('cozypad.dev/agy-model');

    const configured = await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'claude-sonnet-4-6',
    });
    expect(configured._meta?.['cozypad.dev/agy-model']).toMatchObject({
      pinned: true,
      modelId: 'claude-sonnet-4-6',
    });

    const turn = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    });
    expect(turn._meta?.['cozypad.dev/agy-conversation-id']).toBe(CONV);
    expect(Object.keys(turn._meta ?? {})).toContain('cozypad.dev/agy-model');

    // The round trip a client actually performs: store what came out, send it
    // back under the same literal keys.
    const resumed = await agent.resumeSession({
      sessionId: 'agy-wire-1',
      cwd: '/w',
      mcpServers: [],
      _meta: {
        'cozypad.dev/agy-conversation-id': CONV,
        'cozypad.dev/agy-model': { pinned: true, modelId: 'claude-sonnet-4-6' },
      },
    });
    expect(resumed._meta?.['cozypad.dev/agy-conversation-id']).toBe(CONV);
    expect(resumed._meta?.['cozypad.dev/agy-resume']).toMatchObject({ conversationId: CONV });
    expect(resumed._meta?.['cozypad.dev/agy-model']).toMatchObject({
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('are the only keys emitted, so a new one cannot arrive unnamespaced', async () => {
    // A structural guard rather than a list to maintain: whatever this adapter
    // grows next, it may not put a bare key in a protocol `_meta` bag. (The
    // nested `_meta` on a config option is our own object, not an extension
    // point clients merge, so it is not covered here.)
    const agent = agentWith();
    const initialize = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const turn = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'x' }],
    });
    const resumed = await agent.resumeSession({
      sessionId: 'agy-wire-1',
      cwd: '/w',
      mcpServers: [],
      _meta: { 'cozypad.dev/agy-conversation-id': CONV },
    });

    const emitted = [
      ...Object.keys(initialize.agentCapabilities?._meta ?? {}),
      ...Object.keys(session._meta ?? {}),
      ...Object.keys(turn._meta ?? {}),
      ...Object.keys(resumed._meta ?? {}),
    ];
    expect(emitted.length).toBeGreaterThan(0);
    for (const key of emitted) expect(key.startsWith('cozypad.dev/')).toBe(true);
    // The bare pre-namespace key is accepted on input and never emitted.
    expect(emitted).not.toContain('conversationId');
  });
});

describe('the other strings a client sends back', () => {
  it('pins the config id and the unpinned sentinel', () => {
    // Not `_meta`, but the same class of contract: a client stores the chosen
    // value and re-sends it, and `session/set_config_option` rejects anything it
    // does not recognise — so renaming either one turns a stored choice into a
    // -32602 on the next launch.
    expect(AGY_MODEL_CONFIG_ID).toBe('model');
    expect(AGY_MODEL_UNPINNED_VALUE).toBe('agy-persisted-default');
    expect(AGY_PERMISSION_MODE_ID).toBe('always-proceed');
  });

  it('offers the unpinned sentinel as a real selectable value', async () => {
    const agent = agentWith();
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const option = session.configOptions?.find((entry) => entry.id === 'model');
    expect(option?.type).toBe('select');
    const values = (option as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values).toContain('agy-persisted-default');
    expect(values).toContain('claude-sonnet-4-6');
  });
});
