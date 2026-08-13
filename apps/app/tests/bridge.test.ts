import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '@cozypad/contracts';
import { wrapResilientBridge } from '../src/platform/bridge';

afterEach(() => {
  vi.useRealTimers();
});

describe('wrapResilientBridge', () => {
  it('preserves a domain request ID when responding to a host-key prompt', async () => {
    const respondHostKey = vi.fn(async () => undefined);
    const rawBridge = {
      kind: 'capacitor',
      respondHostKey,
      cancelRequest: vi.fn(async () => undefined),
    } as unknown as PlatformBridge;

    const bridge = wrapResilientBridge(rawBridge);
    await bridge.respondHostKey({ requestId: 'hk-1', accept: true });

    expect(respondHostKey).toHaveBeenCalledWith({
      requestId: 'hk-1',
      accept: true,
    });
  });

  it('does not apply the generic IPC timeout to an interactive connect', async () => {
    vi.useFakeTimers();
    let finishConnect!: () => void;
    const connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = resolve;
        }),
    );
    const cancelRequest = vi.fn(async () => undefined);
    const rawBridge = {
      kind: 'capacitor',
      connect,
      cancelRequest,
    } as unknown as PlatformBridge;

    const bridge = wrapResilientBridge(rawBridge);
    const connecting = bridge.connect({ profileId: 'profile-1' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(cancelRequest).not.toHaveBeenCalled();
    finishConnect();
    await expect(connecting).resolves.toBeUndefined();
  });
});
