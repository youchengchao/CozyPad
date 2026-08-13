export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

/** Returns a capped delay so an established session keeps trying indefinitely. */
export function reconnectDelayMs(zeroBasedAttempt: number): number {
  const index = Math.max(0, Math.min(zeroBasedAttempt, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[index]!;
}

const NON_RETRYABLE_CONNECT_ERRORS = [
  'authentication',
  'permission denied',
  'password',
  'credential',
  'private key',
  'host key',
  'fingerprint',
  'rejected',
  'cancelled',
  'canceled',
  'superseded',
  'unknown profile',
  'required',
  'unsupported',
] as const;

/** Authentication, trust, configuration, and user-cancel errors need input, not retries. */
export function isRetryableConnectError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return !NON_RETRYABLE_CONNECT_ERRORS.some((entry) => message.includes(entry));
}
