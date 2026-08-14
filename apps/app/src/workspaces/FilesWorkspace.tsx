import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryListing, RemoteFileItem } from '@cozypad/contracts';
import {
  MAX_FILE_TRANSFER_BYTES,
  base64ToBytes,
  textToBase64,
} from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { MarkdownView } from './agents/AssistantMarkdown';
import { CodeEditor } from '../components/CodeEditor';
import { ContextMenu, useLongPress } from '../components/ContextMenu';
import type { MenuAction } from '../components/ContextMenu';
import { FileIcon, fileKindOf } from '../components/FileIcons';
import { PdfViewer } from '../components/PdfViewer';
import { mimeTypeForFileName, saveWithBrowserDownload } from '../fileDownload';
import {
  buildFileBreadcrumbs,
  directoryItems,
  filePathsEqual,
  isFileSystemRoot,
  normalizeFilePath,
  parentFilePath,
  resolveFileLinkTarget,
  resolveFileReference,
} from './fileNavigation';
import {
  MAX_EDITABLE_TEXT_BYTES,
  decodeTextPreview,
  extensionOf,
  imagePreviewMimeType,
  isMarkdownPreviewFile,
  isTextPreviewFile,
} from './filePreview';
import {
  EMPTY_FILE_TABS,
  activateFileTab,
  activeFileTab,
  isFileTabDirty,
  removeFileTab,
  updateFileTab,
} from './fileTabs';
import type { FileTab } from './fileTabs';
import {
  FILES_SIDEBAR_DEFAULT,
  FILES_SIDEBAR_MIN,
  clampFilesSidebarWidth,
  filesSidebarMaxWidth,
} from './filesSidebarWidth';

const FILES_SIDEBAR_STORAGE_KEY = 'cozypad-files-sidebar-width';

interface FilesWorkspaceProps {
  connected: boolean;
  profileId: string | null;
  workspaceCwd: string | null;
  onWorkspaceCwdChange(cwd: string): void;
}

type DialogState =
  | null
  | { kind: 'new-file'; dir: string }
  | { kind: 'new-folder'; dir: string }
  | { kind: 'rename'; item: RemoteFileItem }
  | { kind: 'move'; item: RemoteFileItem }
  | { kind: 'copy-to'; item: RemoteFileItem }
  | { kind: 'delete'; item: RemoteFileItem };

function isPdf(item: RemoteFileItem): boolean {
  return extensionOf(item.name) === 'pdf';
}

function parentOf(path: string): string {
  return parentFilePath(path);
}

