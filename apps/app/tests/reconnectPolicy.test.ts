import { describe, expect, it } from 'vitest';
import {
  isRetryableConnectError,
  reconnectDelayMs,
} from '../src/reconnectPolicy';

describe('reconnectDelayMs', () => {
  it('backs off and then remains capped', () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelayMs)).toEqual([
      2_000,
      5_000,
      10_000,
      30_000,
      30_000,
      30_000,
    ]);
  });
});

describe('isRetryableConnectError', () => {
  it('does not retry errors that require user action', () => {
    expect(isRetryableConnectError(new Error('Authentication failed'))).toBe(false);
    expect(isRetryableConnectError('Host key rejected')).toBe(false);
    expect(isRetryableConnectError('Connection cancelled')).toBe(false);
  });

  it('allows reconnecting an established session after a transient network error', () => {
    expect(isRetryableConnectError(new Error('Connection reset by peer'))).toBe(true);
    expect(isRetryableConnectError('Socket timeout')).toBe(true);
  });
});
