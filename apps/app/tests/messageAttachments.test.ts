import { describe, expect, it } from 'vitest';
import {
  attachmentDataUrl,
  formatAttachmentSize,
  isInlineAttachmentImage,
  isTextPreviewAttachment,
} from '../src/workspaces/agents/MessageAttachments';

describe('message attachment presentation', () => {
  it('builds a safe persistent inline source for pasted screenshots', () => {
    expect(isInlineAttachmentImage('image/png')).toBe(true);
    expect(attachmentDataUrl('image/png', 'iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('keeps non-image and active-content formats as file cards', () => {
    expect(isInlineAttachmentImage('application/pdf')).toBe(false);
    expect(isInlineAttachmentImage('image/svg+xml')).toBe(false);
    expect(() => attachmentDataUrl('image/svg+xml', 'PHN2Zz4=')).toThrow(
      'Unsupported inline attachment media type',
    );
  });

  it('allows safe read-only text previews for common document formats', () => {
    expect(isTextPreviewAttachment('text/markdown')).toBe(true);
    expect(isTextPreviewAttachment('application/json; charset=utf-8')).toBe(true);
    expect(isTextPreviewAttachment('application/pdf')).toBe(false);
  });

  it('formats attachment sizes for compact timeline cards', () => {
    expect(formatAttachmentSize(68)).toBe('68 B');
    expect(formatAttachmentSize(1025)).toBe('2 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
