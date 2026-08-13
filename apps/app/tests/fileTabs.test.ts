import { describe, expect, it } from 'vitest';
import type { RemoteFileItem } from '@cozypad/contracts';
import {
  EMPTY_FILE_TABS,
  activateFileTab,
  activeFileTab,
  isFileTabDirty,
  removeFileTab,
  updateFileTab,
} from '../src/workspaces/fileTabs';

function file(name: string): RemoteFileItem {
  return {
    name,
    path: `/workspace/${name}`,
    type: 'f',
    sizeBytes: 100,
    modified: '2026-08-13 00:00',
  };
}

describe('file tabs', () => {
  it('keeps multiple files open and activates an existing tab without duplicating it', () => {
    const first = activateFileTab(EMPTY_FILE_TABS, file('one.ts'));
    const second = activateFileTab(first, file('two.ts'), 12);
    const backToFirst = activateFileTab(second, file('one.ts'));

    expect(backToFirst.tabs.map((tab) => tab.item.name)).toEqual(['one.ts', 'two.ts']);
    expect(backToFirst.activePath).toBe('/workspace/one.ts');
    expect(second.tabs[1]?.activeLine).toBe(12);
  });

  it('preserves an unsaved draft while another tab is active', () => {
    let state = activateFileTab(EMPTY_FILE_TABS, file('one.ts'));
    state = updateFileTab(state, '/workspace/one.ts', (tab) => ({
      ...tab,
      draft: { text: 'changed', saved: 'original' },
      loading: false,
    }));
    state = activateFileTab(state, file('two.ts'));

    expect(isFileTabDirty(state.tabs[0])).toBe(true);
    expect(activeFileTab(state)?.item.name).toBe('two.ts');
  });

  it('selects the neighbouring tab when the active tab closes', () => {
    let state = activateFileTab(EMPTY_FILE_TABS, file('one.ts'));
    state = activateFileTab(state, file('two.ts'));
    state = activateFileTab(state, file('three.ts'));

    state = removeFileTab(state, '/workspace/two.ts');
    expect(state.activePath).toBe('/workspace/three.ts');

    state = removeFileTab(state, '/workspace/three.ts');
    expect(state.activePath).toBe('/workspace/one.ts');
  });
});
