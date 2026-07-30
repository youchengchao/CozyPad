import type { DirectoryListing, RemoteFileItem } from '@cozypad/contracts';
import { base64ToBytes, bytesToBase64 } from '@cozypad/contracts';
import { buildSamplePdf } from './samplePdf';

const HOME = '/home/cozy';
const MODIFIED = '2026-07-29 12:00';

interface MockNode {
  name: string;
  type: 'd' | 'f' | 'l';
  children?: Map<string, MockNode>;
  content?: Uint8Array;
  linkTarget?: string;
  executable?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function textNode(name: string, content: string): MockNode {
  return { name, type: 'f', content: encoder.encode(content) };
}

function dirNode(name: string, children: MockNode[]): MockNode {
  return { name, type: 'd', children: new Map(children.map((child) => [child.name, child])) };
}

function seed(): MockNode {
  return dirNode('', [
    dirNode('etc', [
      textNode('hostname', 'gpu-box\n'),
      textNode('os-release', 'NAME="Ubuntu"\nVERSION="24.04 LTS"\n'),
      dirNode('ssh', [textNode('sshd_config', 'Port 22\nPermitRootLogin no\n')]),
    ]),
    dirNode('var', [dirNode('log', [textNode('syslog', 'mock syslog line\n')])]),
    dirNode('tmp', []),
    dirNode('usr', [dirNode('bin', [{ name: 'tmux', type: 'f', content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), executable: true }])]),
    dirNode('home', [dirNode('cozy', homeChildren())]),
  ]);
}

