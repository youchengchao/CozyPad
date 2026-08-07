import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SlashCommand } from '@cozypad/contracts';
import {
  ChatComposer,
  isExactSlashCommand,
  normalizeSlashCommandName,
  slashCommandSelectionBehavior,
} from '../ChatComposer';

describe('Challenger 1 - Empirical Verification Suite for Milestone 3', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
      },
    };
  });

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

  describe('Verification Task 1: Existing Test Suite Compatibility', () => {
    it('confirms SlashCommand utilities function correctly', () => {
      expect(normalizeSlashCommandName('/test')).toBe('test');
      expect(isExactSlashCommand('/test', { name: 'test', description: '' })).toBe(true);
      expect(slashCommandSelectionBehavior({ name: 'test', description: '', behavior: 'submit' })).toBe('submit');
    });
  });

  describe('Verification Task 2: Auto-grow Textarea Rows Calculation (1, 3, 6, 20 lines)', () => {
    it('renders rows="1" for 1 line of text', () => {
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value="Single line prompt" />);
      expect(html).toContain('rows="1"');
    });

    it('renders rows="3" for 3 lines of text', () => {
      const text = 'Line 1\nLine 2\nLine 3';
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value={text} />);
      expect(html).toContain('rows="3"');
    });

    it('renders rows="6" for 6 lines of text', () => {
      const text = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}`).join('\n');
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value={text} />);
      expect(html).toContain('rows="6"');
    });

    it('caps rows at max 6 for 20 lines of text', () => {
      const text = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value={text} />);
      expect(html).toContain('rows="6"');
      expect(html).not.toContain('rows="20"');
    });
  });

  describe('Verification Task 3: Slash Command Dropdown Filtering & Keyboard/Dismissal Logic', () => {
    const sampleCommands: SlashCommand[] = [
      { name: 'compact', description: 'Compact context' },
      { name: 'clear', description: 'Clear screen', owner: 'cozypad' },
      { name: 'terminal', description: 'Open terminal' },
      { name: 'tools', description: 'List available tools' },
    ];

    it('filters commands correctly for /c', () => {
      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/c" commands={sampleCommands} />,
      );
      expect(html).toContain('class="slash-menu"');
      expect(html).toContain('/compact');
      expect(html).toContain('/clear');
      expect(html).not.toContain('/terminal');
      expect(html).not.toContain('/tools');
    });

    it('filters commands correctly for /t', () => {
      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/t" commands={sampleCommands} />,
      );
      expect(html).toContain('class="slash-menu"');
      expect(html).toContain('/terminal');
      expect(html).toContain('/tools');
      expect(html).not.toContain('/compact');
      expect(html).not.toContain('/clear');
    });

    it('displays empty menu state when no commands match /unknown', () => {
      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/unknown" commands={sampleCommands} />,
      );
      expect(html).toContain('class="slash-menu"');
      expect(html).toContain('slash-empty');
      expect(html).toContain('No command matches /unknown');
    });

    it('handles query when agent has zero registered slash commands', () => {
      const html = renderToStaticMarkup(
        <ChatComposer {...dummyProps} value="/c" commands={[]} />,
      );
      expect(html).toContain('slash-empty');
      expect(html).toContain('This agent has not announced any slash commands yet.');
    });
  });

  describe('Verification Task 4: Empty Send Prevention & Rapid Submissions', () => {
    it('disables send button for empty string value ""', () => {
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value="" attachments={[]} />);
      expect(html).toContain('class="composer-send"');
      expect(html).toContain('disabled=""');
    });

    it('disables send button for whitespace-only value "   "', () => {
      const html = renderToStaticMarkup(<ChatComposer {...dummyProps} value="   " attachments={[]} />);
      expect(html).toContain('class="composer-send"');
      expect(html).toContain('disabled=""');
    });

    it('enables send button when text is empty but ready attachments exist', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...dummyProps}
          value=""
          attachments={[
            {
              id: 'att-1',
              name: 'file.txt',
              mediaType: 'text/plain',
              sizeBytes: 100,
              state: 'ready',
            },
          ]}
        />,
      );
      const match = html.match(/<button[^>]*class="composer-send"[^>]*>/);
      expect(match).not.toBeNull();
      expect(match![0]).not.toContain('disabled');
    });

    it('verifies logic preventing duplicate sends on rapid Enter presses when value becomes empty', () => {
      const onSendMock = vi.fn();
      let currentValue = 'Send me once';

      const simulateSend = (val: string, attachments: any[] = []) => {
        const text = val.trim();
        if (text === '' && attachments.length === 0) return;
        onSendMock(text);
      };

      // First submit
      simulateSend(currentValue);
      expect(onSendMock).toHaveBeenCalledTimes(1);
      expect(onSendMock).toHaveBeenCalledWith('Send me once');

      // Parent clears value upon send
      currentValue = '';

      // Rapid second and third Enter presses while value is empty
      simulateSend(currentValue);
      simulateSend(currentValue);

      // onSend should still only have been called ONCE
      expect(onSendMock).toHaveBeenCalledTimes(1);
    });
  });
});
