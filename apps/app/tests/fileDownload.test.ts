import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mimeTypeForFileName,
  saveWithBrowserDownload,
} from '../src/fileDownload';

describe('mimeTypeForFileName', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses known MIME types without changing the filename extension', () => {
    expect(mimeTypeForFileName('report.PDF')).toBe('application/pdf');
    expect(mimeTypeForFileName('config.xml')).toBe('application/xml');
    expect(mimeTypeForFileName('notes.md')).toBe('text/markdown');
  });

  it('uses binary MIME for unknown or extensionless files', () => {
    expect(mimeTypeForFileName('model.safetensors')).toBe(
      'application/octet-stream',
    );
    expect(mimeTypeForFileName('Makefile')).toBe('application/octet-stream');
  });

  it('preserves the filename and revokes the browser URL after the click', () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = {
      click,
      download: '',
      href: '',
      remove,
      style: { display: '' },
    };
    const createObjectURL = vi.fn(() => 'blob:download-test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      body: { append },
      createElement: vi.fn(() => anchor),
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    saveWithBrowserDownload({
      fileName: 'model.safetensors',
      dataBase64: 'AAECAw==',
      mimeType: 'application/octet-stream',
    });

    expect(anchor.download).toBe('model.safetensors');
    expect(anchor.href).toBe('blob:download-test');
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download-test');
  });
});
