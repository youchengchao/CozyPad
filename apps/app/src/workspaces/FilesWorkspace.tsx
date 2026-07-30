import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RemoteFileItem } from '@cozypad/contracts';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { CodeEditor } from '../components/CodeEditor';
import { ContextMenu, useLongPress } from '../components/ContextMenu';
import type { MenuAction } from '../components/ContextMenu';
import { FileIcon, fileKindOf } from '../components/FileIcons';
import { PdfViewer } from '../components/PdfViewer';

interface FilesWorkspaceProps {
  connected: boolean;
}

type DialogState =
  | null
  | { kind: 'new-file'; dir: string }
  | { kind: 'new-folder'; dir: string }
  | { kind: 'rename'; item: RemoteFileItem }
  | { kind: 'move'; item: RemoteFileItem }
  | { kind: 'copy-to'; item: RemoteFileItem }
  | { kind: 'delete'; item: RemoteFileItem };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'py', 'ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml',
  'toml', 'cfg', 'ini', 'sh', 'bash', 'zsh', 'log', 'csv', 'tsv', 'xml', 'html',
  'css', 'sql', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'java', 'rb', 'dart', 'gitignore',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isTextFile(item: RemoteFileItem): boolean {
  if (item.name.startsWith('.') && !item.name.includes('.', 1)) return true;
  const ext = extensionOf(item.name);
  // 無副檔名的檔案（README、Makefile、syslog…）在大小合理時當文字處理。
  if (ext === '' && item.sizeBytes <= MAX_EDITOR_BYTES) return true;
  return TEXT_EXTENSIONS.has(ext);
}

function isMarkdown(item: RemoteFileItem): boolean {
  const ext = extensionOf(item.name);
  return ext === 'md' || ext === 'markdown';
}

