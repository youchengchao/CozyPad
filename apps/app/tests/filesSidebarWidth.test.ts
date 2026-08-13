import { describe, expect, it } from 'vitest';
import {
  FILES_SIDEBAR_DEFAULT,
  FILES_SIDEBAR_MAX,
  FILES_SIDEBAR_MIN,
  clampFilesSidebarWidth,
  filesSidebarMaxWidth,
} from '../src/workspaces/filesSidebarWidth';

describe('file sidebar width', () => {
  it('clamps persisted and dragged widths to the absolute bounds', () => {
    expect(clampFilesSidebarWidth(40)).toBe(FILES_SIDEBAR_MIN);
    expect(clampFilesSidebarWidth(900)).toBe(FILES_SIDEBAR_MAX);
    expect(clampFilesSidebarWidth(Number.NaN)).toBe(FILES_SIDEBAR_DEFAULT);
  });

  it('adapts the maximum width to preserve the file preview', () => {
    expect(filesSidebarMaxWidth(900)).toBe(536);
    expect(clampFilesSidebarWidth(580, 900)).toBe(536);
    expect(filesSidebarMaxWidth(1400)).toBe(FILES_SIDEBAR_MAX);
  });

  it('never shrinks below the usable sidebar minimum', () => {
    expect(filesSidebarMaxWidth(400)).toBe(FILES_SIDEBAR_MIN);
    expect(clampFilesSidebarWidth(300, 400)).toBe(FILES_SIDEBAR_MIN);
  });
});
