import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '@cozypad/contracts';
import { AssistantMarkdown, normalizeHackmdDisplayMath } from '../AssistantMarkdown';
import { ChatComposer } from '../ChatComposer';
import { ChatTimeline } from '../ChatTimeline';
import type { ComposerAttachment } from '../attachmentBuffer';

describe('Edge Cases & Resilience Test Suite', () => {
  describe('Malformed Markdown & Math Resilience', () => {
    it('handles unclosed code fences without breaking layout', () => {
      const malformedCode = 'Here is code:\n```typescript\nconst a = 123;\nfunction test() {';
      const html = renderToStaticMarkup(
        <AssistantMarkdown>{malformedCode}</AssistantMarkdown>,
      );

      expect(html).toContain('Here is code:');
      expect(html).toContain('123');
      expect(html).toContain('language-typescript');
    });

    it('handles unclosed display math blocks without throwing', () => {
      const malformedMath = 'Formula starts here:\n$$\n\\sum_{i=0}^n i^2';
      const html = renderToStaticMarkup(
        <AssistantMarkdown>{malformedMath}</AssistantMarkdown>,
      );

      expect(html).toContain('Formula starts here:');
    });

    it('handles empty assistant markdown text gracefully', () => {
      const html = renderToStaticMarkup(<AssistantMarkdown>{''}</AssistantMarkdown>);
      expect(html).toBe('');
    });

    it('preserves code blocks containing math-like dollar signs', () => {
      const codeWithDollars = '```bash\nexport COST=$100\necho $$PID\n```';
      const normalized = normalizeHackmdDisplayMath(codeWithDollars);
      expect(normalized).toBe(codeWithDollars);
    });
  });

  describe('Empty Input & Double-Click Protection', () => {
    it('disables send button when text is empty and attachments list is empty', () => {
      const dummyProps = {
        agentLabel: 'Claude',
        value: '   ',
        history: [],
        commands: [],
        attachments: [],
        onChange: vi.fn(),
        onAttach: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onSend: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} />);
      expect(html).toContain('class="composer-send"');
      expect(html).toContain('disabled=""');
    });

    it('enables send button when attachments exist even if text is empty', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-1',
          name: 'doc.txt',
          mediaType: 'text/plain',
          sizeBytes: 100,
          state: 'ready',
        },
      ];

      const dummyProps = {
        agentLabel: 'Claude',
        value: '',
        history: [],
        commands: [],
        attachments,
        onChange: vi.fn(),
        onAttach: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onSend: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} />);
      expect(html).not.toContain('disabled=""');
    });

    it('prevents submission when composer is uploading or disabled', () => {
      const dummyProps = {
        agentLabel: 'Claude',
        value: 'Valid message',
        history: [],
        commands: [],
        attachments: [],
        uploading: true,
        onChange: vi.fn(),
        onAttach: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onSend: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} />);
      expect(html).toContain('disabled=""');
    });
  });

  describe('Connection Errors & Disruption Handling', () => {
    it('renders timeline with offline/error notices cleanly', () => {
      const items: ChatItem[] = [
        {
          id: 'err-notice-1',
          kind: 'notice',
          timestamp: '2026-08-07T00:00:00.000Z',
          text: 'Connection to remote host lost. Reconnecting...',
        },
      ];

      const dummyProps = {
        sessionId: 'session-err',
        onResolveApproval: vi.fn(),
        onAnswerQuestion: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('Connection to remote host lost');
    });
  });

  describe('Multi-Attachment State Combinations (Tier 3)', () => {
    it('renders tray containing uploading, ready, and errored attachments together', () => {
      const mixedAttachments: ComposerAttachment[] = [
        {
          id: '1',
          name: 'img1.png',
          mediaType: 'image/png',
          sizeBytes: 1000,
          state: 'transferring',
        },
        {
          id: '2',
          name: 'doc.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 50000,
          state: 'ready',
        },
        {
          id: '3',
          name: 'large.bin',
          mediaType: 'application/octet-stream',
          sizeBytes: 1000000,
          state: 'error',
          errorMessage: 'File too large',
        },
      ];

      const dummyProps = {
        agentLabel: 'Claude',
        value: 'Check these files',
        history: [],
        commands: [],
        attachments: mixedAttachments,
        onChange: vi.fn(),
        onAttach: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onSend: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} />);
      expect(html).toContain('img1.png');
      expect(html).toContain('doc.pdf');
      expect(html).toContain('large.bin');
      expect(html).toContain('Transferring');
      expect(html).toContain('Ready');
      expect(html).toContain('Error');
    });
  });
});
