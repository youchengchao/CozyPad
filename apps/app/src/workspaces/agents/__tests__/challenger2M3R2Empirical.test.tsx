import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_AGENT_ATTACHMENT_BYTES, MAX_AGENT_ATTACHMENTS } from '@cozypad/contracts';
import { ChatComposer, ATTACHMENT_STATE_LABEL } from '../ChatComposer';
import { MessageAttachments, isInlineAttachmentImage, isTextPreviewAttachment } from '../MessageAttachments';
import {
  bufferAttachmentFiles,
  formatAttachmentSize,
  formatAttachmentValidationNotice,
  getAttachmentFileTypeBadge,
} from '../attachmentBuffer';
import type { ComposerAttachment } from '../attachmentBuffer';
import { getBridge } from '../../../platform/bridge';

describe('Challenger 2 M3 Round 2 Empirical Test Suite', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    (globalThis as any).window = {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
        writeClipboard: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  const dummyComposerProps = {
    agentLabel: 'CozyAgent',
    value: '',
    history: [],
    commands: [],
    attachments: [],
    onChange: vi.fn(),
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(),
  };

  describe('1. Attachment Buffer Limits (20MB & 10 Files)', () => {
    it('accepts file exactly 20MB and rejects file 20MB + 1 byte', () => {
      const exact20MB = new File(['a'], 'exact20.bin', { type: 'application/octet-stream' });
      Object.defineProperty(exact20MB, 'size', { value: MAX_AGENT_ATTACHMENT_BYTES });

      const over20MB = new File(['b'], 'over20.bin', { type: 'application/octet-stream' });
      Object.defineProperty(over20MB, 'size', { value: MAX_AGENT_ATTACHMENT_BYTES + 1 });

      const result = bufferAttachmentFiles([exact20MB, over20MB], 0, {
        createId: () => 'id-1',
        createPreviewUrl: () => 'blob:test',
      });

      expect(result.attachments.length).toBe(1);
      expect(result.attachments[0]?.name).toBe('exact20.bin');
      expect(result.oversizedCount).toBe(1);
      expect(result.limitCount).toBe(0);
    });

    it('enforces strict 10 file count limit when uploading in single or split batches', () => {
      const files: File[] = Array.from(
        { length: 15 },
        (_, i) => new File([`data${i}`], `doc${i + 1}.txt`, { type: 'text/plain' }),
      );

      // Initial batch of 15 files with 0 already buffered
      const res1 = bufferAttachmentFiles(files, 0, {
        createId: () => 'id-test',
        createPreviewUrl: () => 'blob:test',
      });
      expect(res1.attachments.length).toBe(10);
      expect(res1.limitCount).toBe(5);

      // Batch of 5 files when 8 are already buffered -> allows 2, 3 overflow
      const res2 = bufferAttachmentFiles(files.slice(0, 5), 8, {
        createId: () => 'id-test',
        createPreviewUrl: () => 'blob:test',
      });
      expect(res2.attachments.length).toBe(2);
      expect(res2.limitCount).toBe(3);

      // Batch when 10 are already buffered -> allows 0, 5 overflow
      const res3 = bufferAttachmentFiles(files.slice(0, 5), 10, {
        createId: () => 'id-test',
        createPreviewUrl: () => 'blob:test',
      });
      expect(res3.attachments.length).toBe(0);
      expect(res3.limitCount).toBe(5);
    });

    it('correctly formats validation notice banner for size and count limits', () => {
      expect(formatAttachmentValidationNotice(0, 0)).toBeNull();

      expect(formatAttachmentValidationNotice(3, 0)).toBe(
        '3 attachment(s) exceeded the 20 MB limit. The remaining eligible files were buffered locally.',
      );

      expect(formatAttachmentValidationNotice(0, 4)).toBe(
        '4 attachment(s) exceeded the 10-file limit. The remaining eligible files were buffered locally.',
      );

      expect(formatAttachmentValidationNotice(2, 5)).toBe(
        '2 attachment(s) exceeded the 20 MB limit; 5 attachment(s) exceeded the 10-file limit. The remaining eligible files were buffered locally.',
      );
    });
  });

  describe('2. Preview Modal 512KB Truncation & Media Type Handling', () => {
    it('truncates preview text at exactly 512KB (524,288 bytes) and appends notice', () => {
      const MAX_PREVIEW_BYTES = 512 * 1024;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // Case 1: Under limit (500KB)
      const data500 = 'X'.repeat(500 * 1024);
      const bytes500 = encoder.encode(data500);
      const preview500 = bytes500.subarray(0, MAX_PREVIEW_BYTES);
      const text500 = bytes500.byteLength > preview500.byteLength
        ? `${decoder.decode(preview500)}\n\n[Preview truncated at 512 KB]`
        : decoder.decode(preview500);

      expect(text500.length).toBe(500 * 1024);
      expect(text500).not.toContain('[Preview truncated at 512 KB]');

      // Case 2: Over limit (550KB)
      const data550 = 'Y'.repeat(550 * 1024);
      const bytes550 = encoder.encode(data550);
      const preview550 = bytes550.subarray(0, MAX_PREVIEW_BYTES);
      const text550 = bytes550.byteLength > preview550.byteLength
        ? `${decoder.decode(preview550)}\n\n[Preview truncated at 512 KB]`
        : decoder.decode(preview550);

      expect(preview550.byteLength).toBe(512 * 1024);
      expect(text550).toContain('[Preview truncated at 512 KB]');
    });

    it('identifies inline image and text preview attachment types', () => {
      expect(isInlineAttachmentImage('image/png')).toBe(true);
      expect(isInlineAttachmentImage('image/jpeg')).toBe(true);
      expect(isInlineAttachmentImage('image/gif')).toBe(true);
      expect(isInlineAttachmentImage('application/pdf')).toBe(false);

      expect(isTextPreviewAttachment('text/plain')).toBe(true);
      expect(isTextPreviewAttachment('application/json')).toBe(true);
      expect(isTextPreviewAttachment('application/typescript')).toBe(true);
      expect(isTextPreviewAttachment('image/png')).toBe(false);
    });
  });

  describe('3. Attachment State Badge Transitions & Interactions', () => {
    it('renders state badges correctly across full state transition lifecycle', () => {
      const states: ComposerAttachment['state'][] = [
        'buffered',
        'uploading',
        'packaging',
        'transferring',
        'verifying',
        'ready',
        'error',
      ];

      for (const state of states) {
        const attachment: ComposerAttachment = {
          id: `att-${state}`,
          name: `file-${state}.txt`,
          mediaType: 'text/plain',
          sizeBytes: 1024,
          state,
          ...(state === 'error' ? { errorMessage: 'Failed to upload' } : {}),
        };

        const html = renderToStaticMarkup(
          <ChatComposer {...dummyComposerProps} attachments={[attachment]} />,
        );

        expect(html).toContain(`attachment-badge-${state}`);
        expect(html).toContain(ATTACHMENT_STATE_LABEL[state]);

        const isProcessing =
          state === 'uploading' ||
          state === 'packaging' ||
          state === 'transferring' ||
          state === 'verifying';

        if (isProcessing) {
          expect(html).toContain('disabled=""');
        } else {
          // buffered, ready, error should allow removal
          const removeBtnSub = html.slice(html.indexOf(`Remove file-${state}.txt`));
          expect(removeBtnSub.split('>')[0]).not.toContain('disabled');
        }

        if (state === 'error') {
          expect(html).toContain('attachment-badge-error');
          expect(html).toContain('!');
        }
      }
    });

    it('renders retry button for failed attachments when onRetryAttachment is provided', () => {
      const attachment: ComposerAttachment = {
        id: 'att-err',
        name: 'failing.json',
        mediaType: 'application/json',
        sizeBytes: 2048,
        state: 'error',
        errorMessage: 'Connection lost',
      };

      const onRetryMock = vi.fn();
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyComposerProps}
          attachments={[attachment]}
          onRetryAttachment={onRetryMock}
        />,
      );

      expect(html).toContain('attachment-retry');
      expect(html).toContain('Retry failing.json');
    });
  });

  describe('4. Bridge.ts Window Guard & Platform Resolution', () => {
    it('throws clean Error without ReferenceError when window is undefined in Node/SSR environment', async () => {
      vi.resetModules();
      delete (globalThis as any).window;
      const { getBridge: getBridgeFresh } = await import('../../../platform/bridge');
      expect(() => getBridgeFresh()).toThrow('No platform bridge available');
    });

    it('returns window.cozypad when window and window.cozypad are defined', () => {
      const bridge = getBridge();
      expect(bridge).toBe((globalThis as any).window.cozypad);
    });
  });
});
