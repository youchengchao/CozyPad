import { useState } from 'react';

interface FileNode {
  name: string;
  path: string;
  children?: FileNode[];
}

const TREE: FileNode[] = [
  {
    name: 'seg-train',
    path: '~/projects/seg-train',
    children: [
      {
        name: 'configs',
        path: '~/projects/seg-train/configs',
        children: [{ name: 'base.yaml', path: '~/projects/seg-train/configs/base.yaml' }],
      },
      {
        name: 'src',
        path: '~/projects/seg-train/src',
        children: [
          { name: 'train.py', path: '~/projects/seg-train/src/train.py' },
          { name: 'metrics_writer.py', path: '~/projects/seg-train/src/metrics_writer.py' },
        ],
      },
      { name: 'cozypad.study.yaml', path: '~/projects/seg-train/cozypad.study.yaml' },
      { name: 'notes.md', path: '~/projects/seg-train/notes.md' },
    ],
  },
];

const CONTENT: Record<string, string> = {
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
  '~/projects/seg-train/notes.md': '# Notes\n\n- 2026-07-29: dataloader 瓶頸已修，GPU util 36% → 88%',
};

function TreeNodes({
  nodes,
  depth,
  expanded,
  toggle,
  selected,
  select,
}: {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  toggle(path: string): void;
  selected: string | null;
  select(path: string): void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.children !== undefined;
        const isOpen = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              className={`tree-row${selected === node.path ? ' tree-row-active' : ''}`}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => (isDir ? toggle(node.path) : select(node.path))}
            >
              <span className="tree-glyph">{isDir ? (isOpen ? '▾' : '▸') : '·'}</span>
              {node.name}
            </button>
            {isDir && isOpen && node.children ? (
              <TreeNodes
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                selected={selected}
                select={select}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function FilesWorkspace() {
  const [expanded, setExpanded] = useState(
    new Set(['~/projects/seg-train', '~/projects/seg-train/src']),
  );
  const [selected, setSelected] = useState<string | null>(
    '~/projects/seg-train/src/train.py',
  );
  const [copied, setCopied] = useState(false);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const copyPath = () => {
    if (!selected) return;
    void navigator.clipboard
      ?.writeText(selected)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="files-workspace">
      <aside className="files-tree">
        <div className="files-note hint">mock 檔案 — 真實 SFTP 瀏覽在 Phase 6</div>
        <TreeNodes
          nodes={TREE}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selected={selected}
          select={setSelected}
        />
      </aside>
      <div className="files-preview">
        {selected ? (
          <>
            <div className="files-preview-head">
              <span className="mono files-path">{selected}</span>
              <button onClick={copyPath}>{copied ? 'Copied!' : 'Copy path'}</button>
            </div>
            <pre className="files-content">{CONTENT[selected] ?? '(binary or empty)'}</pre>
          </>
        ) : (
          <div className="placeholder">
            <p>選一個檔案預覽。</p>
          </div>
        )}
      </div>
    </div>
  );
}
