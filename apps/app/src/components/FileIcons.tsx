import type { RemoteFileItem } from '@cozypad/contracts';

export type FileKind =
  | 'folder'
  | 'folder-open'
  | 'symlink-dir'
  | 'symlink-file'
  | 'symlink-broken'
  | 'code'
  | 'markdown'
  | 'data'
  | 'config'
  | 'image'
  | 'pdf'
  | 'archive'
  | 'shell'
  | 'binary'
  | 'device'
  | 'socket'
  | 'file';

const EXTENSION_KIND: Record<string, FileKind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', py: 'code', rb: 'code', rs: 'code',
  go: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code', cs: 'code',
  dart: 'code', php: 'code', lua: 'code', html: 'code', css: 'code', scss: 'code',
  md: 'markdown', markdown: 'markdown', txt: 'file', rst: 'markdown',
  json: 'data', csv: 'data', tsv: 'data', jsonl: 'data', ndjson: 'data', parquet: 'data',
  sql: 'data', xml: 'data',
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config', conf: 'config',
  env: 'config',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image',
  bmp: 'image', ico: 'image',
  pdf: 'pdf',
  zip: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  tar: 'archive', '7z': 'archive', rar: 'archive', zst: 'archive',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  so: 'binary', o: 'binary', a: 'binary', dll: 'binary', exe: 'binary', bin: 'binary',
  pt: 'binary', pth: 'binary', ckpt: 'binary', safetensors: 'binary', onnx: 'binary',
};

export function fileKindOf(item: RemoteFileItem, expanded = false): FileKind {
  if (item.type === 'd') return expanded ? 'folder-open' : 'folder';
  if (item.type === 'l') {
    if (item.targetType === 'd') return 'symlink-dir';
    if (item.targetType === 'N' || item.targetType === undefined) return 'symlink-broken';
    return 'symlink-file';
  }
  if (item.type === 'b' || item.type === 'c') return 'device';
  if (item.type === 's' || item.type === 'p') return 'socket';

  const name = item.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const kind = EXTENSION_KIND[ext];
  if (kind !== undefined) return kind;
  if (item.executable === true) return 'shell';
  if (name === 'dockerfile' || name === 'makefile') return 'config';
  return 'file';
}

const KIND_COLOR: Record<FileKind, string> = {
  folder: '#6e8cff',
  'folder-open': '#8b7cff',
  'symlink-dir': '#6e8cff',
  'symlink-file': '#a1a1aa',
  'symlink-broken': '#fb7185',
  code: '#86efac',
  markdown: '#f5f5f5',
  data: '#facc15',
  config: '#8b7cff',
  image: '#f0abfc',
  pdf: '#fb7185',
  archive: '#fbbf24',
  shell: '#86efac',
  binary: '#71717a',
  device: '#facc15',
  socket: '#71717a',
  file: '#a1a1aa',
};

interface FileIconProps {
  kind: FileKind;
  size?: number;
}

/** 依類型繪製的檔案圖示；資料夾／symlink／各類檔案一眼可辨。 */
export function FileIcon({ kind, size = 15 }: FileIconProps) {
  const color = KIND_COLOR[kind];
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `file-icon file-icon-${kind}`,
  };

  if (kind === 'folder' || kind === 'symlink-dir') {
    return (
      <svg {...common}>
        <path d="M1.5 4.2a1 1 0 0 1 1-1h3l1.2 1.5h6.8a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" fill={`${color}22`} />
        {kind === 'symlink-dir' ? <path d="M6 9.5 9.5 6M9.5 6H7M9.5 6v2.5" strokeWidth={1.1} /> : null}
      </svg>
    );
  }

  if (kind === 'folder-open') {
    return (
      <svg {...common}>
        <path d="M1.5 4.2a1 1 0 0 1 1-1h3l1.2 1.5h6.8a1 1 0 0 1 1 1v1.3H1.5Z" fill={`${color}22`} />
        <path d="M1.5 7h13l-1.2 5.3a1 1 0 0 1-1 .8H3.7a1 1 0 0 1-1-.8Z" fill={`${color}18`} />
      </svg>
    );
  }

  const page = (
    <>
      <path d="M3.5 2h5L12.5 6v8h-9Z" fill={`${color}18`} />
      <path d="M8.5 2v4h4" />
    </>
  );

  switch (kind) {
    case 'symlink-file':
    case 'symlink-broken':
      return (
        <svg {...common}>
          {page}
          {kind === 'symlink-broken' ? (
            <path d="M5.5 9.5 9 12.5M9 9.5l-3.5 3" strokeWidth={1.1} />
          ) : (
            <path d="M5.5 11.5 9 8M9 8H6.6M9 8v2.4" strokeWidth={1.1} />
          )}
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          {page}
          <path d="M6 8.5 4.7 10 6 11.5M9.6 8.5 11 10l-1.4 1.5" strokeWidth={1.1} />
        </svg>
      );
    case 'markdown':
      return (
        <svg {...common}>
          {page}
          <path d="M5 11.5v-3l1.4 1.6L7.8 8.5v3M9.8 8.7v2.6M9 10.4l.8 1 .9-1" strokeWidth={1.1} />
        </svg>
      );
    case 'data':
      return (
        <svg {...common}>
          {page}
          <path d="M5 9h6M5 11h6M7.5 8.6v3.8" strokeWidth={1.1} />
        </svg>
      );
    case 'config':
      return (
        <svg {...common}>
          {page}
          <circle cx="8" cy="10.5" r="1.4" strokeWidth={1.1} />
          <path d="M8 8.4v.7M8 11.9v.7M6.1 10.5h.7M9.2 10.5h.7" strokeWidth={1.1} />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.2" fill={`${color}18`} />
          <circle cx="6" cy="6.4" r="1.1" strokeWidth={1.1} />
          <path d="M3.4 11.6 6.8 8.4l2 1.9 1.6-1.3 2.2 2.6" strokeWidth={1.1} />
        </svg>
      );
    case 'pdf':
      return (
        <svg {...common}>
          {page}
          <path d="M5.4 11.8V9h1a.9.9 0 0 1 0 1.8h-1M8.8 11.8V9h.8a1.4 1.4 0 0 1 0 2.8Z" strokeWidth={1.05} />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.2" fill={`${color}18`} />
          <path d="M8 3v3.2M8 7.4v1.2M8 9.8v1.4" strokeWidth={1.2} />
        </svg>
      );
    case 'shell':
      return (
        <svg {...common}>
          <rect x="2" y="3.2" width="12" height="9.6" rx="1.4" fill={`${color}18`} />
          <path d="M4.6 6.8 6.4 8.4l-1.8 1.6M8.2 10.4h3" strokeWidth={1.15} />
        </svg>
      );
    case 'binary':
      return (
        <svg {...common}>
          {page}
          <path d="M5.4 9.2h1.2v2.8H5.4zM9.2 9.2h1.4v2.8H9.2z" strokeWidth={1.05} />
        </svg>
      );
    case 'device':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="10" height="8" rx="1.2" fill={`${color}18`} />
          <path d="M6 12v1.6M10 12v1.6M6 2.4V4M10 2.4V4" strokeWidth={1.1} />
        </svg>
      );
    case 'socket':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.6" fill={`${color}18`} />
          <path d="M6.3 6.6v1.2a1.7 1.7 0 0 0 3.4 0V6.6" strokeWidth={1.1} />
        </svg>
      );
    default:
      return <svg {...common}>{page}</svg>;
  }
}
