import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SlashCommand } from '@cozypad/contracts';
import {
  ATTACHMENT_STATE_LABEL,
  ChatComposer,
  isExactSlashCommand,
  navigatePromptHistory,
  normalizeSlashCommandName,
  slashCommandSelectionBehavior,
} from '../ChatComposer';
import type { ComposerAttachment } from '../attachmentBuffer';
import { formatAttachmentSize } from '../attachmentBuffer';
import { isInlineAttachmentImage, isTextPreviewAttachment } from '../MessageAttachments';

describe('ChatComposer & Attachment System Suite', () => {
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

  describe('Slash Command Parsing & Behaviors', () => {
    it('normalizes leading slashes correctly', () => {
      expect(normalizeSlashCommandName('compact')).toBe('compact');
      expect(normalizeSlashCommandName('/compact')).toBe('compact');
      expect(normalizeSlashCommandName('///compact')).toBe('compact');
    });

    it('identifies exact slash command matches accurately', () => {
      const command: SlashCommand = { name: '/compact', description: 'Compact context' };
      expect(isExactSlashCommand('/com', command)).toBe(false);
      expect(isExactSlashCommand('/compact', command)).toBe(true);
      expect(isExactSlashCommand('/COMPACT', command)).toBe(true);
    });

    it('determines selection behavior (insert, submit, picker)', () => {
      expect(slashCommandSelectionBehavior({ name: 'model', description: '', behavior: 'picker' })).toBe('picker');
      expect(slashCommandSelectionBehavior({ name: 'permissions', description: '', behavior: 'submit' })).toBe('submit');
      expect(slashCommandSelectionBehavior({ name: 'rename', description: '' })).toBe('insert');
    });

    it('renders slash command suggestions dropdown menu when text begins with /', () => {
      const commands: SlashCommand[] = [
        { name: 'compact', description: 'Compact context' },
        { name: 'clear', description: 'Clear screen', owner: 'cozypad' },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/c" commands={commands} />,
      );

      expect(html).toContain('class="slash-menu"');
      expect(html).toContain('/compact');
      expect(html).toContain('/clear');
      expect(html).toContain('class="slash-owner"');
      expect(html).toContain('CozyPad');
    });
  });

  describe('Composer Textarea & Unavailable Reasons', () => {
    it('calculates textarea rows auto-grow up to max 6 rows', () => {
      const singleLine = renderToStaticMarkup(<ChatComposer {...dummyProps} value="line 1" />);
      expect(singleLine).toContain('rows="1"');

      const multiLineText = ['line 1', 'line 2', 'line 3'].join('\n');
      const multiLine = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value={multiLineText} />,
      );
      expect(multiLine).toContain('rows="3"');

      const tenLinesText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      const tenLines = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value={tenLinesText} />,
      );
      expect(tenLines).toContain('rows="6"');
    });

    it('renders dead composer message with disabled reason and next step', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          disabled={true}
          disabledReason={{
            text: 'Agent 正在執行上一個 Prompt',
            nextStep: '等待完成，或按 Stop 中止',
          }}
        />,
      );

      expect(html).toContain('class="composer-unavailable"');
      expect(html).toContain('Agent 正在執行上一個 Prompt');
      expect(html).toContain('等待完成，或按 Stop 中止');
    });
  });

  describe('Prompt History Navigation Engine', () => {
    const history = ['prompt 1', 'prompt 2', 'prompt 3'];

    it('navigates backwards through history stack', () => {
      const step1 = navigatePromptHistory(history, null, 'draft', 'previous');
      expect(step1).toEqual({ index: 2, value: 'prompt 3' });

      const step2 = navigatePromptHistory(history, 2, 'draft', 'previous');
      expect(step2).toEqual({ index: 1, value: 'prompt 2' });

      const step3 = navigatePromptHistory(history, 1, 'draft', 'previous');
      expect(step3).toEqual({ index: 0, value: 'prompt 1' });

      // Cannot go past oldest
      const step4 = navigatePromptHistory(history, 0, 'draft', 'previous');
      expect(step4).toEqual({ index: 0, value: 'prompt 1' });
    });

    it('navigates forward through history stack and restores draft text', () => {
      const step1 = navigatePromptHistory(history, 0, 'my draft text', 'next');
      expect(step1).toEqual({ index: 1, value: 'prompt 2' });

      const step2 = navigatePromptHistory(history, 1, 'my draft text', 'next');
      expect(step2).toEqual({ index: 2, value: 'prompt 3' });

      const step3 = navigatePromptHistory(history, 2, 'my draft text', 'next');
      expect(step3).toEqual({ index: null, value: 'my draft text' });
    });
  });

  describe('Attachment Trays, Badges & State Utilities', () => {
    it('formats attachment size human-readably', () => {
      expect(formatAttachmentSize(500)).toBe('500 B');
      expect(formatAttachmentSize(2048)).toBe('2 KB');
      expect(formatAttachmentSize(5242880)).toBe('5.0 MB');
    });

    it('identifies inline image and text preview attachment media types', () => {
      expect(isInlineAttachmentImage('image/png')).toBe(true);
      expect(isInlineAttachmentImage('image/jpeg')).toBe(true);
      expect(isInlineAttachmentImage('application/pdf')).toBe(false);

      expect(isTextPreviewAttachment('text/plain')).toBe(true);
      expect(isTextPreviewAttachment('application/json')).toBe(true);
      expect(isTextPreviewAttachment('application/yaml')).toBe(true);
      expect(isTextPreviewAttachment('image/png')).toBe(false);
    });

    it('renders attachment items in composer with state badges', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-1',
          name: 'screenshot.png',
          mediaType: 'image/png',
          sizeBytes: 10240,
          state: 'ready',
        },
        {
          id: 'att-2',
          name: 'data.json',
          mediaType: 'application/json',
          sizeBytes: 2048,
          state: 'error',
          errorMessage: 'Upload failed',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          attachments={attachments}
          onRetryAttachment={vi.fn()}
        />,
      );

      expect(html).toContain('composer-attachment');
      expect(html).toContain('screenshot.png');
      expect(html).toContain(ATTACHMENT_STATE_LABEL.ready); // 'Ready'
      expect(html).toContain(ATTACHMENT_STATE_LABEL.error); // 'Error'
      expect(html).toContain('attachment-retry');
      expect(html).toContain('重試');
    });

    it('disables attachment removal during processing state (packaging / transferring / verifying)', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-packaging',
          name: 'archive.zip',
          mediaType: 'application/zip',
          sizeBytes: 50000,
          state: 'packaging',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} attachments={attachments} />,
      );

      expect(html).toContain('aria-label="Remove archive.zip"');
      expect(html).toContain('disabled=""');
    });

    it('renders file icon badges for code, text, archive, pdf and image files', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-code',
          name: 'app.tsx',
          mediaType: 'text/typescript',
          sizeBytes: 1024,
          state: 'ready',
        },
        {
          id: 'att-zip',
          name: 'bundle.zip',
          mediaType: 'application/zip',
          sizeBytes: 50000,
          state: 'ready',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} attachments={attachments} />,
      );

      expect(html).toContain('composer-file-icon');
      expect(html).toContain('CODE');
      expect(html).toContain('ZIP');
    });

    it('renders visual status badge indicators (ready checkmark, error alert, uploading spinner)', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-uploading',
          name: 'uploading.png',
          mediaType: 'image/png',
          sizeBytes: 12000,
          state: 'uploading',
        },
        {
          id: 'att-ready',
          name: 'ready.png',
          mediaType: 'image/png',
          sizeBytes: 12000,
          state: 'ready',
        },
        {
          id: 'att-error',
          name: 'failed.txt',
          mediaType: 'text/plain',
          sizeBytes: 500,
          state: 'error',
          errorMessage: 'Server timeout',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          attachments={attachments}
          onRetryAttachment={vi.fn()}
        />,
      );

      expect(html).toContain('attachment-badge-uploading');
      expect(html).toContain('attachment-spinner');
      expect(html).toContain('attachment-badge-ready');
      expect(html).toContain('✓');
      expect(html).toContain('attachment-badge-error');
      expect(html).toContain('!');
    });

    it('renders validation notice banner when attachmentNotice prop is provided', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          attachmentNotice="1 attachment(s) exceeded the 20 MB limit."
        />,
      );

      expect(html).toContain('class="attachment-notice-banner"');
      expect(html).toContain('1 attachment(s) exceeded the 20 MB limit.');
    });
  });
});
