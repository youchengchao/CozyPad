import { useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RemoteFileItem } from '@cozypad/contracts';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { CodeEditor } from '../components/CodeEditor';
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
  return TEXT_EXTENSIONS.has(extensionOf(item.name));
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

export function FilesWorkspace({ connected }: FilesWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, RemoteFileItem[]>>({});
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
        setError(null);
        return listing.path;
      } catch (err: unknown) {
        report(err);
        return null;
      }
    },
    [bridge],
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

  const openFile = (item: RemoteFileItem) => {
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

  const download = () => {
    if (!selected || selected.type === 'd') return;
    setBusy(true);
    bridge
      .fsReadBytes({ path: selected.path })
      .then(({ dataBase64 }) => {
        const blob = new Blob([new Uint8Array(base64ToBytes(dataBase64))]);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = selected.name;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const duplicate = () => {
    if (!selected) return;
    setBusy(true);
    bridge
      .fsDuplicate({ path: selected.path })
      .then(() => {
        showFlash('已建立副本');
        void refreshDirs(parentOf(selected.path));
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
      ? (pwd ?? rootPath ?? '~')
      : selected.type === 'd'
        ? selected.path
        : parentOf(selected.path);

  const dirty = draft !== null && draft.text !== draft.saved;

  const renderTree = (dirPath: string, depth: number) => {
    const items = children[dirPath];
    if (items === undefined) {
      return (
        <div className="hint" style={{ paddingLeft: 14 + depth * 16 }}>
          載入中…
        </div>
      );
    }
    return items.map((item) => {
      const isDir = item.type === 'd';
      const isOpen = expanded.has(item.path);
      return (
        <div key={item.path}>
          <button
            className={`tree-row${selected?.path === item.path ? ' tree-row-active' : ''}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            onClick={() => (isDir ? toggleDir(item) : openFile(item))}
            title={item.path}
          >
            <span className="tree-glyph">{isDir ? (isOpen ? '▾' : '▸') : '·'}</span>
            {item.name}
            {item.path === pwd ? <span className="pwd-badge">pwd</span> : null}
          </button>
          {isDir && isOpen ? renderTree(item.path, depth + 1) : null}
        </div>
      );
    });
  };

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
        <div className="files-note hint mono">{rootPath ?? '~'}</div>
        {rootPath !== null ? renderTree(rootPath, 0) : <div className="hint">載入中…</div>}
      </aside>
      <div className="files-preview">
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
                <button
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(selected.path)
                      .then(() => showFlash('路徑已複製'))
                      .catch(() => undefined);
                  }}
                >
                  Copy path
                </button>
                <button disabled={busy} onClick={duplicate}>
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
                  <button disabled={busy} onClick={download}>
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
            {selected.type === 'd' ? (
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
