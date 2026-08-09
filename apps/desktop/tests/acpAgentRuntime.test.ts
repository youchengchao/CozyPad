/**
 * The runtime's control-request correlation.
 *
 * ACP models permission as a *request*, so the agent is genuinely blocked on
 * the return value — which means answering the wrong one is not a display bug,
 * it is the wrong tool being allowed to run.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '@cozypad/contracts';
import type { AcpClientHandlers } from '@cozypad/acp-client';
import { AcpAgentRuntime } from '../src/main/acp/acpAgentRuntime';
import type { AcpChild, AcpLaunchSpec } from '../src/main/acp/acpProcess';

/** A child that records what it was asked and answers what the test says. */
function fakeChild(): { child: AcpChild; captured: { handlers?: AcpClientHandlers } } {
  const captured: { handlers?: AcpClientHandlers } = {};
  const child: AcpChild = {
    handle: {
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      newSession: async () => ({ sessionId: 'acp-1' }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => undefined,
      setSessionConfigOption: async () => ({}),
    } as never,
    kill: () => undefined,
    onExit: () => undefined,
  };
  return { child, captured };
}

function runtimeWith(): {
  runtime: AcpAgentRuntime;
  handlers: () => AcpClientHandlers;
  asked: ChatItem[];
  answer: (item: ChatItem) => Promise<string | null>;
  resolveAsk: Map<string, (optionId: string | null) => void>;
} {
  const { child, captured } = fakeChild();
  const asked: ChatItem[] = [];
  const resolveAsk = new Map<string, (optionId: string | null) => void>();
  const answer = async (item: ChatItem): Promise<string | null> => {
    asked.push(item);
    // Never resolves on its own: the test decides, which is what lets two
    // requests be open at the same time.
    return new Promise<string | null>((resolve) => {
      resolveAsk.set(item.id, resolve);
    });
  };
  const runtime = new AcpAgentRuntime(
    {
      onTimeline: () => undefined,
      onPermission: (_sessionId, item) => answer(item),
      onError: () => undefined,
    },
    (_spec: AcpLaunchSpec, handlers: AcpClientHandlers) => {
      captured.handlers = handlers;
      return child;
    },
  );
  return {
    runtime,
    handlers: () => {
      if (captured.handlers === undefined) throw new Error('not started');
      return captured.handlers;
    },
    asked,
    answer,
    resolveAsk,
  };
}

describe('ACP process routing', () => {
  it('preserves the remote cwd and uses the SSH launcher', async () => {
    const { child } = fakeChild();
    const localSpawn = vi.fn(
      (spec: AcpLaunchSpec, handlers: AcpClientHandlers) => {
        void spec;
        void handlers;
        return child;
      },
    );
    const remoteSpawn = vi.fn(
      async (spec: AcpLaunchSpec, handlers: AcpClientHandlers) => {
        void spec;
        void handlers;
        return child;
      },
    );
    const runtime = new AcpAgentRuntime(
      {
        onTimeline: () => undefined,
        onPermission: () => new Promise<string | null>(() => undefined),
        onError: () => undefined,
      },
      localSpawn,
      remoteSpawn,
    );

    await runtime.start(
      'remote-1',
      '/d/projects/research',
      'codex',
      undefined,
      undefined,
      true,
    );

    expect(localSpawn).not.toHaveBeenCalled();
    expect(remoteSpawn).toHaveBeenCalledOnce();
    expect(remoteSpawn.mock.calls[0]?.[0].cwd).toBe('/d/projects/research');
  });
});

const permissionRequest = (title: string): unknown => ({
  toolCall: { title },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
});

describe('two permission requests open at once', () => {
  it('sends each answer to the request it was given for', async () => {
    // The defect this test exists for: `resolveControl` used to ignore its
    // requestId and answer whichever request happened to be pending. An agent
    // running tools in parallel opens more than one, so the user's decision
    // about one tool authorised a different one — with nothing anywhere
    // reporting a mismatch.
    const { runtime, handlers, asked, resolveAsk } = runtimeWith();
    await runtime.start('s1', '/workspace');

    const first = handlers().requestPermission!(permissionRequest('Delete build output') as never);
    const second = handlers().requestPermission!(permissionRequest('Push to origin') as never);

    await vi.waitFor(() => {
      expect(asked).toHaveLength(2);
    });
    const [deleteItem, pushItem] = asked;
    expect(deleteItem?.id).not.toBe(pushItem?.id);

    // Answer the SECOND one only.
    resolveAsk.get(pushItem!.id)!('allow');

    await expect(second).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });

    // The first must still be waiting. Under the old code it had already been
    // resolved with the answer meant for the second.
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstSettled).toBe(false);

    resolveAsk.get(deleteItem!.id)!(null);
    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  }, 15_000);

  it('resolveControl only answers the id it was given', async () => {
    const { runtime, handlers, asked } = runtimeWith();
    await runtime.start('s1', '/workspace');

    const pending = handlers().requestPermission!(permissionRequest('Run tests') as never);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });

    // An id that is not open must be a no-op, not "answer something".
    runtime.resolveControl('s1', 'some-other-request', 'allow');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    runtime.resolveControl('s1', asked[0]!.id, 'allow');
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  }, 15_000);

  it('declines whatever is still open when the session stops', async () => {
    // An unanswered request would otherwise keep a promise, and whatever awaits
    // it, alive after the agent is gone.
    const { runtime, handlers, asked } = runtimeWith();
    await runtime.start('s1', '/workspace');

    const pending = handlers().requestPermission!(permissionRequest('Format disk') as never);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });

    runtime.stop('s1');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  }, 15_000);
});