/** 單列檔案項目：右鍵與長按都會開動作選單。 */
function TreeRow({
  item,
  className,
  style,
  title,
  onClick,
  onDoubleClick,
  onOpenMenu,
  children,
}: {
  item: RemoteFileItem;
  className: string;
  style?: React.CSSProperties;
  title: string;
  onClick(): void;
  onDoubleClick(): void;
  onOpenMenu(x: number, y: number): void;
  children: React.ReactNode;
}) {
  const longPress = useLongPress(onOpenMenu);
  return (
    <button
      className={className}
      style={style}
      title={title}
      data-path={item.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      {...longPress}
    >
      {children}
    </button>
  );
}

export function FilesWorkspace({
  connected,
  profileId,
  workspaceCwd,
  onWorkspaceCwdChange,
}: FilesWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, RemoteFileItem[]>>({});
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const [menu, setMenu] = useState<{ item: RemoteFileItem; x: number; y: number } | null>(
    null,
  );
  /** 遠端剪貼簿：Copy/Move 兩段式操作的暫存（Flutter 版同款行為）。 */
  const [clipboard, setClipboard] = useState<{
    item: RemoteFileItem;
    mode: 'copy' | 'move';
  } | null>(null);
  const [fileTabs, setFileTabs] = useState(() => EMPTY_FILE_TABS);
  const [mobilePane, setMobilePane] = useState<'tree' | 'preview'>('tree');
  const [fileView, setFileView] = useState<'list' | 'grid'>('list');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogInput, setDialogInput] = useState('');
  const workspaceRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDetailsElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number>();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(FILES_SIDEBAR_STORAGE_KEY);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) return clampFilesSidebarWidth(parsed);
      }
    } catch {
      // localStorage can be unavailable in privacy-restricted webviews.
    }
    return FILES_SIDEBAR_DEFAULT;
  });
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const activeTab = activeFileTab(fileTabs);
  const selected = activeTab?.item ?? null;
  const draft = activeTab?.draft ?? null;
  const dirty = isFileTabDirty(activeTab);
  const hasOpenFiles = fileTabs.tabs.length > 0;
  const isNativeMobile = bridge.kind === 'capacitor';
  const displayedSidebarWidth = clampFilesSidebarWidth(sidebarWidth, workspaceWidth);

  useEffect(() => {
    if (selected === null) setMobilePane('tree');
  }, [selected]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWorkspaceWidth(entry.contentRect.width);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const clampSidebar = useCallback(
    (width: number) => clampFilesSidebarWidth(width, workspaceRef.current?.clientWidth),
    [],
  );

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(FILES_SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage failures; resizing still works for this session.
    }
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      sidebarDragRef.current = { startX: event.clientX, startWidth: displayedSidebarWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [displayedSidebarWidth],
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarDragRef.current === null) return;
      const width = clampSidebar(
        sidebarDragRef.current.startWidth + event.clientX - sidebarDragRef.current.startX,
      );
      setSidebarWidth(width);
      persistSidebarWidth(width);
    },
    [clampSidebar, persistSidebarWidth],
  );

  const onResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarDragRef.current === null) return;
      const width = clampSidebar(
        sidebarDragRef.current.startWidth + event.clientX - sidebarDragRef.current.startX,
      );
      sidebarDragRef.current = null;
      setSidebarWidth(width);
      persistSidebarWidth(width);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Capture may already be released by the browser.
      }
    },
    [clampSidebar, persistSidebarWidth],
  );

  const onResizeDoubleClick = useCallback(() => {
    setSidebarWidth(FILES_SIDEBAR_DEFAULT);
    persistSidebarWidth(FILES_SIDEBAR_DEFAULT);
  }, [persistSidebarWidth]);

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  };

  const report = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const loadDir = useCallback(
    async (path: string): Promise<DirectoryListing | null> => {
      try {
        const listing = await bridge.fsList({ path });
        const normalizedListing: DirectoryListing = {
          ...listing,
          path: normalizeFilePath(listing.path),
          items: listing.items.map((item) => ({
            ...item,
            path: normalizeFilePath(item.path),
          })),
        };
        setChildren((current) => ({
          ...current,
          [normalizedListing.path]: normalizedListing.items,
        }));
        setTruncatedDirs((current) => {
          const next = new Set(current);
          if (normalizedListing.truncated) next.add(normalizedListing.path);
          else next.delete(normalizedListing.path);
          return next;
        });
        setError(null);
        return normalizedListing;
      } catch (err: unknown) {
        report(err);
        return null;
      }
    },
    [bridge],
  );

  /** 切換目前目錄（Home、/、breadcrumb 或任意路徑）。 */
  const openPath = useCallback(
    async (path: string) => {
      const listing = await loadDir(path);
      if (listing === null) return;
      setCurrentPath(listing.path);
      setMobilePane('tree');
    },
    [loadDir],
  );

  useEffect(() => {
    if (!connected) {
      setCurrentPath(null);
      setChildren({});
      setFileTabs(EMPTY_FILE_TABS);
      return;
    }
    const requested = workspaceCwd ?? '~';
    void loadDir('~').then(async (home) => {
      if (home === null) return;
      setHomePath(home.path);
      const listing =
        requested === '~' || requested === home.path
          ? home
          : await loadDir(requested);
      const resolved = listing ?? home;
      setCurrentPath(resolved.path);
      onWorkspaceCwdChange(resolved.path);
    });
    // PWD changes made inside this workspace should update the marker without
    // restarting navigation. Reinitialize only when the connected host changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, profileId, loadDir, onWorkspaceCwdChange]);

  /** symlink：指向目錄就跳過去，指向檔案就開目標。 */
  const followSymlink = (
    item: RemoteFileItem,
    line?: number,
    visited: readonly string[] = [],
  ) => {
    if (visited.some((path) => filePathsEqual(path, item.path))) {
      setError(`Symbolic-link cycle detected at ${item.path}`);
      return;
    }
    const target = item.linkTarget;
    if (target === undefined || item.targetType === 'N') {
      setError(`連結目標不存在：${target ?? '(未知)'}`);
      return;
    }
    const absolute = resolveFileLinkTarget(item.path, target);
    if (item.targetType === 'd') {
      void openPath(absolute);
      showFlash('已跳到連結目標');
      return;
    }
    void bridge
      .fsList({ path: parentOf(absolute) })
      .then((listing) => {
        const found = listing.items.find(
          (entry) => filePathsEqual(entry.path, absolute),
        );
        if (found?.type === 'l') {
          followSymlink(found, line, [...visited, item.path]);
        } else if (found) openFile(found, line);
        else setError(`找不到連結目標：${absolute}`);
      })
      .catch(report);
  };

  /** 關閉分頁前保護該檔案尚未儲存的編輯。 */
  const confirmDiscard = (tab: FileTab | null): boolean => {
    if (tab === null || !isFileTabDirty(tab)) return true;
    return window.confirm(
      `${tab.item.name} 尚有未儲存的變更，確定關閉？`,
    );
  };

  const discardFile = (path: string) => {
    setFileTabs((current) => removeFileTab(current, path));
  };

  const closeFile = (path: string) => {
    const tab = fileTabs.tabs.find((candidate) => candidate.item.path === path) ?? null;
    if (!confirmDiscard(tab)) return;
    discardFile(path);
  };

  const openFile = (item: RemoteFileItem, line?: number) => {
    if (item.type === 'l') {
      followSymlink(item, line);
      return;
    }
    const existing = fileTabs.tabs.some((tab) => tab.item.path === item.path);
    setFileTabs((current) => activateFileTab(current, item, line));
    setMobilePane('preview');
    if (existing) return;

    const imageMimeType = imagePreviewMimeType(item);
    if (imageMimeType !== null) {
      setBusy(true);
      void bridge
        .fsReadBytes({ path: item.path, maxBytes: MAX_EDITABLE_TEXT_BYTES })
        .then(({ dataBase64 }) => {
          setFileTabs((current) =>
            updateFileTab(current, item.path, (tab) => ({
              ...tab,
              imageData: { dataBase64, mimeType: imageMimeType },
            })),
          );
        })
        .catch(report)
        .finally(() => {
          setFileTabs((current) =>
            updateFileTab(current, item.path, (tab) => ({ ...tab, loading: false })),
          );
          setBusy(false);
        });
      return;
    }

    if (isPdf(item)) {
      setBusy(true);
      void bridge
        .fsReadBytes({ path: item.path, maxBytes: MAX_EDITABLE_TEXT_BYTES })
        .then(({ dataBase64 }) => {
          setFileTabs((current) =>
            updateFileTab(current, item.path, (tab) => ({
              ...tab,
              pdfDataBase64: dataBase64,
            })),
          );
        })
        .catch(report)
        .finally(() => {
          setFileTabs((current) =>
            updateFileTab(current, item.path, (tab) => ({ ...tab, loading: false })),
          );
          setBusy(false);
        });
      return;
    }

    if (!isTextPreviewFile(item) || item.sizeBytes > MAX_EDITABLE_TEXT_BYTES) {
      setFileTabs((current) =>
        updateFileTab(current, item.path, (tab) => ({ ...tab, loading: false })),
      );
      return;
    }
    void bridge
      .fsReadBytes({ path: item.path, maxBytes: MAX_EDITABLE_TEXT_BYTES })
      .then(({ dataBase64 }) => {
        const content = decodeTextPreview(base64ToBytes(dataBase64));
        if (content === null) {
          throw new Error(
            `Cannot open ${item.name} as text because it is binary or is not UTF-8.`,
          );
        }
        setFileTabs((current) =>
          updateFileTab(current, item.path, (tab) => ({
            ...tab,
            draft: { text: content, saved: content },
            markdownPreview: isMarkdownPreviewFile(item),
            loading: false,
          })),
        );
      })
      .catch((err: unknown) => {
        report(err);
        setFileTabs((current) =>
          updateFileTab(current, item.path, (tab) => ({ ...tab, loading: false })),
        );
      });
  };

  const openFileByPath = useCallback(
    (absolute: string, line?: number) => {
      const normalizedAbsolute = normalizeFilePath(absolute);
      const parent = parentOf(normalizedAbsolute);
      void loadDir(parent).then((listing) => {
        if (listing === null) return;
        const listedItem = listing.items.find((item) =>
          filePathsEqual(item.path, normalizedAbsolute),
        );
        if (
          listedItem?.type === 'd'
        ) {
          void openPath(listedItem.path);
          return;
        }
        if (listedItem?.type === 'l') {
          setCurrentPath(listing.path);
          followSymlink(listedItem, line);
          return;
        }
        const item: RemoteFileItem =
          listedItem?.type === 'f'
            ? listedItem
            : {
                name: normalizedAbsolute.slice(normalizedAbsolute.lastIndexOf('/') + 1),
                path: normalizedAbsolute,
                type: 'f',
                sizeBytes: 0,
                modified: '',
              };
        setCurrentPath(listing.path);
        openFile(item, line);
      });
    },
    [loadDir, openPath, openFile],
  );

  useEffect(() => {
    const handleOpenFile = (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string; cwd?: string }>;
      if (!customEvent.detail?.path) return;
      const location = resolveFileReference(
        customEvent.detail.path,
        customEvent.detail.cwd,
      );
      if (location === null) return;
      openFileByPath(location.path, location.line);
    };
    window.addEventListener('cozypad:open-file', handleOpenFile);
    return () => {
      window.removeEventListener('cozypad:open-file', handleOpenFile);
    };
  }, [openFileByPath]);

  const refreshDirs = async (...paths: (string | null)[]) => {
    for (const path of paths) {
      if (path !== null && (children[path] !== undefined || path === currentPath)) {
        await loadDir(path);
      }
    }
  };

  const saveDraft = () => {
    const path = activeTab?.item.path;
    if (!draft || path === undefined) return;
    const savedText = draft.text;
    setBusy(true);
    bridge
      .fsWrite({ path, contentBase64: textToBase64(savedText) })
      .then(() => {
        setFileTabs((current) =>
          updateFileTab(current, path, (tab) => ({
            ...tab,
            draft: tab.draft
              ? { ...tab.draft, saved: savedText }
              : tab.draft,
          })),
        );
        showFlash('已儲存');
        void refreshDirs(parentOf(path));
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const download = (target?: RemoteFileItem) => {
    const item = target ?? selected;
    if (!item || item.type === 'd') return;
    setBusy(true);
    bridge
      .fsReadBytes({ path: item.path, maxBytes: MAX_FILE_TRANSFER_BYTES })
      .then(async ({ dataBase64 }) => {
        const request = {
          fileName: item.name,
          dataBase64,
          mimeType: mimeTypeForFileName(item.name),
        };
        if (bridge.saveDownload !== undefined) {
          const result = await bridge.saveDownload(request);
          if (!result.cancelled) showFlash(`已下載 ${result.fileName}`);
          return;
        }
        saveWithBrowserDownload(request);
        showFlash(`已開始下載 ${item.name}`);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const duplicate = (target?: RemoteFileItem) => {
    const item = target ?? selected;
    if (!item) return;
    setBusy(true);
    bridge
      .fsDuplicate({ path: item.path })
      .then(() => {
        showFlash('已建立副本');
        void refreshDirs(parentOf(item.path));
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const confirmDialog = () => {
    if (dialog === null) return;
    const input = dialogInput.trim();
    setBusy(true);
    const done = (message: string, ...refresh: (string | null)[]) => {
      showFlash(message);
      setDialog(null);
      setDialogInput('');
      void refreshDirs(...refresh);
    };

    let action: Promise<void>;
    if (dialog.kind === 'new-file' || dialog.kind === 'new-folder') {
      if (input === '') {
        setBusy(false);
        return;
      }
      action = bridge
        .fsCreate({
          directory: dialog.dir,
          name: input,
          kind: dialog.kind === 'new-file' ? 'file' : 'directory',
        })
        .then(() => done(dialog.kind === 'new-file' ? '已建立檔案' : '已建立資料夾', dialog.dir));
    } else if (dialog.kind === 'rename') {
      if (input === '') {
        setBusy(false);
        return;
      }
      action = bridge
        .fsRename({ path: dialog.item.path, newName: input })
        .then(() => {
          discardFile(dialog.item.path);
          done('已重新命名', parentOf(dialog.item.path));
        });
    } else if (dialog.kind === 'move' || dialog.kind === 'copy-to') {
      if (input === '') {
        setBusy(false);
        return;
      }
      const call =
        dialog.kind === 'move'
          ? bridge.fsMove({ sourcePath: dialog.item.path, destinationDirectory: input })
          : bridge.fsCopy({ sourcePath: dialog.item.path, destinationDirectory: input });
      action = call.then(({ path }) => {
        if (dialog.kind === 'move') {
          discardFile(dialog.item.path);
        }
        done(dialog.kind === 'move' ? '已移動' : '已複製', parentOf(dialog.item.path), parentOf(path));
      });
    } else {
      action = bridge.fsDelete({ path: dialog.item.path }).then(() => {
        discardFile(dialog.item.path);
        done('已刪除', parentOf(dialog.item.path));
      });
    }
    action.catch(report).finally(() => setBusy(false));
  };

  const currentDir = currentPath ?? workspaceCwd ?? '~';

  const closeFileMenu = () => {
    mobileMenuRef.current?.removeAttribute('open');
  };

  const openPathDialog = () => {
    closeFileMenu();
    setJumpValue(currentDir);
    setJumpOpen(true);
  };

  const openCreateDialog = (kind: 'new-file' | 'new-folder') => {
    closeFileMenu();
    setDialogInput('');
    setDialog({ kind, dir: currentDir });
  };

  // 有未存檔內容時關閉 app／重新整理要先提醒。
  useEffect(() => {
    if (!fileTabs.tabs.some((tab) => isFileTabDirty(tab))) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [fileTabs.tabs]);

  const renderListing = (dirPath: string) => {
    const items = directoryItems(children, dirPath);
    if (items === undefined) {
      return <div className="hint tree-loading">載入中…</div>;
    }
    const rows = items.map((item) => {
      const isDir = item.type === 'd';
      const kind = fileKindOf(item);
      const active = selected?.path === item.path;
      const open = fileTabs.tabs.some((tab) => tab.item.path === item.path);
      return (
        <div key={item.path} className="file-item-wrap">
          <TreeRow
            item={item}
            className={`${fileView === 'grid' ? 'file-grid-card' : 'tree-row'}${active ? ' tree-row-active' : ''}${open ? ' file-item-open' : ''}`}
            onOpenMenu={(x, y) => setMenu({ item, x, y })}
            onClick={() => {
              if (isDir) void openPath(item.path);
              else openFile(item);
            }}
            onDoubleClick={() => {
              if (item.type === 'l') followSymlink(item);
            }}
            title={
              item.type === 'l'
                ? `${item.path} → ${item.linkTarget ?? '?'}（雙擊跳轉）`
                : `${item.path}（右鍵或長按顯示選單）`
            }
          >
            {fileView === 'grid' ? (
              <>
                <FileIcon kind={kind} size={34} />
                <span className="file-grid-name">{item.name}</span>
                <span className="file-grid-meta">
                  {isDir ? 'Folder' : `${Math.max(1, Math.ceil(item.sizeBytes / 1024))} KB`}
                </span>
              </>
            ) : (
              <>
                <span className={`tree-caret${isDir ? '' : ' tree-caret-empty'}`}>
                  {isDir ? '›' : ''}
                </span>
                <FileIcon kind={kind} />
                <span className="tree-name">{item.name}</span>
                {item.type === 'l' ? <span className="tree-arrow">→</span> : null}
                {item.executable === true && item.type === 'f' ? (
                  <span className="tree-badge tree-badge-exec">x</span>
                ) : null}
                {item.path === workspaceCwd ? <span className="pwd-badge">pwd</span> : null}
              </>
            )}
          </TreeRow>
        </div>
      );
    });

    if (truncatedDirs.has(dirPath)) {
      rows.push(
        <div key={`${dirPath}__truncated`} className="hint tree-truncated">
          僅顯示前 2000 筆（目錄過大）
        </div>,
      );
    }
    return (
      <div className={`file-items file-items-${fileView}`}>
        {rows}
      </div>
    );
  };

  const copyToClipboardText = (text: string, label: string) => {
    void bridge
      .writeClipboard(text)
      .then(() => showFlash(label))
      .catch(report);
  };

  const relativePath = (item: RemoteFileItem): string => {
    const base = currentPath;
    if (base !== null && item.path.startsWith(`${base}/`)) {
      return item.path.slice(base.length + 1);
    }
    return item.name;
  };

  const menuActionsFor = (item: RemoteFileItem): MenuAction[] => {
    const isDir = item.type === 'd';
    const isLink = item.type === 'l';
    return [
      {
        id: 'open',
        label: isDir ? 'Open folder' : isLink ? 'Follow link' : 'Open / edit file',
      },
      { id: 'rename', label: 'Rename', separatorBefore: true },
      { id: 'stageCopy', label: 'Copy', hint: '暫存後貼到其他資料夾' },
      { id: 'stageMove', label: 'Move', hint: '暫存後貼到其他資料夾' },
      { id: 'duplicate', label: 'Duplicate here', hint: '在同資料夾建立副本' },
      { id: 'copyName', label: 'Copy name', separatorBefore: true },
      { id: 'copyAbs', label: 'Copy abs path' },
      { id: 'copyRel', label: 'Copy rel path' },
      ...(isDir
        ? [{ id: 'setPwd', label: 'Set PWD', hint: '新 Terminal／Agent 分頁的工作目錄' }]
        : []),
      ...(item.type === 'f'
        ? [{ id: 'download', label: 'Download', separatorBefore: true }]
        : []),
      { id: 'delete', label: 'Delete', danger: true, separatorBefore: true },
    ];
  };

  const runMenuAction = (item: RemoteFileItem, actionId: string) => {
    switch (actionId) {
      case 'open':
        if (item.type === 'd') {
          void openPath(item.path);
        } else if (item.type === 'l') {
          followSymlink(item);
        } else {
          openFile(item);
        }
        return;
      case 'rename':
        setDialogInput(item.name);
        setDialog({ kind: 'rename', item });
        return;
      case 'stageCopy':
        setClipboard({ item, mode: 'copy' });
        showFlash(`已暫存複製：${item.name}`);
        return;
      case 'stageMove':
        setClipboard({ item, mode: 'move' });
        showFlash(`已暫存移動：${item.name}`);
        return;
      case 'duplicate':
        duplicate(item);
        return;
      case 'copyName':
        copyToClipboardText(item.name, '已複製檔名');
        return;
      case 'copyAbs':
        copyToClipboardText(item.path, '已複製絕對路徑');
        return;
      case 'copyRel':
        copyToClipboardText(relativePath(item), '已複製相對路徑');
        return;
      case 'setPwd':
        onWorkspaceCwdChange(item.path);
        showFlash('已設定 pwd');
        return;
      case 'download':
        setTimeout(() => download(item), 0);
        return;
      case 'delete':
        setDialog({ kind: 'delete', item });
        return;
    }
  };

  /** 把暫存的項目貼進目標資料夾（Copy/Move 的第二段）。 */
  const pasteClipboard = (destination: string) => {
    if (clipboard === null) return;
    const { item, mode } = clipboard;
    setBusy(true);
    const call =
      mode === 'copy'
        ? bridge.fsCopy({ sourcePath: item.path, destinationDirectory: destination })
        : bridge.fsMove({ sourcePath: item.path, destinationDirectory: destination });
    void call
      .then(({ path }) => {
        showFlash(mode === 'copy' ? '已複製' : '已移動');
        if (mode === 'move') {
          setClipboard(null);
          discardFile(item.path);
        }
        void refreshDirs(parentOf(item.path), parentOf(path), destination);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const breadcrumbs = buildFileBreadcrumbs(currentDir);


  if (!connected) {
    return (
      <div className="placeholder">
        <p>Connect to browse remote files.</p>
        <p className="hint">連線後從家目錄開始瀏覽。</p>
      </div>
    );
  }

  return (
    <div
      className={`files-workspace mobile-pane-${mobilePane}${
        isNativeMobile ? ' native-mobile' : ''
      }${hasOpenFiles ? ' files-has-open-files' : ' files-browser-only'}${
        sidebarCollapsed && hasOpenFiles && !isNativeMobile ? ' files-sidebar-collapsed' : ''
      }`}
      ref={workspaceRef}
    >
      <aside className="files-tree" style={{ width: displayedSidebarWidth }}>
        <details className="files-mobile-menu" ref={mobileMenuRef}>
          <summary aria-label="File browser menu">
            <span className="files-mobile-menu-title">Files</span>
            <span className="mono files-mobile-menu-path" title={currentDir}>
              {currentDir}
            </span>
            <span aria-hidden="true">&#9776;</span>
          </summary>
          <div className="files-mobile-menu-panel">
            <button
              type="button"
              aria-current={
                currentPath !== null && currentPath === homePath ? 'location' : undefined
              }
              onClick={() => {
                closeFileMenu();
                void openPath('~');
              }}
            >
              ⌂ Home
            </button>
            <button
              type="button"
              aria-current={currentPath === '/' ? 'location' : undefined}
              onClick={() => {
                closeFileMenu();
                void openPath('/');
              }}
            >
              / Root
            </button>
            {workspaceCwd !== null ? (
              <button
                type="button"
                aria-current={workspaceCwd === currentPath ? 'location' : undefined}
                onClick={() => {
                  closeFileMenu();
                  void openPath(workspaceCwd);
                }}
              >
                ↦ pwd
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Enter file path"
              onClick={openPathDialog}
            >
              ⤓ 路徑…
            </button>
            <button
              type="button"
              onClick={() => openCreateDialog('new-file')}
            >
              ＋檔案
            </button>
            <button
              type="button"
              onClick={() => openCreateDialog('new-folder')}
            >
              ＋資料夾
            </button>
            <button
              type="button"
              onClick={() => {
                closeFileMenu();
                void refreshDirs(...Object.keys(children));
              }}
            >
              ↻ 重新整理
            </button>
            <button
              type="button"
              aria-pressed={fileView === 'list'}
              onClick={() => {
                closeFileMenu();
                setFileView(fileView === 'list' ? 'grid' : 'list');
              }}
            >
              {fileView === 'list' ? '▦ 圖示檢視' : '☷ 列表檢視'}
            </button>
          </div>
        </details>
        <div className="files-roots">
          <button
            className={currentPath !== null && currentPath === homePath ? 'root-active' : ''}
            onClick={() => void openPath('~')}
            title="家目錄"
          >
            ⌂ Home
          </button>
          <button
            className={currentPath === '/' ? 'root-active' : ''}
            onClick={() => void openPath('/')}
            title="根目錄"
          >
            / Root
          </button>
          {workspaceCwd !== null && workspaceCwd !== currentPath ? (
            <button onClick={() => void openPath(workspaceCwd)} title="切換到 pwd">
              ↦ pwd
            </button>
          ) : null}
          <button
            onClick={openPathDialog}
            title="跳到指定路徑"
          >
            ⤓ 路徑…
          </button>
        </div>
        <div className="files-toolbar">
          <button onClick={() => openCreateDialog('new-file')}>
            ＋檔案
          </button>
          <button onClick={() => openCreateDialog('new-folder')}>
            ＋資料夾
          </button>
          <button onClick={() => void refreshDirs(...Object.keys(children))} title="重新整理">
            ↻
          </button>
          <span className="file-view-toggle" role="group" aria-label="File view">
            <button
              type="button"
              className={fileView === 'list' ? 'view-active' : ''}
              aria-label="List view"
              aria-pressed={fileView === 'list'}
              title="列表檢視"
              onClick={() => setFileView('list')}
            >
              ☷
            </button>
            <button
              type="button"
              className={fileView === 'grid' ? 'view-active' : ''}
              aria-label="Grid view"
              aria-pressed={fileView === 'grid'}
              title="圖示檢視"
              onClick={() => setFileView('grid')}
            >
              ▦
            </button>
          </span>
            {hasOpenFiles ? (
              <button
                type="button"
                className="files-sidebar-collapse"
                aria-label="Collapse file sidebar"
                title="Collapse file sidebar"
                onClick={() => setSidebarCollapsed(true)}
              >
                &lsaquo;
              </button>
            ) : null}
        </div>
        {clipboard !== null ? (
          <div className="clipboard-bar">
            <span className={`clip-mode clip-${clipboard.mode}`}>
              {clipboard.mode === 'copy' ? '複製' : '移動'}
            </span>
            <span className="clip-name" title={clipboard.item.path}>
              {clipboard.item.name}
            </span>
            <button
              className="primary"
              disabled={busy}
              title={`貼到 ${currentDir}`}
              onClick={() => pasteClipboard(currentDir)}
            >
              貼到此處
            </button>
            <button className="clip-cancel" onClick={() => setClipboard(null)} title="取消">
              ×
            </button>
          </div>
        ) : null}
        <div className="tree-scroll">
          {currentPath !== null ? (
            <>
              <button
                className={`tree-row tree-root-row${selected === null ? ' tree-row-active' : ''}`}
                onClick={() => void refreshDirs(currentPath)}
                title={`${currentPath}（重新整理）`}
              >
                <span className="tree-caret">↻</span>
                <FileIcon kind="folder-open" />
                <span className="tree-name mono">{currentPath}</span>
              </button>
              {!isFileSystemRoot(currentPath) ? (
                <button
                  className="tree-row tree-parent-row"
                  onClick={() => void openPath(parentOf(currentPath))}
                  title={parentOf(currentPath)}
                >
                  <span className="tree-caret">↑</span>
                  <FileIcon kind="folder" />
                  <span className="tree-name">..</span>
                </button>
              ) : null}
              {renderListing(currentPath)}
            </>
          ) : (
            <div className="hint tree-loading">載入中…</div>
          )}
        </div>
      </aside>
      <div
        className="pane-resize-handle files-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={onResizeDoubleClick}
        role="separator"
        aria-label="Resize file sidebar"
        aria-orientation="vertical"
        aria-valuenow={Math.round(displayedSidebarWidth)}
        aria-valuemin={FILES_SIDEBAR_MIN}
        aria-valuemax={filesSidebarMaxWidth(workspaceWidth)}
        title="拖曳調整側欄寬度，連按兩下重設"
      />
      <div className="files-preview">
        {fileTabs.tabs.length > 0 ? (
          <div className="file-tabs" role="tablist" aria-label="Open files">
            <button
              type="button"
              className="files-sidebar-show"
              aria-label="Show file sidebar"
              title="Show file sidebar"
              onClick={() => setSidebarCollapsed(false)}
            >
              Files
            </button>
            {fileTabs.tabs.map((tab) => {
              const tabDirty = isFileTabDirty(tab);
              const tabActive = tab.item.path === fileTabs.activePath;
              return (
                <div
                  key={tab.item.path}
                  className={`file-tab${tabActive ? ' file-tab-active' : ''}`}
                >
                  <button
                    type="button"
                    className="file-tab-main"
                    role="tab"
                    aria-selected={tabActive}
                    title={tab.item.path}
                    onClick={() => {
                      setFileTabs((current) => ({ ...current, activePath: tab.item.path }));
                      setMobilePane('preview');
                    }}
                  >
                    <FileIcon kind={fileKindOf(tab.item)} />
                    <span>{tab.item.name}</span>
                    {tabDirty ? <span className="file-tab-dirty" aria-label="Unsaved">●</span> : null}
                  </button>
                  <button
                    type="button"
                    className="file-tab-close"
                    aria-label={`Close ${tab.item.name}`}
                    onClick={() => closeFile(tab.item.path)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="breadcrumb-bar">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="crumb-wrap">
              {index > 0 ? <span className="crumb-sep">/</span> : null}
              <button className="crumb" onClick={() => void openPath(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {selected ? (
          <>
            <div className="files-preview-head">
              <button
                type="button"
                className="mobile-file-close"
                onClick={() => setMobilePane('tree')}
                aria-label="Return to file list"
              >
                <span aria-hidden="true">&larr;</span>
                Files
              </button>
              <span className="mono files-path">{selected.path}</span>
              {flash ? <span className="flash">{flash}</span> : null}
              <div className="files-actions">
                {selected.type === 'd' ? (
                  <button onClick={() => onWorkspaceCwdChange(selected.path)}>Set pwd</button>
                ) : null}
                {draft ? (
                  <button className={dirty ? 'primary' : ''} disabled={busy} onClick={saveDraft}>
                    儲存{dirty ? ' •' : ''}
                  </button>
                ) : null}
                {draft && isMarkdownPreviewFile(selected) ? (
                  <button
                    onClick={() =>
                      setFileTabs((current) =>
                        updateFileTab(current, selected.path, (tab) => ({
                          ...tab,
                          markdownPreview: !tab.markdownPreview,
                        })),
                      )
                    }
                  >
                    {activeTab?.markdownPreview ? '編輯' : '預覽'}
                  </button>
                ) : null}
                <button onClick={() => copyToClipboardText(selected.path, '路徑已複製')}>
                  Copy path
                </button>
                <button disabled={busy} onClick={() => duplicate()}>
                  Copy
                </button>
                <button onClick={() => setDialog({ kind: 'copy-to', item: selected })}>
                  Copy to…
                </button>
                <button onClick={() => setDialog({ kind: 'move', item: selected })}>
                  Move
                </button>
                <button onClick={() => setDialog({ kind: 'rename', item: selected })}>
                  Rename
                </button>
                {selected.type !== 'd' ? (
                  <button disabled={busy} onClick={() => download()}>
                    Download
                  </button>
                ) : null}
                <button
                  className="danger"
                  onClick={() => setDialog({ kind: 'delete', item: selected })}
                >
                  Delete
                </button>
              </div>
            </div>
            {selected.type === 'l' ? (
              <div className="placeholder link-card">
                <p>
                  <FileIcon kind={fileKindOf(selected)} size={22} />
                </p>
                <p className="mono link-target">→ {selected.linkTarget ?? '(未知目標)'}</p>
                <p className="hint">
                  {selected.targetType === 'd'
                    ? '指向資料夾'
                    : selected.targetType === 'N'
                      ? '目標不存在（斷鏈）'
                      : '指向檔案'}
                </p>
                <button
                  className="primary"
                  disabled={selected.targetType === 'N'}
                  onClick={() => followSymlink(selected)}
                >
                  跳到目標
                </button>
              </div>
            ) : selected.type === 'd' ? (
              <div className="placeholder">
                <p>{children[selected.path]?.length ?? '…'} 個項目</p>
                <p className="hint">pwd: {workspaceCwd ?? '—'}</p>
              </div>
            ) : activeTab?.loading ? (
              <div className="placeholder">
                <p>載入檔案…</p>
              </div>
            ) : imagePreviewMimeType(selected) !== null ? (
              activeTab?.imageData ? (
                <div className="image-preview" data-testid="file-image-preview">
                  <img
                    src={`data:${activeTab.imageData.mimeType};base64,${activeTab.imageData.dataBase64}`}
                    alt={selected.name}
                  />
                  <span>
                    {(selected.sizeBytes / 1024).toFixed(1)} KB · {activeTab.imageData.mimeType}
                  </span>
                </div>
              ) : (
                <div className="placeholder">
                  <p>載入圖片…</p>
                </div>
              )
            ) : isPdf(selected) ? (
              activeTab?.pdfDataBase64 ? (
                <PdfViewer dataBase64={activeTab.pdfDataBase64} fileName={selected.name} />
              ) : (
                <div className="placeholder">
                  <p>載入 PDF…</p>
                </div>
              )
            ) : draft && isMarkdownPreviewFile(selected) && activeTab?.markdownPreview ? (
              <div className="md-preview markdown markdown-doc">
                <MarkdownView>{draft.text}</MarkdownView>
              </div>
            ) : draft ? (
              <CodeEditor
                path={selected.path}
                value={draft.text}
                line={activeTab?.activeLine}
                onChange={(text) =>
                  setFileTabs((current) =>
                    updateFileTab(current, selected.path, (tab) => ({
                      ...tab,
                      draft: tab.draft
                        ? {
                            ...tab.draft,
                            text,
                          }
                        : tab.draft,
                    })),
                  )
                }
                onSave={saveDraft}
              />
            ) : (
              <div className="placeholder">
                <p>{selected.name}</p>
                <p className="hint">
                  {(selected.sizeBytes / 1024).toFixed(1)} KB · {selected.modified} ·
                  {isTextPreviewFile(selected)
                    ? ' 檔案過大，僅供 Download'
                    : ' 二進位格式不做文字預覽（SPEC FR-04）'}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="placeholder">
            <p>選一個檔案或資料夾。</p>
          </div>
        )}
      </div>

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.name}
          subtitle={menu.item.path}
          actions={menuActionsFor(menu.item)}
          onSelect={(actionId) => runMenuAction(menu.item, actionId)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {jumpOpen ? (
        <div className="modal-overlay" onClick={() => setJumpOpen(false)}>
          <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>跳到路徑</h2>
              <button className="modal-close" onClick={() => setJumpOpen(false)}>
                ×
              </button>
            </div>
            <input
              autoFocus
              className="mono"
              value={jumpValue}
              placeholder="/var/log 或 ~/projects"
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && jumpValue.trim() !== '') {
                  void openPath(jumpValue.trim());
                  setJumpOpen(false);
                }
              }}
            />
            <p className="hint">支援 ~ 展開；只讀取該層目錄，不遞迴掃描。</p>
            <div className="form-actions">
              <button onClick={() => setJumpOpen(false)}>取消</button>
              <button
                className="primary"
                disabled={jumpValue.trim() === ''}
                onClick={() => {
                  void openPath(jumpValue.trim());
                  setJumpOpen(false);
                }}
              >
                前往
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
            {dialog.kind === 'delete' ? (
              <>
                <p>
                  確定刪除 <span className="mono">{dialog.item.path}</span>？
                  {dialog.item.type === 'd' ? '（含其中所有內容）' : ''}
                </p>
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="danger" disabled={busy} onClick={confirmDialog}>
                    刪除
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {dialog.kind === 'new-file'
                    ? `在 ${dialog.dir} 新增檔案`
                    : dialog.kind === 'new-folder'
                      ? `在 ${dialog.dir} 新增資料夾`
                      : dialog.kind === 'rename'
                        ? `重新命名 ${dialog.item.name}`
                        : dialog.kind === 'move'
                          ? `把 ${dialog.item.name} 移動到（目標資料夾路徑）`
                          : `把 ${dialog.item.name} 複製到（目標資料夾路徑）`}
                </p>
                <input
                  autoFocus
                  value={dialogInput}
                  placeholder={
                    dialog.kind === 'move' || dialog.kind === 'copy-to'
                      ? currentDir
                      : dialog.kind === 'rename'
                        ? dialog.item.name
                        : '名稱'
                  }
                  onChange={(event) => setDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') confirmDialog();
                  }}
                />
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="primary" disabled={busy} onClick={confirmDialog}>
                    確定
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
