import { base64ToBytes } from '@cozypad/contracts';
import type { SaveDownloadRequest } from '@cozypad/contracts';

const MIME_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/png',
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'application/javascript',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  log: 'text/plain',
  markdown: 'text/markdown',
  md: 'text/markdown',
  mdx: 'text/markdown',
  mjs: 'application/javascript',
  ndjson: 'application/x-ndjson',
  pdf: 'application/pdf',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

export function mimeTypeForFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export function saveWithBrowserDownload(request: SaveDownloadRequest): void {
  const blob = new Blob(
    [new Uint8Array(base64ToBytes(request.dataBase64))],
    { type: request.mimeType },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = request.fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 讓瀏覽器先消費 blob URL；同步 revoke 可能讓下載尚未開始就失效。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
