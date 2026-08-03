import { describe, expect, it } from 'vitest';
import { TERMINAL_PAGE_SCROLL } from '../src/components/TerminalKeysBar';
import { terminalScrollLinesForTouch } from '../src/components/TerminalView';

describe('terminal scrollback controls', () => {
  it('maps page buttons to local scrollback directions', () => {
    expect(TERMINAL_PAGE_SCROLL.PGUP).toBe(-1);
    expect(TERMINAL_PAGE_SCROLL.PGDN).toBe(1);
  });

  it('turns a downward finger drag into upward scrollback lines', () => {
    expect(terminalScrollLinesForTouch(36, 18)).toBe(-2);
    expect(terminalScrollLinesForTouch(-36, 18)).toBe(2);
  });

  it('waits until a drag crosses a complete terminal row', () => {
    expect(terminalScrollLinesForTouch(17, 18)).toBe(0);
    expect(terminalScrollLinesForTouch(Number.NaN, 18)).toBe(0);
    expect(terminalScrollLinesForTouch(20, 0)).toBe(0);
  });
});
