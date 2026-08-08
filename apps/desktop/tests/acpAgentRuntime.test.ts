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
