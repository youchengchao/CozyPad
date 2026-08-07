import type { RemoteFileItem } from '@cozypad/contracts';

export const MAX_EDITABLE_TEXT_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'adoc',
  'asciidoc',
  'astro',
  'bash',
  'bat',
  'bib',
  'c',
  'cc',
  'cfg',
  'cjs',
  'cmd',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'cxx',
  'dart',
  'diff',
  'dockerignore',
  'editorconfig',
  'env',
  'erl',
  'err',
  'ex',
  'exs',
  'fish',
  'fs',
  'fsx',
  'gitconfig',
  'gitignore',
  'gql',
  'go',
  'graphql',
  'h',
  'hpp',
  'hrl',
  'htm',
  'html',
  'hxx',
  'ini',
  'java',
  'js',
  'json',
  'json5',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'lock',
  'log',
  'lua',
  'markdown',
  'md',
  'mdx',
  'mjs',
  'ndjson',
  'npmrc',
  'org',
  'out',
  'patch',
  'php',
  'pl',
  'pm',
  'properties',
  'ps1',
  'py',
  'pyi',
  'r',
  'rb',
  'rs',
  'rst',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'svg',
  'swift',
  'tex',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vb',
  'vue',
  'xml',
  'yaml',
  'yml',
  'yarnrc',
  'zsh',
]);

const TEXT_FILE_NAMES = new Set([
  'authors',
  'changelog',
  'contributing',
  'copying',
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'procfile',
  'readme',
]);

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/png',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isTextPreviewFile(item: RemoteFileItem): boolean {
  const lowerName = item.name.toLowerCase();
  if (lowerName.startsWith('.') && !lowerName.includes('.', 1)) return true;
  if (TEXT_FILE_NAMES.has(lowerName)) return true;
  const extension = extensionOf(lowerName);
  if (extension === '' && item.sizeBytes <= MAX_EDITABLE_TEXT_BYTES) return true;
  return TEXT_EXTENSIONS.has(extension);
}

export function isMarkdownPreviewFile(item: RemoteFileItem): boolean {
  const extension = extensionOf(item.name);
  return extension === 'md' || extension === 'markdown' || extension === 'mdx';
}

export function imagePreviewMimeType(item: RemoteFileItem): string | null {
  return IMAGE_MIME_TYPES[extensionOf(item.name)] ?? null;
}
