import type { RemoteFileItem } from '@cozypad/contracts';

export interface FileDraft {
  text: string;
  saved: string;
}

export interface FileTab {
  item: RemoteFileItem;
  activeLine?: number;
  draft?: FileDraft;
  pdfDataBase64?: string;
  imageData?: {
    dataBase64: string;
    mimeType: string;
  };
  markdownPreview: boolean;
  loading: boolean;
}

export interface FileTabsState {
  tabs: FileTab[];
  activePath: string | null;
}

export const EMPTY_FILE_TABS: FileTabsState = {
  tabs: [],
  activePath: null,
};

export function activeFileTab(state: FileTabsState): FileTab | null {
  return state.tabs.find((tab) => tab.item.path === state.activePath) ?? null;
}

export function activateFileTab(
  state: FileTabsState,
  item: RemoteFileItem,
  activeLine?: number,
): FileTabsState {
  const existingIndex = state.tabs.findIndex((tab) => tab.item.path === item.path);
  if (existingIndex < 0) {
    return {
      tabs: [
        ...state.tabs,
        {
          item,
          activeLine,
          markdownPreview: false,
          loading: true,
        },
      ],
      activePath: item.path,
    };
  }

  const tabs = state.tabs.map((tab, index) =>
    index === existingIndex
      ? {
          ...tab,
          item,
          activeLine: activeLine ?? tab.activeLine,
        }
      : tab,
  );
  return { tabs, activePath: item.path };
}

export function updateFileTab(
  state: FileTabsState,
  path: string,
  update: (tab: FileTab) => FileTab,
): FileTabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.item.path !== path) return tab;
    changed = true;
    return update(tab);
  });
  return changed ? { ...state, tabs } : state;
}

export function removeFileTab(state: FileTabsState, path: string): FileTabsState {
  const removedIndex = state.tabs.findIndex((tab) => tab.item.path === path);
  if (removedIndex < 0) return state;

  const tabs = state.tabs.filter((tab) => tab.item.path !== path);
  if (state.activePath !== path) return { ...state, tabs };

  return {
    tabs,
    activePath: tabs[Math.min(removedIndex, tabs.length - 1)]?.item.path ?? null,
  };
}

export function isFileTabDirty(tab: FileTab | null | undefined): boolean {
  return tab?.draft !== undefined && tab.draft.text !== tab.draft.saved;
}