/**
 * A child whose capabilities the test scripts, recording every open-session
 * call. `replayOnLoad` imitates what `session/load` really does: stream the
 * stored conversation back as notifications while the request is in flight.
 */
function continuableChild(options: {
  capabilities?: unknown;
  loadFails?: boolean;
  replayOnLoad?: string;
  promptMeta?: Record<string, unknown>;
  newSessionModes?: unknown;
}): {
  child: AcpChild;
  captured: { handlers?: AcpClientHandlers };
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const captured: { handlers?: AcpClientHandlers } = {};
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const replay = (sessionId: string, text: string) => {
    captured.handlers?.onSessionUpdate(
      {
        sessionId,
        kind: 'agent_message_chunk',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      } as never,
    );
  };
  const child: AcpChild = {
    handle: {
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: options.capabilities ?? {},
        authMethods: [],
      }),
      newSession: async (params: Record<string, unknown>) => {
        calls.push({ method: 'session/new', params });
        return {
          sessionId: 'fresh-1',
          ...(options.newSessionModes === undefined
            ? {}
            : { modes: options.newSessionModes }),
        };
      },
      setSessionMode: async (params: Record<string, unknown>) => {
        calls.push({ method: 'session/set_mode', params });
        return {};
      },
      loadSession: async (params: Record<string, unknown>) => {
        calls.push({ method: 'session/load', params });
        if (options.loadFails === true) throw new Error('no such session');
        if (options.replayOnLoad !== undefined) {
          replay(params['sessionId'] as string, options.replayOnLoad);
        }
        return {};
      },
      resumeSession: async (params: Record<string, unknown>) => {
        calls.push({ method: 'session/resume', params });
        return {};
      },
      prompt: async () => ({
        stopReason: 'end_turn',
        ...(options.promptMeta === undefined ? {} : { _meta: options.promptMeta }),
      }),
      cancel: async () => undefined,
      setSessionConfigOption: async () => ({}),
    } as never,
    kill: () => undefined,
    onExit: () => undefined,
  };
  return { child, captured, calls };
}

