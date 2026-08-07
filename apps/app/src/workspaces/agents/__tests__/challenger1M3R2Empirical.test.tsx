import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SlashCommand } from '@cozypad/contracts';
import {
  ATTACHMENT_STATE_LABEL,
  ChatComposer,
  caretIsOnHistoryEdge,
  isExactSlashCommand,
  navigatePromptHistory,
  normalizeSlashCommandName,
  slashCommandSelectionBehavior,
} from '../ChatComposer';
import {
  bufferAttachmentFiles,
  createAgyMediaUploadArchive,
  formatAttachmentSize,
  formatAttachmentValidationNotice,
  getAttachmentFileTypeBadge,
  promptWithAttachmentReferences,
} from '../attachmentBuffer';
import {
  attachmentDataUrl,
  isInlineAttachmentImage,
  isTextPreviewAttachment,
} from '../MessageAttachments';
import { getBridge } from '../../../platform/bridge';

describe('Challenger 1 - Iteration 2 Empirical Stress & Verification Suite for Milestone 3', () => {
  const dummyProps = {
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

  describe('1. Platform Bridge Node/SSR Environment Window Guard', () => {
    const originalWindow = globalThis.window;

    afterEach(() => {
      globalThis.window = originalWindow;
    });

    it('throws a clean Error instead of ReferenceError when window is undefined in Node/SSR', () => {
      // Simulate SSR environment where window is undefined
      // @ts-ignore
      delete globalThis.window;

      expect(() => getBridge()).toThrow(
        'No platform bridge available: run CozyPad through Electron or the mobile shell.',
      );
    });

    it('returns window.cozypad when window and window.cozypad exist', () => {
      const mockBridge = { kind: 'electron-ipc' } as any;
      // @ts-ignore
      globalThis.window = { cozypad: mockBridge };

      expect(getBridge()).toBe(mockBridge);
    });
  });

  describe('2. Caret Position & Prompt History Navigation Edge Cases', () => {
    it('detects history edge correctly for top/bottom boundary in textarea', () => {
      const textareaTopEdge = {
        value: 'Single line text',
        selectionStart: 0,
        selectionEnd: 0,
      } as HTMLTextAreaElement;

      expect(caretIsOnHistoryEdge(textareaTopEdge, 'previous')).toBe(true);

      const textareaMultiLineMiddle = {
        value: 'Line 1\nLine 2\nLine 3',
        selectionStart: 8, // inside Line 2
        selectionEnd: 8,
      } as HTMLTextAreaElement;

      expect(caretIsOnHistoryEdge(textareaMultiLineMiddle, 'previous')).toBe(false);
      expect(caretIsOnHistoryEdge(textareaMultiLineMiddle, 'next')).toBe(false);

      const textareaMultiLineTop = {
        value: 'Line 1\nLine 2\nLine 3',
        selectionStart: 3, // inside Line 1
        selectionEnd: 3,
      } as HTMLTextAreaElement;

      expect(caretIsOnHistoryEdge(textareaMultiLineTop, 'previous')).toBe(true);
      expect(caretIsOnHistoryEdge(textareaMultiLineTop, 'next')).toBe(false);

      const textareaMultiLineBottom = {
        value: 'Line 1\nLine 2\nLine 3',
        selectionStart: 18, // inside Line 3
        selectionEnd: 18,
      } as HTMLTextAreaElement;

      expect(caretIsOnHistoryEdge(textareaMultiLineBottom, 'previous')).toBe(false);
      expect(caretIsOnHistoryEdge(textareaMultiLineBottom, 'next')).toBe(true);
    });

    it('navigates history forwards and backwards preserving unsaved draft', () => {
      const history = ['Prompt A', 'Prompt B'];
      const draft = 'Unfinished user draft';

      // Step 1: Up arrow from draft to Prompt B
      const res1 = navigatePromptHistory(history, null, draft, 'previous');
      expect(res1).toEqual({ index: 1, value: 'Prompt B' });

      // Step 2: Up arrow from Prompt B to Prompt A
      const res2 = navigatePromptHistory(history, 1, draft, 'previous');
      expect(res2).toEqual({ index: 0, value: 'Prompt A' });

      // Step 3: Up arrow from Prompt A (already at oldest)
      const res3 = navigatePromptHistory(history, 0, draft, 'previous');
      expect(res3).toEqual({ index: 0, value: 'Prompt A' });

      // Step 4: Down arrow from Prompt A to Prompt B
      const res4 = navigatePromptHistory(history, 0, draft, 'next');
      expect(res4).toEqual({ index: 1, value: 'Prompt B' });

      // Step 5: Down arrow from Prompt B back to unsaved draft
      const res5 = navigatePromptHistory(history, 1, draft, 'next');
      expect(res5).toEqual({ index: null, value: 'Unfinished user draft' });
    });
  });

  describe('3. Slash Commands Edge Cases & Selection Behaviors', () => {
    it('normalizes slash command names with leading slashes and whitespace', () => {
      expect(normalizeSlashCommandName('  ///clear  ')).toBe('clear');
      expect(normalizeSlashCommandName('/compact')).toBe('compact');
      expect(normalizeSlashCommandName('help')).toBe('help');
    });

    it('identifies exact slash commands case-insensitively', () => {
      const cmd: SlashCommand = { name: 'clear', description: 'Clear session' };
      expect(isExactSlashCommand('/clear', cmd)).toBe(true);
      expect(isExactSlashCommand('/CLEAR ', cmd)).toBe(true);
      expect(isExactSlashCommand('/cle', cmd)).toBe(false);
    });

    it('handles custom selection behaviors (insert, submit, picker)', () => {
      const cmdInsert: SlashCommand = { name: 'a', description: '', behavior: 'insert' };
      const cmdSubmit: SlashCommand = { name: 'b', description: '', behavior: 'submit' };
      const cmdPicker: SlashCommand = { name: 'c', description: '', behavior: 'picker' };
      const cmdDefault: SlashCommand = { name: 'd', description: '' };

      expect(slashCommandSelectionBehavior(cmdInsert)).toBe('insert');
      expect(slashCommandSelectionBehavior(cmdSubmit)).toBe('submit');
      expect(slashCommandSelectionBehavior(cmdPicker)).toBe('picker');
      expect(slashCommandSelectionBehavior(cmdDefault)).toBe('insert');
    });

    it('renders slash menu badge for CozyPad owned commands', () => {
      const commands: SlashCommand[] = [
        { name: 'clear', description: 'Clear history', owner: 'cozypad' },
      ];
      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/c" commands={commands} />,
      );
      expect(html).toContain('class="slash-owner"');
      expect(html).toContain('CozyPad');
    });
  });

  describe('4. Attachment Buffer Engine & Constraints', () => {
    it('enforces 20 MB size limit per attachment', () => {
      const smallFile = new File(['hello'], 'small.txt', { type: 'text/plain' });
      const bigBuffer = new Uint8Array(21 * 1024 * 1024); // 21 MB
      const bigFile = new File([bigBuffer], 'huge.bin', { type: 'application/octet-stream' });

      const result = bufferAttachmentFiles([smallFile, bigFile], 0);
      expect(result.attachments.length).toBe(1);
      expect(result.attachments[0]!.name).toBe('small.txt');
      expect(result.oversizedCount).toBe(1);
      expect(result.limitCount).toBe(0);
    });

    it('enforces 10 max attachments count limit', () => {
      const files = Array.from(
        { length: 12 },
        (_, i) => new File(['data'], `file${i + 1}.txt`, { type: 'text/plain' }),
      );

      const result = bufferAttachmentFiles(files, 0);
      expect(result.attachments.length).toBe(10);
      expect(result.oversizedCount).toBe(0);
      expect(result.limitCount).toBe(2);
    });

    it('formats validation notice correctly for oversized and limit overflow', () => {
      expect(formatAttachmentValidationNotice(0, 0)).toBeNull();
      expect(formatAttachmentValidationNotice(1, 2)).toBe(
        '1 attachment(s) exceeded the 20 MB limit; 2 attachment(s) exceeded the 10-file limit. The remaining eligible files were buffered locally.',
      );
    });

    it('formats file sizes accurately', () => {
      expect(formatAttachmentSize(500)).toBe('500 B');
      expect(formatAttachmentSize(1500)).toBe('2 KB');
      expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('maps attachment file types to 3-4 letter badges', () => {
      expect(getAttachmentFileTypeBadge('text/markdown', 'readme.md')).toBe('MD');
      expect(getAttachmentFileTypeBadge('application/typescript', 'app.ts')).toBe('CODE');
      expect(getAttachmentFileTypeBadge('text/plain', 'notes.txt')).toBe('TXT');
      expect(getAttachmentFileTypeBadge('application/zip', 'archive.zip')).toBe('ZIP');
      expect(getAttachmentFileTypeBadge('application/pdf', 'doc.pdf')).toBe('PDF');
      expect(getAttachmentFileTypeBadge('audio/mp3', 'song.mp3')).toBe('MEDIA');
      expect(getAttachmentFileTypeBadge('image/png', 'photo.png')).toBe('IMG');
      expect(getAttachmentFileTypeBadge('application/octet-stream', 'unknown.dat')).toBe('FILE');
    });

    it('disables removal button only for active uploading states in composer', () => {
      const attachments = [
        {
          id: 'att-1',
          name: 'uploading.txt',
          mediaType: 'text/plain',
          sizeBytes: 100,
          state: 'uploading' as const,
        },
        {
          id: 'att-2',
          name: 'ready.txt',
          mediaType: 'text/plain',
          sizeBytes: 100,
          state: 'ready' as const,
        },
        {
          id: 'att-3',
          name: 'error.txt',
          mediaType: 'text/plain',
          sizeBytes: 100,
          state: 'error' as const,
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          attachments={attachments}
          onRetryAttachment={vi.fn()}
        />,
      );

      expect(html).toContain('composer-attachment-uploading');
      expect(html).toContain('composer-attachment-ready');
      expect(html).toContain('composer-attachment-error');
      // Retry button rendered for error state
      expect(html).toContain('Retry error.txt');
    });

    it('formats prompt with non-media attachment references cleanly', () => {
      const prompt = 'Check these documents';
      const attachments = [
        {
          name: 'config.json',
          mediaType: 'application/json',
          sizeBytes: 128,
          remotePath: '/tmp/session-1/config.json',
        },
      ];

      const formatted = promptWithAttachmentReferences(prompt, attachments);
      expect(formatted).toContain('Check these documents');
      expect(formatted).toContain('/tmp/session-1/config.json');
      expect(formatted).toContain('original name: config.json');
    });
  });

  describe('5. Message Attachment Previews & Large Archive Building', () => {
    it('recognizes inline image media types', () => {
      expect(isInlineAttachmentImage('image/png')).toBe(true);
      expect(isInlineAttachmentImage('IMAGE/JPEG')).toBe(true);
      expect(isInlineAttachmentImage('application/pdf')).toBe(false);
    });

    it('recognizes text preview media types', () => {
      expect(isTextPreviewAttachment('text/plain')).toBe(true);
      expect(isTextPreviewAttachment('application/json')).toBe(true);
      expect(isTextPreviewAttachment('application/x-sh')).toBe(true);
      expect(isTextPreviewAttachment('image/png')).toBe(false);
    });

    it('constructs data URLs for supported image media types and rejects others', () => {
      expect(attachmentDataUrl('image/png', 'ABC=')).toBe('data:image/png;base64,ABC=');
      expect(() => attachmentDataUrl('application/pdf', 'ABC=')).toThrow(
        'Unsupported inline attachment media type: application/pdf',
      );
    });

    it('creates a valid tar.gz media upload archive containing buffered file payload', async () => {
      const fileData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const mockFile = new File([fileData], 'sample.png', { type: 'image/png' });

      const archiveBase64 = await createAgyMediaUploadArchive([
        { mediaType: 'image/png', file: mockFile },
      ]);

      expect(typeof archiveBase64).toBe('string');
      expect(archiveBase64.length).toBeGreaterThan(0);
    });
  });

  describe('6. Composer Disabled States & Failure Explanations', () => {
    it('renders clear status banner when composer is disabled with next step explanation', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          disabled={true}
          disabledReason={{
            text: 'Agent connection lost.',
            nextStep: 'Click reconnect in the session header to try again.',
          }}
        />,
      );

      expect(html).toContain('class="composer-unavailable"');
      expect(html).toContain('Agent connection lost.');
      expect(html).toContain('Click reconnect in the session header to try again.');
    });

    it('renders attachmentNotice banner when specified', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          attachmentNotice="1 file exceeded maximum size of 20 MB."
        />,
      );

      expect(html).toContain('class="attachment-notice-banner"');
      expect(html).toContain('1 file exceeded maximum size of 20 MB.');
    });
  });
});
