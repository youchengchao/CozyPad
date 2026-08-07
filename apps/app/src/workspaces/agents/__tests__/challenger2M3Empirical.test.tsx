import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_AGENT_ATTACHMENT_BYTES, MAX_AGENT_ATTACHMENTS } from '@cozypad/contracts';
import { ATTACHMENT_STATE_LABEL, ChatComposer } from '../ChatComposer';
import { MessageAttachments, isInlineAttachmentImage, isTextPreviewAttachment } from '../MessageAttachments';
import {
  bufferAttachmentFiles,
  formatAttachmentSize,
  formatAttachmentValidationNotice,
  getAttachmentFileTypeBadge,
} from '../attachmentBuffer';
import type { ComposerAttachment } from '../attachmentBuffer';
import type { ChatAttachment } from '@cozypad/contracts';

describe('Challenger 2 M3 Empirical Verification Suite - Attachment Engine, Preview Modal & Buffer Validation', () => {
  beforeEach(() => {
    // Provide window.cozypad mock for getBridge() in SSR/Node environment
    (globalThis as any).window = {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
        writeClipboard: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  const dummyComposerProps = {
    agentLabel: 'Claude',
    value: '',
    history: [],
    commands: [],
    attachments: [],
    onChange: vi.fn(),
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(),
  };

  describe('1. Attachment Status Badge Matrix & Interactions', () => {
    it('renders uploading spinner state badge for uploading, packaging, transferring, verifying states', () => {
      const states: ComposerAttachment['state'][] = [
        'uploading',
        'packaging',
        'transferring',
        'verifying',
      ];

      for (const state of states) {
        const attachments: ComposerAttachment[] = [
          {
            id: `att-${state}`,
            name: `file-${state}.txt`,
            mediaType: 'text/plain',
            sizeBytes: 1024,
            state,
          },
        ];

        const html = renderToStaticMarkup(
          <ChatComposer {...dummyComposerProps} attachments={attachments} />,
        );

        expect(html).toContain(`attachment-badge-${state}`);
        expect(html).toContain('attachment-spinner');
        expect(html).toContain(ATTACHMENT_STATE_LABEL[state]);
        // Disables remove button during uploading/processing
        expect(html).toContain('aria-label="Remove file-' + state + '.txt"');
        expect(html).toContain('disabled=""');
      }
    });

    it('renders ready checkmark status badge for ready state and enables remove button', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-ready-1',
          name: 'done.png',
          mediaType: 'image/png',
          sizeBytes: 2048,
          state: 'ready',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer {...dummyComposerProps} attachments={attachments} />,
      );

      expect(html).toContain('attachment-badge-ready');
      expect(html).toContain('✓');
      expect(html).toContain(ATTACHMENT_STATE_LABEL.ready);
      // Remove button is NOT disabled for ready state
      expect(html).toContain('aria-label="Remove done.png"');
      expect(html).not.toContain('disabled=""');
    });

    it('renders error alert status badge and retry button when onRetryAttachment callback is provided', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-err-1',
          name: 'failed.json',
          mediaType: 'application/json',
          sizeBytes: 500,
          state: 'error',
          errorMessage: 'Network timeout',
        },
      ];

      const onRetryMock = vi.fn();
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyComposerProps}
          attachments={attachments}
          onRetryAttachment={onRetryMock}
        />,
      );

      expect(html).toContain('attachment-badge-error');
      expect(html).toContain('!');
      expect(html).toContain(ATTACHMENT_STATE_LABEL.error);
      expect(html).toContain('attachment-retry');
      expect(html).toContain('title="Retry failed.json"');
      expect(html).toContain('重試');
    });

    it('renders file type icon badges accurately for different media types and file extensions', () => {
      expect(getAttachmentFileTypeBadge('text/typescript', 'index.ts')).toBe('CODE');
      expect(getAttachmentFileTypeBadge('application/json', 'config.json')).toBe('CODE');
      expect(getAttachmentFileTypeBadge('text/plain', 'notes.txt')).toBe('TXT');
      expect(getAttachmentFileTypeBadge('text/markdown', 'README.md')).toBe('MD');
      expect(getAttachmentFileTypeBadge('application/zip', 'archive.zip')).toBe('ZIP');
      expect(getAttachmentFileTypeBadge('application/pdf', 'doc.pdf')).toBe('PDF');
      expect(getAttachmentFileTypeBadge('video/mp4', 'video.mp4')).toBe('MEDIA');
      expect(getAttachmentFileTypeBadge('image/png', 'photo.png')).toBe('IMG');
      expect(getAttachmentFileTypeBadge('application/octet-stream', 'data.bin')).toBe('FILE');
    });
  });

  describe('2. Text File Preview Modal & Truncation Logic', () => {
    it('correctly identifies text preview attachment media types', () => {
      expect(isTextPreviewAttachment('text/plain')).toBe(true);
      expect(isTextPreviewAttachment('text/markdown')).toBe(true);
      expect(isTextPreviewAttachment('application/json')).toBe(true);
      expect(isTextPreviewAttachment('application/yaml')).toBe(true);
      expect(isTextPreviewAttachment('application/xml')).toBe(true);
      expect(isTextPreviewAttachment('application/javascript')).toBe(true);
      expect(isTextPreviewAttachment('application/typescript')).toBe(true);
      expect(isTextPreviewAttachment('image/svg+xml')).toBe(true);

      // Non-text files return false
      expect(isTextPreviewAttachment('image/png')).toBe(false);
      expect(isTextPreviewAttachment('application/pdf')).toBe(false);
      expect(isTextPreviewAttachment('application/zip')).toBe(false);
    });

    it('identifies inline image media types', () => {
      expect(isInlineAttachmentImage('image/png')).toBe(true);
      expect(isInlineAttachmentImage('image/jpeg')).toBe(true);
      expect(isInlineAttachmentImage('image/webp')).toBe(true);
      expect(isInlineAttachmentImage('image/gif')).toBe(true);
      expect(isInlineAttachmentImage('application/json')).toBe(false);
    });

    it('renders timeline message attachments with clickable cards that trigger preview modals', () => {
      const attachments: ChatAttachment[] = [
        {
          id: 'chat-att-1',
          name: 'script.py',
          mediaType: 'application/x-python',
          sizeBytes: 1500,
          remotePath: '/sessions/s1/attachments/script.py',
        },
        {
          id: 'chat-att-2',
          name: 'image.jpg',
          mediaType: 'image/jpeg',
          sizeBytes: 250000,
          remotePath: '/sessions/s1/attachments/image.jpg',
        },
      ];

      const html = renderToStaticMarkup(<MessageAttachments attachments={attachments} />);

      expect(html).toContain('class="message-attachments"');
      expect(html).toContain('aria-label="Message attachments"');
      expect(html).toContain('title="Open script.py"');
      expect(html).toContain('title="Open image.jpg"');
      expect(html).toContain('CODE'); // badge for script.py
      expect(html).toContain('2 KB'); // Math.ceil(1500/1024) = 2 KB
      expect(html).toContain('245 KB'); // Math.ceil(250000/1024) = 245 KB
    });

    it('simulates 512KB text truncation logic accurately', () => {
      const MAX_PREVIEW_BYTES = 512 * 1024; // 524,288 bytes
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // Case A: File smaller than 512KB
      const smallText = 'Hello world, this is a small file.';
      const smallBytes = encoder.encode(smallText);
      const smallPreview = smallBytes.subarray(0, MAX_PREVIEW_BYTES);
      const smallDecoded = decoder.decode(smallPreview);
      const smallResult = smallBytes.byteLength > smallPreview.byteLength
        ? `${smallDecoded}\n\n[Preview truncated at 512 KB]`
        : smallDecoded;

      expect(smallResult).toBe(smallText);
      expect(smallResult).not.toContain('[Preview truncated at 512 KB]');

      // Case B: File larger than 512KB (600KB)
      const largeChunk = 'A'.repeat(600 * 1024);
      const largeBytes = encoder.encode(largeChunk);
      const largePreview = largeBytes.subarray(0, MAX_PREVIEW_BYTES);
      const largeDecoded = decoder.decode(largePreview);
      const largeResult = largeBytes.byteLength > largePreview.byteLength
        ? `${largeDecoded}\n\n[Preview truncated at 512 KB]`
        : largeDecoded;

      expect(largePreview.byteLength).toBe(512 * 1024);
      expect(largeResult).toContain('[Preview truncated at 512 KB]');
      expect(largeResult.startsWith('A'.repeat(1000))).toBe(true);
    });
  });

  describe('3. Buffer Validation & Limit Enforcements', () => {
    it('rejects oversized files (>20MB) and returns oversizedCount', () => {
      const smallFile = new File(['hello'], 'small.txt', { type: 'text/plain' });
      const oversizedFile = new File(['x'.repeat(100)], 'huge.bin', {
        type: 'application/octet-stream',
      });
      // Override size property to exceed MAX_AGENT_ATTACHMENT_BYTES (20MB)
      Object.defineProperty(oversizedFile, 'size', {
        value: MAX_AGENT_ATTACHMENT_BYTES + 1,
      });

      const result = bufferAttachmentFiles([smallFile, oversizedFile], 0, {
        createId: () => 'test-id',
        createPreviewUrl: () => 'blob:test',
      });

      expect(result.attachments.length).toBe(1);
      expect(result.attachments[0]?.name).toBe('small.txt');
      expect(result.oversizedCount).toBe(1);
      expect(result.limitCount).toBe(0);
    });

    it('enforces maximum 10 attachments limit and returns limitCount', () => {
      const files: File[] = Array.from({ length: 15 }, (_, i) =>
        new File([`content ${i}`], `file_${i}.txt`, { type: 'text/plain' }),
      );

      const result = bufferAttachmentFiles(files, 0, {
        createId: () => `id-${Math.random()}`,
        createPreviewUrl: () => 'blob:test',
      });

      expect(result.attachments.length).toBe(MAX_AGENT_ATTACHMENTS); // 10
      expect(result.oversizedCount).toBe(0);
      expect(result.limitCount).toBe(5); // 15 - 10 = 5 excess files
    });

    it('enforces remaining attachment limit when currentCount is already non-zero', () => {
      const files: File[] = Array.from({ length: 5 }, (_, i) =>
        new File([`content ${i}`], `file_${i}.txt`, { type: 'text/plain' }),
      );

      const result = bufferAttachmentFiles(files, 8, {
        createId: () => 'test-id',
        createPreviewUrl: () => 'blob:test',
      });

      // Max is 10, current is 8, so only 2 allowed
      expect(result.attachments.length).toBe(2);
      expect(result.limitCount).toBe(3);
    });

    it('formats attachment validation notice banners for size limit and file count limit', () => {
      // Size limit exceeded only
      const sizeNotice = formatAttachmentValidationNotice(2, 0);
      expect(sizeNotice).toBe(
        '2 attachment(s) exceeded the 20 MB limit. The remaining eligible files were buffered locally.',
      );

      // File count limit exceeded only
      const countNotice = formatAttachmentValidationNotice(0, 3);
      expect(countNotice).toBe(
        `3 attachment(s) exceeded the ${MAX_AGENT_ATTACHMENTS}-file limit. The remaining eligible files were buffered locally.`,
      );

      // Both size and count limit exceeded
      const bothNotice = formatAttachmentValidationNotice(1, 4);
      expect(bothNotice).toBe(
        `1 attachment(s) exceeded the 20 MB limit; 4 attachment(s) exceeded the ${MAX_AGENT_ATTACHMENTS}-file limit. The remaining eligible files were buffered locally.`,
      );

      // Neither exceeded
      expect(formatAttachmentValidationNotice(0, 0)).toBeNull();
    });

    it('renders attachmentNotice banner in ChatComposer when validation notice is provided', () => {
      const notice = formatAttachmentValidationNotice(1, 2);
      expect(notice).not.toBeNull();

      const html = renderToStaticMarkup(
        <ChatComposer {...dummyComposerProps} attachmentNotice={notice!} />,
      );

      expect(html).toContain('class="attachment-notice-banner"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('1 attachment(s) exceeded the 20 MB limit');
      expect(html).toContain('2 attachment(s) exceeded the 10-file limit');
    });
  });
});