function runtimeFor(child: AcpChild, captured: { handlers?: AcpClientHandlers }): {
  runtime: AcpAgentRuntime;
  promptMeta: { sessionId: string; meta: Record<string, unknown> }[];
} {
  const promptMeta: { sessionId: string; meta: Record<string, unknown> }[] = [];
  const runtime = new AcpAgentRuntime(
    {
      onTimeline: () => undefined,
      onPermission: () => new Promise<string | null>(() => undefined),
      onError: () => undefined,
      onPromptMeta: (sessionId, meta) => {
        promptMeta.push({ sessionId, meta: { ...meta } });
      },
    },
    (_spec, handlers) => {
      captured.handlers = handlers;
      return child;
    },
  );
  return { runtime, promptMeta };
}

const historyItem: ChatItem = {
  kind: 'message',
  id: 'old-1',
  timestamp: '2026-08-08T00:00:00.000Z',
  role: 'assistant',
  text: 'the previous conversation',
} as ChatItem;

describe('continuing a previous conversation', () => {
  it('loads the old session when the agent can replay, and drops the replay', async () => {
    // CozyPad persisted its own transcript, seeded as `history`. Reducing the
    // replay as well would show the whole conversation twice.
    const { child, captured, calls } = continuableChild({
      capabilities: { loadSession: true },
      replayOnLoad: 'replayed text the timeline must not duplicate',
    });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start('s1', '/workspace', 'claude', {
      acpSessionId: 'conv-42',
      history: [historyItem],
    });

    expect(opened).toMatchObject({ acpSessionId: 'conv-42', continued: true });
    expect(calls).toEqual([
      {
        method: 'session/load',
        params: { sessionId: 'conv-42', cwd: '/workspace', mcpServers: [] },
      },
    ]);
    expect(runtime.itemsFor('s1')).toEqual([historyItem]);
  });

  it('resumes without replay when that is all the agent offers, carrying _meta', async () => {
    const { child, captured, calls } = continuableChild({
      capabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
    });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start('s1', '/workspace', 'agy', {
      acpSessionId: 'conv-7',
      resumeMeta: { 'cozypad.dev/agy-conversation-id': 'conv-7' },
      history: [historyItem],
    });

    expect(opened).toMatchObject({ acpSessionId: 'conv-7', continued: true });
    expect(calls).toEqual([
      {
        method: 'session/resume',
        params: {
          sessionId: 'conv-7',
          cwd: '/workspace',
          _meta: { 'cozypad.dev/agy-conversation-id': 'conv-7' },
        },
      },
    ]);
    expect(runtime.itemsFor('s1')).toEqual([historyItem]);
  });

  it('falls back to a new session when the agent cannot continue', async () => {
    const { child, captured, calls } = continuableChild({ capabilities: {} });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start('s1', '/workspace', 'codex', {
      acpSessionId: 'conv-dead',
      history: [historyItem],
    });

    // `continued: false` is the honest answer the service turns into its
    // "the agent does not remember this" notice.
    expect(opened).toMatchObject({ acpSessionId: 'fresh-1', continued: false });
    expect(calls.map((call) => call.method)).toEqual(['session/new']);
    expect(runtime.itemsFor('s1')).toEqual([historyItem]);
  });

  it('falls back to a new session when the old conversation is gone', async () => {
    // A conversation the agent no longer has must not stop the session from
    // opening at all.
    const { child, captured, calls } = continuableChild({
      capabilities: { loadSession: true },
      loadFails: true,
    });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start('s1', '/workspace', 'claude', {
      acpSessionId: 'conv-gone',
    });

    expect(opened).toMatchObject({ acpSessionId: 'fresh-1', continued: false });
    expect(calls.map((call) => call.method)).toEqual(['session/load', 'session/new']);
  });

  it('forwards announced commands to onCommands, and never into the timeline', async () => {
    // `available_commands_update` is session state: the composer's menu is its
    // only consumer, so dropping it leaves the user with no slash commands.
    const { child, captured } = continuableChild({});
    const commands: { sessionId: string; names: string[] }[] = [];
    const runtime = new AcpAgentRuntime(
      {
        onTimeline: () => undefined,
        onPermission: () => new Promise<string | null>(() => undefined),
        onError: () => undefined,
        onCommands: (sessionId, announced) => {
          commands.push({ sessionId, names: announced.map((command) => command.name) });
        },
      },
      (_spec, handlers) => {
        captured.handlers = handlers;
        return child;
      },
    );
    await runtime.start('s1', '/workspace');

    captured.handlers!.onSessionUpdate({
      sessionId: 'fresh-1',
      kind: 'available_commands_update',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'usage', description: 'show quota' },
          { name: 'compact' },
        ],
      },
    } as never);

    expect(commands).toEqual([{ sessionId: 's1', names: ['usage', 'compact'] }]);
    expect(runtime.itemsFor('s1')).toEqual([]);
  });

  it('pins the advertised mode matching the launch mode, across vocabularies', async () => {
    const { child, captured, calls } = continuableChild({
      newSessionModes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'acceptEdits', name: 'Accept Edits' },
        ],
      },
    });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start(
      's1',
      '/workspace',
      'claude',
      undefined,
      'accept-edits',
    );

    expect(opened.appliedModeId).toBe('acceptEdits');
    expect(calls.at(-1)).toEqual({
      method: 'session/set_mode',
      params: { sessionId: 'fresh-1', modeId: 'acceptEdits' },
    });
  });

  it('reports no applied mode when the agent offers nothing that matches', async () => {
    const { child, captured, calls } = continuableChild({
      newSessionModes: {
        currentModeId: 'always-proceed',
        availableModes: [{ id: 'always-proceed' }],
      },
    });
    const { runtime } = runtimeFor(child, captured);

    const opened = await runtime.start('s1', '/workspace', 'agy', undefined, 'plan');

    expect(opened.appliedModeId).toBeUndefined();
    expect(opened.modes.currentModeId).toBe('always-proceed');
    expect(calls.map((call) => call.method)).toEqual(['session/new']);
  });

  it('renders an enum elicitation as a question card and answers with the choice', async () => {
    const { child, captured } = continuableChild({});
    const timelines: ChatItem[][] = [];
    const runtime = new AcpAgentRuntime(
      {
        onTimeline: (_sessionId, items) => {
          timelines.push([...items]);
        },
        onPermission: () => new Promise<string | null>(() => undefined),
        onError: () => undefined,
      },
      (_spec, handlers) => {
        captured.handlers = handlers;
        return child;
      },
    );
    await runtime.start('s1', '/workspace');

    const pending = captured.handlers!.elicitation!.create({
      mode: 'form',
      message: 'Which branch?',
      sessionId: 'fresh-1',
      requestedSchema: {
        type: 'object',
        properties: { branch: { enum: ['main', 'dev'] } },
      },
    } as never);

    let question: Extract<ChatItem, { kind: 'question' }> | undefined;
    await vi.waitFor(() => {
      question = runtime
        .itemsFor('s1')
        .find(
          (item): item is Extract<ChatItem, { kind: 'question' }> =>
            item.kind === 'question',
        );
      expect(question).toBeDefined();
    });
    expect(question!.prompt).toBe('Which branch?');
    expect(question!.options.map((option) => option.label)).toEqual(['main', 'dev']);

    runtime.resolveControl('s1', question!.id, '1');
    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { branch: 'dev' },
    });
    const settled = runtime
      .itemsFor('s1')
      .find((item) => item.kind === 'question');
    expect(settled).toMatchObject({ selectedIndex: 1 });
    expect(timelines.length).toBeGreaterThan(1);
  });

  it('declines an elicitation nobody can render, keeping the card honest', async () => {
    const { child, captured } = continuableChild({});
    const { runtime } = runtimeFor(child, captured);
    await runtime.start('s1', '/workspace');

    const pending = captured.handlers!.elicitation!.create({
      mode: 'form',
      message: 'Fill in the deployment matrix',
      sessionId: 'fresh-1',
      requestedSchema: {
        type: 'object',
        properties: { region: { type: 'string' }, replicas: { type: 'number' } },
      },
    } as never);

    let question: Extract<ChatItem, { kind: 'question' }> | undefined;
    await vi.waitFor(() => {
      question = runtime
        .itemsFor('s1')
        .find(
          (item): item is Extract<ChatItem, { kind: 'question' }> =>
            item.kind === 'question',
        );
      expect(question).toBeDefined();
    });
    expect(question!.unrepresentable).toBe(true);
    expect(question!.options).toEqual([]);

    runtime.resolveControl('s1', question!.id, null);
    await expect(pending).resolves.toEqual({ action: 'decline' });
    expect(
      runtime.itemsFor('s1').find((item) => item.kind === 'question'),
    ).toMatchObject({ declined: true });
  });

  it('reports an unexpected child death, but not a deliberate stop', async () => {
    const exits: string[] = [];
    let fireExit!: (detail: { code: number | null; signal: string | null }) => void;
    const { child, captured } = continuableChild({});
    const observable: AcpChild = {
      ...child,
      onExit: (listener) => {
        fireExit = listener;
      },
    };
    const runtime = new AcpAgentRuntime(
      {
        onTimeline: () => undefined,
        onPermission: () => new Promise<string | null>(() => undefined),
        onError: () => undefined,
        onExit: (sessionId, detail) => {
          exits.push(`${sessionId}: ${detail}`);
        },
      },
      (_spec, handlers) => {
        captured.handlers = handlers;
        return observable;
      },
    );

    await runtime.start('s1', '/workspace');
    fireExit({ code: 1, signal: null });
    expect(exits).toEqual(['s1: exited with code 1']);
    expect(runtime.has('s1')).toBe(false);

    // A stop removes the session first, so the same exit stays silent.
    await runtime.start('s1', '/workspace');
    runtime.stop('s1');
    fireExit({ code: null, signal: 'SIGTERM' });
    expect(exits).toHaveLength(1);
  });

  it('forwards a prompt response _meta block, verbatim', async () => {
    // This is the only place agy names its conversation id; dropping it is
    // what forced Resume to guess from the disk.
    const meta = { 'cozypad.dev/agy-conversation-id': 'conv-observed' };
    const { child, captured } = continuableChild({ promptMeta: meta });
    const { runtime, promptMeta } = runtimeFor(child, captured);

    await runtime.start('s1', '/workspace');
    await runtime.prompt('s1', 'hello');

    expect(promptMeta).toEqual([{ sessionId: 's1', meta }]);
  });
});

describe('a permission request waits for the user, and only for the user', () => {
  it('does not settle on its own', async () => {
    // main.ts used to answer `null` here, which declined every tool claude and
    // codex ever tried to run — the agent asked, CozyPad said no before the
    // card was even readable, and both agents were unusable. The handler now
    // returns a promise that never settles; `resolveControl` is the only thing
    // that answers.
    const { child, captured } = fakeChild();
    const runtime = new AcpAgentRuntime(
      {
        onTimeline: () => undefined,
        // The production shape, verbatim.
        onPermission: () => new Promise<string | null>(() => undefined),
        onError: () => undefined,
      },
      (_spec, handlers) => {
        captured.handlers = handlers;
        return child;
      },
    );
    await runtime.start('s1', '/workspace');

    const pending = captured.handlers!.requestPermission!(
      permissionRequest('Write a file') as never,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);

    // And it is still answerable afterwards — the item id the timeline carries
    // is the key, so the card the user sees is the one that resolves.
    const items = runtime.itemsFor('s1');
    const approval = items.find((item) => item.kind === 'approval');
    expect(approval).toBeDefined();
    runtime.resolveControl('s1', approval!.id, 'allow');
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  }, 15_000);
});