function isPdf(item: RemoteFileItem): boolean {
  return extensionOf(item.name) === 'pdf';
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

const MAX_EDITOR_BYTES = 262144;

/** 單列樹狀項目：右鍵與長按都會開動作選單。 */
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
  style: React.CSSProperties;
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

export function FilesWorkspace({ connected }: FilesWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, RemoteFileItem[]>>({});
  const [truncatedDirs, setTruncatedDirs] = useState<Set<string>>(new Set());
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const [menu, setMenu] = useState<{ item: RemoteFileItem; x: number; y: number } | null>(
    null,
  );
  /** openRoot 定義在 confirmDiscard 之前，用 ref 打通順序。 */
  const confirmDiscardRef = useRef<() => boolean>(() => true);
  /** 遠端剪貼簿：Copy/Move 兩段式操作的暫存（Flutter 版同款行為）。 */
  const [clipboard, setClipboard] = useState<{
    item: RemoteFileItem;
    mode: 'copy' | 'move';
  } | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<RemoteFileItem | null>(null);
  const [draft, setDraft] = useState<{ path: string; text: string; saved: string } | null>(
    null,
  );
  const [pdfData, setPdfData] = useState<{ path: string; dataBase64: string } | null>(null);
  const [mdPreview, setMdPreview] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwd, setPwd] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogInput, setDialogInput] = useState('');

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  };

  const report = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const loadDir = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        const listing = await bridge.fsList({ path });
        setChildren((current) => ({ ...current, [listing.path]: listing.items }));
        setTruncatedDirs((current) => {
          const next = new Set(current);
          if (listing.truncated) next.add(listing.path);
          else next.delete(listing.path);
          return next;
        });
        setError(null);
        return listing.path;
      } catch (err: unknown) {
        report(err);
        return null;
      }
    },
    [bridge],
  );

  /** 切換樹的根目錄（Home、/、或任意路徑）。 */
  const openRoot = useCallback(
    async (path: string) => {
      if (!confirmDiscardRef.current()) return;
      const resolved = await loadDir(path);
      if (resolved === null) return;
      setRootPath(resolved);
      setExpanded(new Set([resolved]));
      setSelected(null);
      setDraft(null);
      setPdfData(null);
    },
    [loadDir],
  );

  useEffect(() => {
    if (!connected) {
      setRootPath(null);
      setChildren({});
      setExpanded(new Set());
      setSelected(null);
      setDraft(null);
      setPwd(null);
      return;
    }
    void loadDir('~').then((resolved) => {
      if (resolved !== null) {
        setRootPath(resolved);
        setHomePath(resolved);
        setPwd(resolved);
        setExpanded(new Set([resolved]));
      }
    });
  }, [connected, loadDir]);

  const toggleDir = (item: RemoteFileItem) => {
    setSelected(item);
    setDraft(null);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(item.path)) {
        next.delete(item.path);
      } else {
        next.add(item.path);
        if (children[item.path] === undefined) void loadDir(item.path);
      }
      return next;
    });
  };

  /** symlink：指向目錄就跳過去，指向檔案就開目標。 */
  const followSymlink = (item: RemoteFileItem) => {
    const target = item.linkTarget;
    if (target === undefined || item.targetType === 'N') {
      setError(`連結目標不存在：${target ?? '(未知)'}`);
      return;
    }
    const absolute = target.startsWith('/')
      ? target
      : `${parentOf(item.path)}/${target}`;
    if (item.targetType === 'd') {
      void openRoot(absolute);
      showFlash('已跳到連結目標');
      return;
    }
    void bridge
      .fsList({ path: parentOf(absolute) })
      .then((listing) => {
        const found = listing.items.find((entry) => entry.path === absolute);
        if (found) openFile(found);
        else setError(`找不到連結目標：${absolute}`);
      })
      .catch(report);
  };

  /** 有未存檔變更時先確認，避免切換檔案靜默丟失編輯內容。 */
  const confirmDiscard = (): boolean => {
    if (draft === null || draft.text === draft.saved) return true;
    return window.confirm(
      `${draft.path.slice(draft.path.lastIndexOf('/') + 1)} 有未儲存的變更，要放棄嗎？`,
    );
  };

  const openFile = (item: RemoteFileItem) => {
    if (!confirmDiscard()) return;
    if (item.type === 'l') {
      setSelected(item);
      setDraft(null);
      setPdfData(null);
      return;
    }
    setSelected(item);
    setDraft(null);
    setPdfData(null);
    setMdPreview(false);

    if (isPdf(item)) {
      setBusy(true);
      void bridge
        .fsReadBytes({ path: item.path })
        .then(({ dataBase64 }) => setPdfData({ path: item.path, dataBase64 }))
        .catch(report)
        .finally(() => setBusy(false));
      return;
    }

    if (!isTextFile(item) || item.sizeBytes > MAX_EDITOR_BYTES) return;
    void bridge
      .fsRead({ path: item.path, maxBytes: MAX_EDITOR_BYTES, offset: 0 })
      .then(({ content }) => {
        setDraft({ path: item.path, text: content, saved: content });
        if (isMarkdown(item)) setMdPreview(true);
      })
      .catch(report);
  };

  const refreshDirs = async (...paths: (string | null)[]) => {
    for (const path of paths) {
      if (path !== null && (children[path] !== undefined || path === rootPath)) {
        await loadDir(path);
      }
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    setBusy(true);
    bridge
      .fsWrite({ path: draft.path, contentBase64: textToBase64(draft.text) })
      .then(() => {
        setDraft((current) => (current ? { ...current, saved: current.text } : current));
        showFlash('已儲存');
        void refreshDirs(parentOf(draft.path));
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const download = (target?: RemoteFileItem) => {
    const item = target ?? selected;
    if (!item || item.type === 'd') return;
    setBusy(true);
    bridge
      .fsReadBytes({ path: item.path })
      .then(({ dataBase64 }) => {
        const blob = new Blob([new Uint8Array(base64ToBytes(dataBase64))]);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.name;
        anchor.click();
        URL.revokeObjectURL(url);
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
          setSelected(null);
          setDraft(null);
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
          setSelected(null);
          setDraft(null);
        }
        done(dialog.kind === 'move' ? '已移動' : '已複製', parentOf(dialog.item.path), parentOf(path));
      });
    } else {
      action = bridge.fsDelete({ path: dialog.item.path }).then(() => {
        setSelected(null);
        setDraft(null);
        done('已刪除', parentOf(dialog.item.path));
      });
    }
    action.catch(report).finally(() => setBusy(false));
  };

  const currentDir =
    selected === null
      ? (rootPath ?? pwd ?? '~')
      : selected.type === 'd'
        ? selected.path
        : parentOf(selected.path);

  const dirty = draft !== null && draft.text !== draft.saved;
  confirmDiscardRef.current = confirmDiscard;

  // 有未存檔內容時關閉 app／重新整理要先提醒。
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const renderTree = (dirPath: string, depth: number) => {
    const items = children[dirPath];
    if (items === undefined) {
      return (
        <div className="hint tree-loading" style={{ paddingLeft: 14 + depth * 16 }}>
          載入中…
        </div>
      );
    }
    const rows = items.map((item) => {
      const isDir = item.type === 'd';
      const isOpen = expanded.has(item.path);
      const kind = fileKindOf(item, isOpen);
      return (
        <div key={item.path}>
          <TreeRow
            item={item}
            className={`tree-row${selected?.path === item.path ? ' tree-row-active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onOpenMenu={(x, y) => setMenu({ item, x, y })}
            onClick={() => {
              if (isDir) toggleDir(item);
              else openFile(item);
            }}
            onDoubleClick={() => {
              if (item.type === 'l') followSymlink(item);
            }}
            title={
              item.type === 'l'
                ? `${item.path} → ${item.linkTarget ?? '?'}（雙擊跳轉、右鍵／長按更多）`
                : `${item.path}（右鍵／長按更多）`
            }
          >
            <span className={`tree-caret${isDir ? '' : ' tree-caret-empty'}`}>
              {isDir ? (isOpen ? '▾' : '▸') : ''}
            </span>
            <FileIcon kind={kind} />
            <span className="tree-name">{item.name}</span>
            {item.type === 'l' ? <span className="tree-arrow">→</span> : null}
            {item.executable === true && item.type === 'f' ? (
              <span className="tree-badge tree-badge-exec">x</span>
            ) : null}
            {item.path === pwd ? <span className="pwd-badge">pwd</span> : null}
          </TreeRow>
          {isDir && isOpen ? renderTree(item.path, depth + 1) : null}
        </div>
      );
    });

    if (truncatedDirs.has(dirPath)) {
      rows.push(
        <div
          key={`${dirPath}__truncated`}
          className="hint tree-truncated"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          僅顯示前 2000 筆（目錄過大）
        </div>,
      );
    }
    return rows;
  };

  const copyToClipboardText = (text: string, label: string) => {
    void bridge
      .writeClipboard(text)
      .then(() => showFlash(label))
      .catch(report);
  };

  const relativePath = (item: RemoteFileItem): string => {
    const base = rootPath;
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
          setExpanded((current) => new Set(current).add(item.path));
          if (children[item.path] === undefined) void loadDir(item.path);
          setSelected(item);
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
        setSelected(item);
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
        setPwd(item.path);
        showFlash('已設定 pwd');
        return;
      case 'download':
        setSelected(item);
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
          if (selected?.path === item.path) {
            setSelected(null);
            setDraft(null);
          }
        }
        void refreshDirs(parentOf(item.path), parentOf(path), destination);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const breadcrumbs = (() => {
    const path = currentDir;
    if (!path.startsWith('/')) return [];
    const segments = path.split('/').filter((segment) => segment !== '');
    const crumbs = [{ label: '/', path: '/' }];
    let accumulated = '';
    for (const segment of segments) {
      accumulated += `/${segment}`;
      crumbs.push({ label: segment, path: accumulated });
    }
    return crumbs;
  })();

  if (!connected) {
    return (
      <div className="placeholder">
        <p>Connect to browse remote files.</p>
        <p className="hint">連線後從家目錄開始瀏覽。</p>
      </div>
    );
  }

  return (
    <div className="files-workspace">
      <aside className="files-tree">
        <div className="files-roots">
          <button
            className={rootPath !== null && rootPath === homePath ? 'root-active' : ''}
            onClick={() => void openRoot('~')}
            title="家目錄"
          >
            ⌂ Home
          </button>
          <button
            className={rootPath === '/' ? 'root-active' : ''}
            onClick={() => void openRoot('/')}
            title="根目錄"
          >
            / Root
          </button>
          {pwd !== null && pwd !== rootPath ? (
            <button onClick={() => void openRoot(pwd)} title="切換到 pwd">
              ↦ pwd
            </button>
          ) : null}
          <button
            onClick={() => {
              setJumpValue(currentDir);
              setJumpOpen(true);
            }}
            title="跳到指定路徑"
          >
            ⤓ 路徑…
          </button>
        </div>
        <div className="files-toolbar">
          <button onClick={() => setDialog({ kind: 'new-file', dir: currentDir })}>
            ＋檔案
          </button>
          <button onClick={() => setDialog({ kind: 'new-folder', dir: currentDir })}>
            ＋資料夾
          </button>
          <button onClick={() => void refreshDirs(...Object.keys(children))} title="重新整理">
            ↻
          </button>
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
          {rootPath !== null ? (
            <>
              <button
                className={`tree-row tree-root-row${selected === null ? ' tree-row-active' : ''}`}
                onClick={() => void refreshDirs(rootPath)}
                title={rootPath}
              >
                <span className="tree-caret">▾</span>
                <FileIcon kind="folder-open" />
                <span className="tree-name mono">{rootPath}</span>
              </button>
              {renderTree(rootPath, 1)}
            </>
          ) : (
            <div className="hint tree-loading">載入中…</div>
          )}
        </div>
      </aside>
      <div className="files-preview">
        <div className="breadcrumb-bar">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path} className="crumb-wrap">
              {index > 0 ? <span className="crumb-sep">/</span> : null}
              <button className="crumb" onClick={() => void openRoot(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {selected ? (
          <>
            <div className="files-preview-head">
              <span className="mono files-path">{selected.path}</span>
              {flash ? <span className="flash">{flash}</span> : null}
              <div className="files-actions">
                {selected.type === 'd' ? (
                  <button onClick={() => setPwd(selected.path)}>Set pwd</button>
                ) : null}
                {draft ? (
                  <button className={dirty ? 'primary' : ''} disabled={busy} onClick={saveDraft}>
                    儲存{dirty ? ' •' : ''}
                  </button>
                ) : null}
                {draft && isMarkdown(selected) ? (
                  <button onClick={() => setMdPreview((preview) => !preview)}>
                    {mdPreview ? '編輯' : '預覽'}
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
                <p className="hint">pwd: {pwd ?? '—'}</p>
              </div>
            ) : isPdf(selected) ? (
              pdfData && pdfData.path === selected.path ? (
                <PdfViewer dataBase64={pdfData.dataBase64} fileName={selected.name} />
              ) : (
                <div className="placeholder">
                  <p>載入 PDF…</p>
                </div>
              )
            ) : draft && isMarkdown(selected) && mdPreview ? (
              <div className="md-preview markdown markdown-doc">
                <Markdown remarkPlugins={[remarkGfm]}>{draft.text}</Markdown>
              </div>
            ) : draft ? (
              <CodeEditor
                path={draft.path}
                value={draft.text}
                onChange={(text) =>
                  setDraft((current) => (current ? { ...current, text } : current))
                }
                onSave={saveDraft}
              />
            ) : (
              <div className="placeholder">
                <p>{selected.name}</p>
                <p className="hint">
                  {(selected.sizeBytes / 1024).toFixed(1)} KB · {selected.modified} ·
                  {isTextFile(selected)
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
                  void openRoot(jumpValue.trim());
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
                  void openRoot(jumpValue.trim());
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
                      ? (rootPath ?? '~')
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
