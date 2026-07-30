import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from '../src/reconnectPolicy';

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