function homeChildren(): MockNode[] {
  return [
    dirNode('projects', [
      dirNode('seg-train', [
        dirNode('configs', [
          textNode(
            'base.yaml',
            'dataset:\n  root: data/train\n  split: {train: 0.8, validation: 0.1, test: 0.1}\ntrain:\n  batch_size: 32\n  epochs: 100\n  learning_rate: 0.0003\n',
          ),
        ]),
        dirNode('src', [
          textNode(
            'train.py',
            'import torch\nfrom torch.utils.data import DataLoader\n\nloader = DataLoader(\n    dataset,\n    batch_size=32,\n    num_workers=8,\n    pin_memory=True,\n)\n',
          ),
          textNode(
            'metrics_writer.py',
            'import json, os\n\nclass MetricsWriter:\n    def __init__(self, run_dir):\n        self.path = os.path.join(run_dir, "metrics.jsonl")\n',
          ),
        ]),
        textNode(
          'cozypad.study.yaml',
          'schemaVersion: 1\nstudy:\n  id: normalization-init-ablation\n  objective: {metric: val/accuracy, direction: maximize}\n',
        ),
        textNode(
          'notes.md',
          '# Notes\n\n- 2026-07-29: dataloader 瓶頸已修，GPU util **36% → 88%**\n\n| factor | best |\n| --- | --- |\n| normalization | zscore |\n',
        ),
        { name: 'paper.pdf', type: 'f', content: buildSamplePdf() },
        { name: 'run.sh', type: 'f', content: encoder.encode('#!/bin/sh\npython train.py\n'), executable: true },
        { name: 'latest-run', type: 'l', linkTarget: '/home/cozy/projects/seg-train/src' },
        { name: 'dangling', type: 'l', linkTarget: '/home/cozy/does-not-exist' },
        { name: 'logo.png', type: 'f', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        { name: 'data.csv', type: 'f', content: encoder.encode('step,loss\n1,0.42\n2,0.31\n') },
        { name: 'archive.tar.gz', type: 'f', content: new Uint8Array([0x1f, 0x8b]) },
      ]),
    ]),
    dirNode('datasets', [
      dirNode('imagenet-mini', [textNode('README', 'mock dataset\n')]),
    ]),
    { name: 'data', type: 'l', linkTarget: '/home/cozy/datasets' },
    { name: 'sys-log', type: 'l', linkTarget: '/var/log/syslog' },
    textNode('.bashrc', 'export PATH="$HOME/bin:$PATH"\n'),
  ];
}

/** 記憶體版遠端檔案系統：瀏覽器 mock bridge 與 Electron mock 模式共用。 */
export class MockRemoteFs {
  private root = seed();

  resolvePath(path: string): string {
    const trimmed = path.trim() === '' ? '~' : path.trim();
    if (trimmed === '~') return HOME;
    if (trimmed.startsWith('~/')) return `${HOME}/${trimmed.slice(2)}`;
    return trimmed;
  }

  private segments(absPath: string): string[] {
    return absPath.split('/').filter((segment) => segment !== '');
  }

  private findNode(absPath: string): MockNode | null {
    let node: MockNode = this.root;
    for (const segment of this.segments(absPath)) {
      const next = node.children?.get(segment);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  private findParent(absPath: string): { parent: MockNode; name: string } | null {
    const parts = this.segments(absPath);
    const name = parts.pop();
    if (name === undefined) return null;
    const parent = this.findNode(`/${parts.join('/')}`);
    if (!parent || parent.type !== 'd') return null;
    return { parent, name };
  }

  list(path: string): Promise<DirectoryListing> {
    const abs = this.resolvePath(path);
    const node = this.findNode(abs);
    if (!node || node.type !== 'd') {
      return Promise.reject(new Error(`Not a directory: ${abs}`));
    }
    const items: RemoteFileItem[] = [...(node.children?.values() ?? [])].map((child) => {
      const target = child.linkTarget === undefined ? null : this.findNode(child.linkTarget);
      return {
        name: child.name,
        path: abs === '/' ? `/${child.name}` : `${abs}/${child.name}`,
        type: child.type,
        sizeBytes:
          child.type === 'f' ? (child.content?.length ?? 0) : (child.children?.size ?? 0),
        modified: MODIFIED,
        ...(child.linkTarget === undefined ? {} : { linkTarget: child.linkTarget }),
        ...(child.type === 'l' ? { targetType: target?.type ?? 'N' } : {}),
        ...(child.executable === true ? { executable: true } : {}),
      };
    });
    items.sort((a, b) => {
      const aDir = a.type === 'd' || (a.type === 'l' && a.targetType === 'd');
      const bDir = b.type === 'd' || (b.type === 'l' && b.targetType === 'd');
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return Promise.resolve({ path: abs, items, truncated: false });
  }

  readText(path: string, maxBytes = 262144, offset = 0): Promise<string> {
    const node = this.findNode(this.resolvePath(path));
    if (!node || node.type !== 'f') {
      return Promise.reject(new Error(`Not a regular file: ${path}`));
    }
    const bytes = node.content ?? new Uint8Array();
    const slice = bytes.slice(offset, offset + maxBytes);
    let text = decoder.decode(slice);
    if (bytes.length > offset + maxBytes) {
      text += `\n\n[Preview truncated: showing bytes ${offset + 1} to ${offset + maxBytes} of ${bytes.length} bytes]`;
    }
    return Promise.resolve(text);
  }

  readBytes(path: string): Promise<string> {
    const node = this.findNode(this.resolvePath(path));
    if (!node || node.type !== 'f') {
      return Promise.reject(new Error(`Not a regular file: ${path}`));
    }
    return Promise.resolve(bytesToBase64(node.content ?? new Uint8Array()));
  }

  write(path: string, contentBase64: string): Promise<void> {
    const abs = this.resolvePath(path);
    const existing = this.findNode(abs);
    if (existing && existing.type !== 'f') {
      return Promise.reject(new Error(`Target is not a regular file path: ${abs}`));
    }
    const located = this.findParent(abs);
    if (!located) {
      return Promise.reject(new Error(`Parent directory does not exist: ${abs}`));
    }
    located.parent.children!.set(located.name, {
      name: located.name,
      type: 'f',
      content: base64ToBytes(contentBase64),
    });
    return Promise.resolve();
  }

  create(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    if (name.includes('/')) return Promise.reject(new Error('Name cannot contain /.'));
    const dirNodeFound = this.findNode(this.resolvePath(directory));
    if (!dirNodeFound || dirNodeFound.type !== 'd') {
      return Promise.reject(new Error(`Not a directory: ${directory}`));
    }
    if (dirNodeFound.children!.has(name)) {
      return Promise.reject(new Error(`Already exists: ${name}`));
    }
    dirNodeFound.children!.set(
      name,
      kind === 'file'
        ? { name, type: 'f', content: new Uint8Array() }
        : { name, type: 'd', children: new Map() },
    );
    return Promise.resolve();
  }

  rename(path: string, newName: string): Promise<void> {
    if (newName.trim() === '' || newName.includes('/')) {
      return Promise.reject(new Error('New name cannot be empty or contain /.'));
    }
    const located = this.findParent(this.resolvePath(path));
    const node = located?.parent.children?.get(located.name);
    if (!located || !node) return Promise.reject(new Error(`Path does not exist: ${path}`));
    if (located.parent.children!.has(newName.trim())) {
      return Promise.reject(new Error(`Destination already exists: ${newName}`));
    }
    located.parent.children!.delete(located.name);
    node.name = newName.trim();
    located.parent.children!.set(node.name, node);
    return Promise.resolve();
  }

  private cloneNode(node: MockNode, name: string): MockNode {
    return {
      name,
      type: node.type,
      ...(node.content === undefined ? {} : { content: new Uint8Array(node.content) }),
      ...(node.children === undefined
        ? {}
        : {
            children: new Map(
              [...node.children.values()].map((child) => [
                child.name,
                this.cloneNode(child, child.name),
              ]),
            ),
          }),
    };
  }

  duplicate(path: string): Promise<string> {
    const abs = this.resolvePath(path);
    const located = this.findParent(abs);
    const node = located?.parent.children?.get(located.name);
    if (!located || !node) return Promise.reject(new Error(`Path does not exist: ${path}`));
    let candidate = `${located.name}_copy`;
    let counter = 2;
    while (located.parent.children!.has(candidate)) {
      candidate = `${located.name}_copy${counter++}`;
    }
    located.parent.children!.set(candidate, this.cloneNode(node, candidate));
    return Promise.resolve(`${abs.slice(0, abs.lastIndexOf('/'))}/${candidate}`);
  }

  private transfer(sourcePath: string, destinationDirectory: string, move: boolean): Promise<string> {
    const absSource = this.resolvePath(sourcePath);
    const absDest = this.resolvePath(destinationDirectory);
    const located = this.findParent(absSource);
    const node = located?.parent.children?.get(located.name);
    if (!located || !node) {
      return Promise.reject(new Error(`Source does not exist: ${sourcePath}`));
    }
    const destNode = this.findNode(absDest);
    if (!destNode || destNode.type !== 'd') {
      return Promise.reject(new Error(`Destination is not a directory: ${destinationDirectory}`));
    }
    let candidate = located.name;
    if (destNode.children!.has(candidate)) {
      if (move) {
        return Promise.reject(new Error(`Destination already exists: ${absDest}/${candidate}`));
      }
      const dot = candidate.lastIndexOf('.');
      const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
      const ext = dot > 0 ? candidate.slice(dot) : '';
      let counter = 1;
      while (destNode.children!.has(`${stem}_copy${counter}${ext}`)) counter += 1;
      candidate = `${stem}_copy${counter}${ext}`;
    }
    if (move) located.parent.children!.delete(located.name);
    destNode.children!.set(candidate, this.cloneNode(node, candidate));
    return Promise.resolve(`${absDest}/${candidate}`);
  }

  copyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.transfer(sourcePath, destinationDirectory, false);
  }

  moveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    return this.transfer(sourcePath, destinationDirectory, true);
  }

  remove(path: string): Promise<void> {
    const abs = this.resolvePath(path);
    if (abs === '/' || abs === HOME) {
      return Promise.reject(new Error('Refusing to delete root or home directory.'));
    }
    const located = this.findParent(abs);
    if (!located || !located.parent.children?.has(located.name)) {
      return Promise.reject(new Error(`Path does not exist: ${path}`));
    }
    located.parent.children.delete(located.name);
    return Promise.resolve();
  }
}
