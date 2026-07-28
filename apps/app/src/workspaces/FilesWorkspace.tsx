import { useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface FsNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children?: FsNode[];
}

const INITIAL_TREE: FsNode[] = [
  {
    name: 'seg-train',
    path: '~/projects/seg-train',
    kind: 'dir',
    children: [
      {
        name: 'configs',
        path: '~/projects/seg-train/configs',
        kind: 'dir',
        children: [
          {
            name: 'base.yaml',
            path: '~/projects/seg-train/configs/base.yaml',
            kind: 'file',
          },
        ],
      },
      {
        name: 'src',
        path: '~/projects/seg-train/src',
        kind: 'dir',
        children: [
          { name: 'train.py', path: '~/projects/seg-train/src/train.py', kind: 'file' },
          {
            name: 'metrics_writer.py',
            path: '~/projects/seg-train/src/metrics_writer.py',
            kind: 'file',
          },
        ],
      },
      {
        name: 'cozypad.study.yaml',
        path: '~/projects/seg-train/cozypad.study.yaml',
        kind: 'file',
      },
      { name: 'notes.md', path: '~/projects/seg-train/notes.md', kind: 'file' },
      { name: 'paper.pdf', path: '~/projects/seg-train/paper.pdf', kind: 'file' },
    ],
  },
];

const INITIAL_CONTENT: Record<string, string> = {
  '~/projects/seg-train/configs/base.yaml': [
    'dataset:',
    '  root: data/train',
    '  split: {train: 0.8, validation: 0.1, test: 0.1}',
    'train:',
    '  batch_size: 32',
    '  epochs: 100',
    '  learning_rate: 0.0003',
  ].join('\n'),
  '~/projects/seg-train/src/train.py': [
    'import torch',
    'from torch.utils.data import DataLoader',
    '',
    'loader = DataLoader(',
    '    dataset,',
    '    batch_size=32,',
    '    num_workers=8,',
    '    pin_memory=True,',
    ')',
  ].join('\n'),
  '~/projects/seg-train/src/metrics_writer.py': [
    'import json, os',
    '',
    'class MetricsWriter:',
    '    def __init__(self, run_dir):',
    '        self.path = os.path.join(run_dir, "metrics.jsonl")',
  ].join('\n'),
  '~/projects/seg-train/cozypad.study.yaml': [
    'schemaVersion: 1',
    'study:',
    '  id: normalization-init-ablation',
    '  objective: {metric: val/accuracy, direction: maximize}',
  ].join('\n'),
  '~/projects/seg-train/notes.md': [
    '# Notes',
    '',
    '- 2026-07-29: dataloader 瓶頸已修，GPU util **36% → 88%**',
    '- TODO: normalization ablation 的 `minmax` run 要重跑',
    '',
    '| factor | best |',
    '| --- | --- |',
    '| normalization | zscore |',
    '| batch size | 32 |',
  ].join('\n'),
};

type DialogState =
  | null
  | { kind: 'new-file' | 'new-folder'; dir: string }
  | { kind: 'move'; path: string }
  | { kind: 'delete'; path: string };

function cloneTree(nodes: FsNode[]): FsNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneTree(node.children) : undefined,
  }));
}

function findNode(nodes: FsNode[], path: string): FsNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function removeNode(nodes: FsNode[], path: string): FsNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) => ({
      ...node,
      children: node.children ? removeNode(node.children, path) : undefined,
    }));
}

function insertNode(nodes: FsNode[], dirPath: string, child: FsNode): FsNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath && node.kind === 'dir') {
      const children = [...(node.children ?? []), child].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { ...node, children };
    }
    return {
      ...node,
      children: node.children ? insertNode(node.children, dirPath, child) : undefined,
    };
  });
}

function rewritePaths(node: FsNode, newParentPath: string, newName?: string): FsNode {
  const name = newName ?? node.name;
  const path = `${newParentPath}/${name}`;
  return {
    name,
    path,
    kind: node.kind,
    children: node.children?.map((child) => rewritePaths(child, path)),
  };
}

