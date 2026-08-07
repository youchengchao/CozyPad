import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '@cozypad/contracts';
import { AssistantMarkdown } from '../AssistantMarkdown';
import { ChatTimeline } from '../ChatTimeline';
import { bufferAttachmentFiles, promptWithAttachmentReferences } from '../attachmentBuffer';
import { navigatePromptHistory } from '../ChatComposer';

describe('Real-World & Stress Performance Scenarios Suite', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
      },
    };
  });

  const dummyProps = {
    sessionId: 'stress-session-1',
    onResolveApproval: vi.fn(),
    onAnswerQuestion: vi.fn(),
  };

  describe('100+ Message Timeline Rendering Benchmark', () => {
    it('renders 100+ mixed timeline items smoothly under 1000ms', () => {
      const items: ChatItem[] = [];

      for (let i = 0; i < 100; i++) {
        if (i % 5 === 0) {
          items.push({
            id: `msg-user-${i}`,
            kind: 'message',
            timestamp: '2026-08-07T00:00:00.000Z',
            role: 'user',
            text: `User query ${i}: how to implement feature ${i}?`,
          });
        } else if (i % 5 === 1) {
          items.push({
            id: `msg-ast-${i}`,
            kind: 'message',
            timestamp: '2026-08-07T00:00:00.000Z',
            role: 'assistant',
            text: `Here is the explanation for step **${i}**:\n\n\`\`\`typescript\nconst value_${i} = ${i};\n\`\`\``,
          });
        } else if (i % 5 === 2) {
          items.push({
            id: `tool-${i}`,
            kind: 'tool_call',
            timestamp: '2026-08-07T00:00:00.000Z',
            name: 'bash',
            summary: `pnpm run test:${i}`,
            status: i % 10 === 2 ? 'error' : 'completed',
            durationMs: i * 10,
            output: `Test run ${i} completed output`,
          });
        } else if (i % 5 === 3) {
          items.push({
            id: `diff-${i}`,
            kind: 'file_diff',
            timestamp: '2026-08-07T00:00:00.000Z',
            path: `src/components/Component${i}.tsx`,
            additions: i + 1,
            deletions: i,
            diff: `@@ -1,3 +1,3 @@\n-const v = ${i};\n+const v = ${i + 1};`,
          });
        } else {
          items.push({
            id: `usage-${i}`,
            kind: 'usage',
            timestamp: '2026-08-07T00:00:00.000Z',
            inputTokens: 1000 + i,
            outputTokens: 200 + i,
          });
        }
      }

      const start = performance.now();
      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      const duration = performance.now() - start;

      expect(html).toContain('User query 0:');
      expect(html).toContain('User query 95:');
      expect(html).toContain('Component98.tsx');

      // Verify rendering performance benchmark
      // Blowup guard, not a benchmark. These renders take 100-200ms alone; the
      // number below is not a speed target. What it catches is an algorithmic
      // regression — an O(n^2) markdown path on a 10k-line payload takes tens of
      // seconds, not milliseconds — so it is set where a real regression is
      // unmissable and scheduler noise cannot reach. The previous 300/500/1000ms
      // thresholds were reachable by noise: this suite runs 40 files in parallel,
      // and one of them failed at >1000ms while passing at 155-176ms alone.
      expect(duration).toBeLessThan(5_000);
    });

    it('renders 300+ items without layout crash', () => {
      const items: ChatItem[] = Array.from({ length: 300 }, (_, i) => ({
        id: `item-${i}`,
        kind: 'message',
        timestamp: '2026-08-07T00:00:00.000Z',
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `Stress test item ${i}`,
      }));

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('Stress test item 0');
      expect(html).toContain('Stress test item 299');
    });
  });

  describe('Massive Code Block & Payload Rendering', () => {
    it('renders a 5,000 line code block without memory issues or crashing', () => {
      const codeLines = Array.from({ length: 5000 }, (_, i) => `const var_${i} = ${i};`).join('\n');
      const markdownSource = `Here is a huge generated code file:\n\n\`\`\`typescript\n${codeLines}\n\`\`\``;

      const start = performance.now();
      const html = renderToStaticMarkup(
        <AssistantMarkdown>{markdownSource}</AssistantMarkdown>,
      );
      const duration = performance.now() - start;

      expect(html).toContain('Here is a huge generated code file:');
      expect(html).toContain('var_0 =');
      expect(html).toContain('var_4999 =');
      expect(duration).toBeLessThan(5_000);
    });
  });

  describe('Multi-Attachment & Buffer Heavy Load Stress', () => {
    it('buffers attachments and clamps to MAX_AGENT_ATTACHMENTS limit', () => {
      const files: File[] = Array.from({ length: 15 }, (_, i) => {
        return new File([`content ${i}`], `file_${i}.txt`, { type: 'text/plain' });
      });

      // Buffer with current count 0
      const result = bufferAttachmentFiles(files, 0, {
        createId: () => `id-${Math.random()}`,
        createPreviewUrl: () => 'blob:mock',
      });

      // Max attachments limit is 10 (MAX_AGENT_ATTACHMENTS)
      expect(result.attachments.length).toBeLessThanOrEqual(10);
      expect(result.limitCount).toBe(5);
    });

    it('formats prompt text with 20 non-media attachment references cleanly', () => {
      const prompt = 'Please review these log files';
      const attachments = Array.from({ length: 20 }, (_, i) => ({
        name: `log_${i}.txt`,
        mediaType: 'text/plain',
        sizeBytes: 1024 * (i + 1),
        remotePath: `/tmp/session/attachments/log_${i}.txt`,
      }));

      const formatted = promptWithAttachmentReferences(prompt, attachments);
      expect(formatted).toContain('Please review these log files');
      expect(formatted).toContain('The user attached these non-media files');
      expect(formatted).toContain('/tmp/session/attachments/log_0.txt');
      expect(formatted).toContain('/tmp/session/attachments/log_19.txt');
    });
  });

  describe('History Stack High Capacity Stress', () => {
    it('navigates through a 1,000 prompt history stack efficiently', () => {
      const hugeHistory = Array.from({ length: 1000 }, (_, i) => `Historic prompt #${i}`);

      let cur: { index: number | null; value: string } | null = null;

      // Navigate back 100 times
      for (let step = 0; step < 100; step++) {
        cur = navigatePromptHistory(
          hugeHistory,
          cur?.index ?? null,
          'draft',
          'previous',
        );
        expect(cur).not.toBeNull();
      }

      expect(cur?.index).toBe(900);
      expect(cur?.value).toBe('Historic prompt #900');
    });
  });
});
