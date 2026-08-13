import {
  MAX_INLINE_FILE_OPEN_BYTES,
  type RemoteFileItem,
} from '@cozypad/contracts';

export const MAX_EDITABLE_TEXT_BYTES = MAX_INLINE_FILE_OPEN_BYTES;

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

/**
 * Extension is intentionally not a text allow-list. Like VS Code, CozyPad
 * first gives a reasonably sized file a chance, then rejects binary content.
 */
export function isTextPreviewFile(item: RemoteFileItem): boolean {
  return (
    item.sizeBytes <= MAX_EDITABLE_TEXT_BYTES &&
    imagePreviewMimeType(item) === null &&
    extensionOf(item.name) !== 'pdf'
  );
}

/**
 * Decode only byte sequences that can be edited and saved losslessly as UTF-8.
 * NUL bytes follow VS Code's initial binary-file screening. Other encodings
 * remain unsupported until the editor can preserve their original encoding.
 */
export function decodeTextPreview(bytes: Uint8Array): string | null {
  const sampleLength = Math.min(bytes.length, 512);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) return null;
  }

  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  } catch {
    return null;
  }
}

export function isMarkdownPreviewFile(item: RemoteFileItem): boolean {
  const extension = extensionOf(item.name);
  return extension === 'md' || extension === 'markdown' || extension === 'mdx';
}

export function imagePreviewMimeType(item: RemoteFileItem): string | null {
  return IMAGE_MIME_TYPES[extensionOf(item.name)] ?? null;
}