function collectPaths(node: FsNode): string[] {
  return [node.path, ...(node.children ?? []).flatMap(collectPaths)];
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function isMarkdown(path: string): boolean {
  return path.endsWith('.md');
}

function isPdf(path: string): boolean {
  return path.endsWith('.pdf');
}

export function FilesWorkspace() {
  const [tree, setTree] = useState<FsNode[]>(INITIAL_TREE);
  const [contents, setContents] = useState<Record<string, string>>(INITIAL_CONTENT);
  const [expanded, setExpanded] = useState(
    new Set(['~/projects/seg-train', '~/projects/seg-train/src']),
  );
  const [selected, setSelected] = useState<string | null>(
    '~/projects/seg-train/src/train.py',
  );
  const [pwd, setPwd] = useState('~/projects/seg-train');
  const [draft, setDraft] = useState<{ path: string; text: string } | null>(null);
  const [mdPreview, setMdPreview] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogInput, setDialogInput] = useState('');
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const selectedNode = selected !== null ? findNode(tree, selected) : null;
  const currentDir =
    selectedNode === null
      ? '~/projects/seg-train'
      : selectedNode.kind === 'dir'
        ? selectedNode.path
        : parentPath(selectedNode.path);

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1500);
  };

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const select = (node: FsNode) => {
    setSelected(node.path);
    if (node.kind === 'file' && !isPdf(node.path)) {
      setDraft({ path: node.path, text: contents[node.path] ?? '' });
    } else {
      setDraft(null);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    setContents((current) => ({ ...current, [draft.path]: draft.text }));
    showFlash('已儲存');
  };

  const dirty = draft !== null && draft.text !== (contents[draft.path] ?? '');

  const copyPath = () => {
    if (!selected) return;
    void navigator.clipboard
      ?.writeText(selected)
      .then(() => showFlash('路徑已複製'))
      .catch(() => undefined);
  };

  const download = () => {
    if (!selectedNode || selectedNode.kind !== 'file') return;
    const content = contents[selectedNode.path] ?? '';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedNode.name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const duplicate = () => {
    if (!selectedNode) return;
    const parent = parentPath(selectedNode.path);
    const copyName = selectedNode.name.replace(/(\.[^.]*)?$/, ' copy$1');
    const copied = rewritePaths(selectedNode, parent, copyName);
    setTree((current) => insertNode(cloneTree(current), parent, copied));
    if (selectedNode.kind === 'file') {
      setContents((current) => ({
        ...current,
        [copied.path]: current[selectedNode.path] ?? '',
      }));
    }
    showFlash('已建立副本');
  };

  const confirmDialog = () => {
    if (dialog === null) return;
    if (dialog.kind === 'new-file' || dialog.kind === 'new-folder') {
      const name = dialogInput.trim();
      if (name === '') return;
      const node: FsNode = {
        name,
        path: `${dialog.dir}/${name}`,
        kind: dialog.kind === 'new-file' ? 'file' : 'dir',
        ...(dialog.kind === 'new-folder' ? { children: [] } : {}),
      };
      setTree((current) => insertNode(cloneTree(current), dialog.dir, node));
      if (dialog.kind === 'new-file') {
        setContents((current) => ({ ...current, [node.path]: '' }));
      }
      setExpanded((current) => new Set(current).add(dialog.dir));
      showFlash(dialog.kind === 'new-file' ? '已建立檔案' : '已建立資料夾');
    }
    if (dialog.kind === 'move') {
      const target = dialogInput.trim();
      const targetNode = findNode(tree, target);
      if (!targetNode || targetNode.kind !== 'dir') {
        showFlash('目標資料夾不存在');
        return;
      }
      const moving = findNode(tree, dialog.path);
      if (!moving) return;
      const moved = rewritePaths(moving, target);
      const oldPaths = collectPaths(moving);
      const newPaths = collectPaths(moved);
      setTree((current) => insertNode(removeNode(cloneTree(current), dialog.path), target, moved));
      setContents((current) => {
        const next = { ...current };
        oldPaths.forEach((oldPath, index) => {
          if (oldPath in next) {
            next[newPaths[index]!] = next[oldPath]!;
            delete next[oldPath];
          }
        });
        return next;
      });
      setSelected(moved.path);
      showFlash('已移動');
    }
    if (dialog.kind === 'delete') {
      const node = findNode(tree, dialog.path);
      if (node) {
        const paths = collectPaths(node);
        setTree((current) => removeNode(cloneTree(current), dialog.path));
        setContents((current) => {
          const next = { ...current };
          paths.forEach((path) => delete next[path]);
          return next;
        });
        if (selected !== null && paths.includes(selected)) {
          setSelected(null);
          setDraft(null);
        }
        showFlash('已刪除');
      }
    }
    setDialog(null);
    setDialogInput('');
  };

  const renderTree = (nodes: FsNode[], depth: number) => (
    <>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              className={`tree-row${selected === node.path ? ' tree-row-active' : ''}`}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => {
                if (node.kind === 'dir') toggle(node.path);
                select(node);
              }}
            >
              <span className="tree-glyph">
                {node.kind === 'dir' ? (isOpen ? '▾' : '▸') : '·'}
              </span>
              {node.name}
              {node.path === pwd ? <span className="pwd-badge">pwd</span> : null}
            </button>
            {node.kind === 'dir' && isOpen && node.children
              ? renderTree(node.children, depth + 1)
              : null}
          </div>
        );
      })}
    </>
  );

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
        </div>
        <div className="files-note hint">mock 檔案 — 真實 SFTP 在 Phase 6 接上</div>
        {renderTree(tree, 0)}
      </aside>
      <div className="files-preview">
        {selectedNode ? (
          <>
            <div className="files-preview-head">
              <span className="mono files-path">{selectedNode.path}</span>
              {flash ? <span className="flash">{flash}</span> : null}
              <div className="files-actions">
                {selectedNode.kind === 'dir' ? (
                  <button onClick={() => setPwd(selectedNode.path)}>Set pwd</button>
                ) : null}
                {draft ? (
                  <button className={dirty ? 'primary' : ''} onClick={saveDraft}>
                    儲存{dirty ? ' •' : ''}
                  </button>
                ) : null}
                {draft && isMarkdown(selectedNode.path) ? (
                  <button onClick={() => setMdPreview((preview) => !preview)}>
                    {mdPreview ? '編輯' : '預覽'}
                  </button>
                ) : null}
                <button onClick={copyPath}>Copy path</button>
                <button onClick={duplicate}>Copy</button>
                <button onClick={() => setDialog({ kind: 'move', path: selectedNode.path })}>
                  Move
                </button>
                {selectedNode.kind === 'file' && !isPdf(selectedNode.path) ? (
                  <button onClick={download}>Download</button>
                ) : null}
                <button
                  className="danger"
                  onClick={() => setDialog({ kind: 'delete', path: selectedNode.path })}
                >
                  Delete
                </button>
              </div>
            </div>
            {selectedNode.kind === 'dir' ? (
              <div className="placeholder">
                <p>{selectedNode.children?.length ?? 0} 個項目</p>
                <p className="hint">pwd: {pwd}</p>
              </div>
            ) : isPdf(selectedNode.path) ? (
              <div className="pdf-frame">
                <div className="pdf-box">
                  <p>📄 {selectedNode.name}</p>
                  <p className="hint">
                    PDF 預覽將以 pdf.js 串接真實 SFTP 內容（Phase 6，SPEC FR-04）。
                  </p>
                </div>
              </div>
            ) : draft && isMarkdown(selectedNode.path) && mdPreview ? (
              <div className="md-preview markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{draft.text}</Markdown>
              </div>
            ) : draft ? (
              <textarea
                ref={editorRef}
                className="files-editor mono"
                value={draft.text}
                spellCheck={false}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, text: event.target.value } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    const el = event.currentTarget;
                    const { selectionStart, selectionEnd, value } = el;
                    const next =
                      value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
                    setDraft((current) =>
                      current ? { ...current, text: next } : current,
                    );
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = selectionStart + 2;
                    });
                  }
                  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                    event.preventDefault();
                    saveDraft();
                  }
                }}
              />
            ) : null}
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
                  確定刪除 <span className="mono">{dialog.path}</span>？
                </p>
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="danger" onClick={confirmDialog}>
                    刪除
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {dialog.kind === 'move'
                    ? `把 ${dialog.path} 移動到（輸入目標資料夾路徑）`
                    : dialog.kind === 'new-file'
                      ? `在 ${dialog.dir} 新增檔案`
                      : `在 ${dialog.dir} 新增資料夾`}
                </p>
                <input
                  autoFocus
                  value={dialogInput}
                  placeholder={dialog.kind === 'move' ? '~/projects/seg-train/src' : '名稱'}
                  onChange={(event) => setDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') confirmDialog();
                  }}
                />
                <div className="form-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="primary" onClick={confirmDialog}>
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
