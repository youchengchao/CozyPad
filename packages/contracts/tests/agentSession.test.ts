import { describe, expect, it } from 'vitest';
import type { RemoteAgentSessionRecord } from '../src/agentSession';
import { agentSessionKey, bindAgentIdentity } from '../src/agentSession';

const RECORD: RemoteAgentSessionRecord = {
  id: 'uuid-1',
  identity: null,
  provisionalIdentity: {
    connectionProfileId: 'p1',
    tmuxSocket: 'default',
    tmuxSessionId: '$3',
    agentKind: 'claude',
    launchNonce: 'nonce-1',
  },
  projectId: 'proj',
  cwd: '~/projects/seg-train',
  title: 'Starting…',
  status: 'starting',
  tmuxCreatedEpoch: 1753760000,
  createdAt: 't0',
  updatedAt: 't0',
  lastEventSequence: 0,
};

describe('bindAgentIdentity (SPEC_V3 §5.3)', () => {
  it('upgrades provisional identity to the formal composite identity', () => {
    const bound = bindAgentIdentity(RECORD, {
      agentConversationId: 'conv-abc',
      remoteHostFingerprint: 'SHA256:xyz',
      tmuxPaneId: '%7',
      now: 't1',
    });
    expect(bound.identity).toEqual({
      connectionProfileId: 'p1',
      remoteHostFingerprint: 'SHA256:xyz',
      tmuxSocket: 'default',
      tmuxSessionId: '$3',
      tmuxPaneId: '%7',
      agentKind: 'claude',
      agentConversationId: 'conv-abc',
    });
    expect(bound.updatedAt).toBe('t1');
    expect(RECORD.identity).toBeNull();
  });

  it('is idempotent for the same conversation id', () => {
    const bound = bindAgentIdentity(RECORD, {
      agentConversationId: 'conv-abc',
      remoteHostFingerprint: 'fp',
      now: 't1',
    });
    expect(() =>
      bindAgentIdentity(bound, {
        agentConversationId: 'conv-abc',
        remoteHostFingerprint: 'fp',
        now: 't2',
      }),
    ).not.toThrow();
  });

  it('refuses to rebind to a different conversation (不得串錯歷史)', () => {
    const bound = bindAgentIdentity(RECORD, {
      agentConversationId: 'conv-abc',
      remoteHostFingerprint: 'fp',
      now: 't1',
    });
    expect(() =>
      bindAgentIdentity(bound, {
        agentConversationId: 'conv-OTHER',
        remoteHostFingerprint: 'fp',
        now: 't2',
      }),
    ).toThrow('refusing to rebind');
  });
});

describe('agentSessionKey (SPEC_V3 Gate A)', () => {
  const base = {
    connectionProfileId: 'p1',
    remoteHostFingerprint: 'fp',
    tmuxSocket: 'default',
    tmuxSessionId: '$3',
    agentKind: 'claude' as const,
    agentConversationId: 'conv-abc',
  };

  it('same conversation id on different hosts does not collide', () => {
    expect(agentSessionKey(base)).not.toBe(
      agentSessionKey({ ...base, connectionProfileId: 'p2' }),
    );
  });

  it('different agents in the same tmux session do not collide', () => {
    expect(agentSessionKey(base)).not.toBe(agentSessionKey({ ...base, agentKind: 'codex' }));
  });

  it('100 sessions on one host produce unique keys', () => {
    const keys = new Set(
      Array.from({ length: 100 }, (_, index) =>
        agentSessionKey({
          ...base,
          tmuxSessionId: `$${index}`,
          agentConversationId: `conv-${index}`,
        }),
      ),
    );
    expect(keys.size).toBe(100);
  });
});
