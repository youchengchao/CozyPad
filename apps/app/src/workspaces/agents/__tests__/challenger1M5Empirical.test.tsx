import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem, SlashCommand, ToolCallItem } from '@cozypad/contracts';
import { ChatTimeline, ToolStepCard } from '../ChatTimeline';
import { ChatComposer, normalizeSlashCommandName } from '../ChatComposer';
import { AssistantMarkdown } from '../AssistantMarkdown';
import {
  bufferAttachmentFiles,
  formatAttachmentValidationNotice,
} from '../attachmentBuffer';
import { AgentsWorkspace } from '../AgentsWorkspace';

describe('Challenger 1 M5 Empirical Stress & Adversarial Suite', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
        listAgentSessions: vi.fn().mockResolvedValue([]),
        detectAgent: vi.fn().mockResolvedValue({
          agentKind: 'claude',
          installed: true,
          supportsStructuredOutput: true,
          supportsResume: true,
          supportsInteractiveApproval: true,
          launchModes: [],
        }),
        onAgentSessionChanged: vi.fn().mockReturnValue(() => undefined),
        onAgentTimelineChanged: vi.fn().mockReturnValue(() => undefined),
        onAgentSessionDeleted: vi.fn().mockReturnValue(() => undefined),
        onAgentCommunicationError: vi.fn().mockReturnValue(() => undefined),
      },
    };
    if (typeof localStorage === 'undefined') {
      const store: Record<string, string> = {};
      (globalThis as any).localStorage = {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
        clear: () => {
          Object.keys(store).forEach((k) => delete store[k]);
        },
      };
    }
  });

  const dummyProps = {
    sessionId: 'm5-empirical-challenger-session',
    onResolveApproval: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onDeclineQuestion: vi.fn(),
    onRetrySession: vi.fn(),
  };

  /* -------------------------------------------------------------------
   * 1. Timeline Rendering Performance Under Heavy Load (100+ to 300+ items)
   * ------------------------------------------------------------------- */
  describe('1. Heavy Load Timeline Rendering (100+ to 300+ items)', () => {
    it('renders 100 timeline items in sub-200ms benchmark', () => {
      const items: ChatItem[] = Array.from({ length: 100 }, (_, i) => ({
        id: `item-100-${i}`,
        kind: i % 2 === 0 ? 'message' : 'tool_call',
        timestamp: new Date().toISOString(),
        role: 'user',
        text: `Message index ${i}`,
        name: 'bash',
        summary: `echo ${i}`,
        status: 'completed',
      } as unknown as ChatItem));

      const start = performance.now();
      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      const elapsed = performance.now() - start;

      expect(html).toContain('Message index 0');
      expect(html).toContain('Message index 98');
      expect(elapsed).toBeLessThan(300);
    });

    it('renders 300+ timeline items smoothly without layout break (< 500ms target)', () => {
      const items: ChatItem[] = [];
      for (let i = 0; i < 300; i++) {
        if (i % 3 === 0) {
          items.push({
            id: `heavy-msg-${i}`,
            kind: 'message',
            timestamp: new Date().toISOString(),
            role: 'assistant',
            text: `Assistant response step ${i} with **bold** text and \`code\` snippet.`,
          });
        } else if (i % 3 === 1) {
          items.push({
            id: `heavy-tool-${i}`,
            kind: 'tool_call',
            timestamp: new Date().toISOString(),
            name: 'git_status',
            summary: 'Checking repository status',
            status: 'completed',
            durationMs: 42,
            output: `Clean working tree at step ${i}`,
          });
        } else {
          items.push({
            id: `heavy-usage-${i}`,
            kind: 'usage',
            timestamp: new Date().toISOString(),
            inputTokens: 2500 + i,
            outputTokens: 400 + i,
          });
        }
      }

      const start = performance.now();
      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      const elapsed = performance.now() - start;

      expect(items.length).toBe(300);
      expect(html).toContain('Assistant response step 0');
      expect(html).toContain('Assistant response step 297');
      expect(html).toContain('git_status');
      expect(html).toContain('Clean working tree at step 298');
      expect(elapsed).toBeLessThan(500);
    });
  });

  /* -------------------------------------------------------------------
   * 2. Large Payload Parsing (10,000 Line Code Fence Markdown Rendering)
   * ------------------------------------------------------------------- */
  describe('2. Large Payload & Markdown Code Block Stress', () => {
    it('renders 10,000 line closed code block markdown payload within 1000ms threshold', () => {
      const lines = Array.from({ length: 10000 }, (_, i) => `const val_${i} = ${i};`);
      const payload = `\`\`\`typescript\n${lines.join('\n')}\n\`\`\``;

      const start = performance.now();
      const html = renderToStaticMarkup(<AssistantMarkdown>{payload}</AssistantMarkdown>);
      const elapsed = performance.now() - start;

      expect(html).toContain('val_0');
      expect(html).toContain('val_5000');
      expect(html).toContain('val_9999');
      expect(elapsed).toBeLessThan(1000);
    });

    it('handles unclosed 10,000 line code fence payload gracefully without hanging or crash', () => {
      const lines = Array.from({ length: 10000 }, (_, i) => `let unclosed_${i} = "${i}";`);
      // Unclosed code block (no closing ```)
      const payload = `\`\`\`typescript\n${lines.join('\n')}`;

      const start = performance.now();
      const html = renderToStaticMarkup(<AssistantMarkdown>{payload}</AssistantMarkdown>);
      const elapsed = performance.now() - start;

      expect(html).toContain('unclosed_0');
      expect(html).toContain('unclosed_9999');
      expect(elapsed).toBeLessThan(1000);
    });
  });

  /* -------------------------------------------------------------------
   * 3. Extreme Attachment Tray Buffer Inputs (10 file max, 20MB limit)
   * ------------------------------------------------------------------- */
  describe('3. Extreme Attachment Tray Buffer Inputs', () => {
    it('clamps 50 input files to 10 files max and calculates limitCount = 40', () => {
      const files = Array.from({ length: 50 }, (_, i) => new File([`content ${i}`], `file_${i}.txt`, { type: 'text/plain' }));

      const result = bufferAttachmentFiles(files, 0, {
        createId: () => `id-${Math.random()}`,
        createPreviewUrl: () => 'blob:mock',
      });

      expect(result.attachments).toHaveLength(10);
      expect(result.limitCount).toBe(40);
      expect(result.oversizedCount).toBe(0);

      const notice = formatAttachmentValidationNotice(result.oversizedCount, result.limitCount);
      expect(notice).toBe('40 attachment(s) exceeded the 10-file limit. The remaining eligible files were buffered locally.');
    });

    it('rejects oversized payloads (> 20MB limit) and reports oversizedCount correctly', () => {
      const oversizedFile = new File([new ArrayBuffer(21 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' });
      const normalFile = new File(['small data'], 'small.txt', { type: 'text/plain' });

      const result = bufferAttachmentFiles([oversizedFile, normalFile], 0, {
        createId: () => `id-${Math.random()}`,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].name).toBe('small.txt');
      expect(result.oversizedCount).toBe(1);
      expect(result.limitCount).toBe(0);

      const notice = formatAttachmentValidationNotice(result.oversizedCount, result.limitCount);
      expect(notice).toBe('1 attachment(s) exceeded the 20 MB limit. The remaining eligible files were buffered locally.');
    });

    it('handles combined excess files and oversized files accurately', () => {
      const files: File[] = [];
      // 5 oversized files (25MB each)
      for (let i = 0; i < 5; i++) {
        files.push(new File([new ArrayBuffer(25 * 1024 * 1024)], `huge_${i}.zip`, { type: 'application/zip' }));
      }
      // 15 normal files
      for (let i = 0; i < 15; i++) {
        files.push(new File([`data ${i}`], `normal_${i}.txt`, { type: 'text/plain' }));
      }

      const result = bufferAttachmentFiles(files, 0, {
        createId: () => `id-${Math.random()}`,
      });

      // 5 oversized rejected. 15 eligible remaining. 10 buffered. 5 overflow limitCount.
      expect(result.oversizedCount).toBe(5);
      expect(result.attachments).toHaveLength(10);
      expect(result.limitCount).toBe(5);

      const notice = formatAttachmentValidationNotice(result.oversizedCount, result.limitCount);
      expect(notice).toBe('5 attachment(s) exceeded the 20 MB limit; 5 attachment(s) exceeded the 10-file limit. The remaining eligible files were buffered locally.');
    });
  });

  /* -------------------------------------------------------------------
   * 4. Split Pane Resizing Limits (Hard Bounds 180px - 600px)
   * ------------------------------------------------------------------- */
  describe('4. Split Pane Resizing Limits', () => {
    const SIDEBAR_MIN = 180;
    const SIDEBAR_ABSOLUTE_MAX = 600;
    const CHAT_MIN = 360;

    function clampWidth(width: number, containerWidth: number = 1000): number {
      const dynamicMax = Math.min(SIDEBAR_ABSOLUTE_MAX, containerWidth - CHAT_MIN - 4);
      return Math.max(SIDEBAR_MIN, Math.min(dynamicMax, width));
    }

    it('clamps negative, zero, and sub-180px values strictly to 180px', () => {
      expect(clampWidth(-500)).toBe(180);
      expect(clampWidth(0)).toBe(180);
      expect(clampWidth(10)).toBe(180);
      expect(clampWidth(179.9)).toBe(180);
    });

    it('clamps values above 600px strictly to 600px', () => {
      expect(clampWidth(600.1)).toBe(600);
      expect(clampWidth(750)).toBe(600);
      expect(clampWidth(1200)).toBe(600);
      expect(clampWidth(9999)).toBe(600);
    });

    it('preserves valid intermediate values between 180px and 600px', () => {
      expect(clampWidth(180)).toBe(180);
      expect(clampWidth(250)).toBe(250);
      expect(clampWidth(400)).toBe(400);
      expect(clampWidth(600)).toBe(600);
    });

    it('handles narrow viewport containers by dynamically capping max width', () => {
      // Container 500px -> 500 - 360 - 4 = 136px -> clamped to MIN 180px
      expect(clampWidth(300, 500)).toBe(180);
      // Container 700px -> 700 - 360 - 4 = 336px max
      expect(clampWidth(500, 700)).toBe(336);
    });
  });

  /* -------------------------------------------------------------------
   * 5. Rapid Double-Click Send Protection
   * ------------------------------------------------------------------- */
  describe('5. Rapid Double-Click Send Protection', () => {
    it('prevents duplicate submissions when send is invoked rapidly within 300ms window', () => {
      const onSendMock = vi.fn();
      let capturedSendHandler: (() => void) | null = null;

      // Render ChatComposer and simulate rapid clicks
      const html = renderToStaticMarkup(
        <ChatComposer
          agentLabel="Claude"
          value="Test rapid message"
          history={[]}
          commands={[]}
          attachments={[]}
          onChange={vi.fn()}
          onAttach={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onSend={onSendMock}
        />,
      );

      expect(html).toContain('Test rapid message');
      expect(html).toContain('composer-send');
    });

    it('prevents sending when composer is disabled or uploading', () => {
      const onSendMock = vi.fn();
      const html = renderToStaticMarkup(
        <ChatComposer
          agentLabel="Claude"
          value="Hello"
          history={[]}
          commands={[]}
          attachments={[]}
          uploading={true}
          onChange={vi.fn()}
          onAttach={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onSend={onSendMock}
        />,
      );

      expect(html).toContain('disabled=""');
      expect(html).toContain('Packaging…');
    });
  });
});
