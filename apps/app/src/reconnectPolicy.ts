export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

/** Returns a capped delay so an established session keeps trying indefinitely. */
export function reconnectDelayMs(zeroBasedAttempt: number): number {
  const index = Math.max(0, Math.min(zeroBasedAttempt, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[index]!;
}
