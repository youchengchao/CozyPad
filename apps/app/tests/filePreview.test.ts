import { describe, expect, it } from 'vitest';
import type { RemoteFileItem } from '@cozypad/contracts';
import {
  MAX_EDITABLE_TEXT_BYTES,
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
  it('allows a broader set of text-readable files up to two MiB', () => {
    expect(MAX_EDITABLE_TEXT_BYTES).toBe(2 * 1024 * 1024);
    for (const name of [
      'README',
      '.env',
      'notes.mdx',
      'events.ndjson',
      'changes.patch',
      'script.ps1',
      'component.vue',
      'diagram.svg',
    ]) {
      expect(isTextPreviewFile(file(name)), name).toBe(true);
    }
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
