import { describe, expect, it } from 'vitest';
import type { RemoteFileItem } from '@cozypad/contracts';
import {
  MAX_EDITABLE_TEXT_BYTES,
  decodeTextPreview,
  imagePreviewMimeType,
  isMarkdownPreviewFile,
  isTextPreviewFile,
} from '../src/workspaces/filePreview';

function file(name: string, sizeBytes = 100): RemoteFileItem {
  return {
    name,
    path: `/tmp/${name}`,
    type: 'f',
    sizeBytes,
    modified: '2026-08-07 00:00',
  };
}

describe('file preview policy', () => {
  it('allows any non-preview-specific extension up to ten MiB', () => {
    expect(MAX_EDITABLE_TEXT_BYTES).toBe(10 * 1024 * 1024);
    for (const name of [
      'README',
      '.env',
      'notes.mdx',
      'events.ndjson',
      'changes.patch',
      'script.ps1',
      'component.vue',
      'diagram.svg',
      '.claude.json.backup',
      'service.project-config',
    ]) {
      expect(isTextPreviewFile(file(name)), name).toBe(true);
    }
  });

  it('defers unknown and traditionally binary extensions to content detection', () => {
    expect(isTextPreviewFile(file('archive.zip'))).toBe(true);
    expect(isTextPreviewFile(file('program.exe'))).toBe(true);
    expect(isTextPreviewFile(file('photo.png'))).toBe(false);
    expect(isTextPreviewFile(file('document.pdf'))).toBe(false);
    expect(isTextPreviewFile(file('huge.custom', MAX_EDITABLE_TEXT_BYTES + 1))).toBe(false);
  });

  it('accepts valid UTF-8 regardless of extension and rejects binary bytes', () => {
    expect(decodeTextPreview(new TextEncoder().encode('{"ok":true}'))).toBe(
      '{"ok":true}',
    );
    expect(
      decodeTextPreview(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
    ).toBe('hi');
    expect(decodeTextPreview(new Uint8Array([0x50, 0x4b, 0x00, 0x01]))).toBeNull();
    expect(decodeTextPreview(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it('recognises Markdown documents rendered by the shared renderer', () => {
    expect(isMarkdownPreviewFile(file('notes.md'))).toBe(true);
    expect(isMarkdownPreviewFile(file('guide.markdown'))).toBe(true);
    expect(isMarkdownPreviewFile(file('component.mdx'))).toBe(true);
    expect(isMarkdownPreviewFile(file('notes.txt'))).toBe(false);
  });

  it('maps common raster image extensions to browser preview MIME types', () => {
    expect(imagePreviewMimeType(file('photo.png'))).toBe('image/png');
    expect(imagePreviewMimeType(file('photo.JPG'))).toBe('image/jpeg');
    expect(imagePreviewMimeType(file('photo.jfif'))).toBe('image/jpeg');
    expect(imagePreviewMimeType(file('photo.webp'))).toBe('image/webp');
    expect(imagePreviewMimeType(file('photo.avif'))).toBe('image/avif');
    expect(imagePreviewMimeType(file('diagram.svg'))).toBeNull();
  });
});
