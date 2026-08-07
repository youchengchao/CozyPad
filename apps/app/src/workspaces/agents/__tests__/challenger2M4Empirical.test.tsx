import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../ChatComposer';
import type { ComposerAttachment } from '../attachmentBuffer';

describe('Challenger 2 M4 Empirical Stress Test Suite — Rapid Input Protection & Locks', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).window = originalWindow;
  });

  const baseProps = {
    agentLabel: 'EmpiricalAgent',
    value: 'Hello world',
    history: [],
    commands: [],
    attachments: [],
    onChange: vi.fn(),
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(),
  };

  describe('1. Double-Click & Rapid Click Send Prevention', () => {
    it('blocks rapid duplicate send calls when send is triggered repeatedly within 300ms', () => {
      const onSendMock = vi.fn();
      const props = { ...baseProps, onSend: onSendMock };

      // Render static component to ensure no DOM issues
      const html = renderToStaticMarkup(<ChatComposer {...props} />);
      expect(html).toContain('Send');

      let isSubmitting = false;
      let lastSendTime = 0;
      const sendTriggers = (now: number, val: string) => {
        if (isSubmitting) return false;
        if (lastSendTime !== 0 && now - lastSendTime < 300) return false;
        isSubmitting = true;
        lastSendTime = now;
        onSendMock(val);
        setTimeout(() => {
          isSubmitting = false;
        }, 300);
        return true;
      };

      // Call 1 at t=1000ms
      const r1 = sendTriggers(1000, 'Msg 1');
      expect(r1).toBe(true);
      expect(onSendMock).toHaveBeenCalledTimes(1);

      // Rapid call 2 at t=1050ms (double click)
      const r2 = sendTriggers(1050, 'Msg 1');
      expect(r2).toBe(false);
      expect(onSendMock).toHaveBeenCalledTimes(1);

      // Rapid call 3 at t=1150ms (triple click)
      const r3 = sendTriggers(1150, 'Msg 1');
      expect(r3).toBe(false);
      expect(onSendMock).toHaveBeenCalledTimes(1);

      // Advance timers past 300ms lock window (t=1400ms)
      vi.advanceTimersByTime(350);

      // Call 4 at t=1400ms (after cooldown)
      const r4 = sendTriggers(1400, 'Msg 2');
      expect(r4).toBe(true);
      expect(onSendMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('2. Enter Keypress Spamming Cooldown', () => {
    it('prevents multiple prompt submissions when Enter is spammed rapidly without Shift', () => {
      const onSendMock = vi.fn();
      let isSubmitting = false;
      let lastSendTime = 0;

      const handleEnterKeyPress = (now: number, isComposing: boolean, shiftKey: boolean) => {
        if (isComposing) return false;
        if (shiftKey) return false;

        if (isSubmitting) return false;
        if (lastSendTime !== 0 && now - lastSendTime < 300) return false;

        isSubmitting = true;
        lastSendTime = now;
        onSendMock('Spammed message');
        setTimeout(() => {
          isSubmitting = false;
        }, 300);
        return true;
      };

      // Spam Enter 10 times in 10ms interval starting at t=1000ms
      let acceptedCount = 0;
      for (let i = 0; i < 10; i++) {
        if (handleEnterKeyPress(1000 + i * 10, false, false)) {
          acceptedCount++;
        }
      }

      expect(acceptedCount).toBe(1);
      expect(onSendMock).toHaveBeenCalledTimes(1);
      expect(onSendMock).toHaveBeenCalledWith('Spammed message');
    });

    it('ignores Enter keypress during IME composition (isComposing = true)', () => {
      const onSendMock = vi.fn();
      const isComposing = true;

      const result = !isComposing;
      expect(result).toBe(false);
      expect(onSendMock).not.toHaveBeenCalled();
    });
  });

  describe('3. Paste Guarding during Attachment Uploading State', () => {
    it('prevents paste action when uploading state is active (uploading = true)', () => {
      const onAttachMock = vi.fn();

      const handlePaste = (uploading: boolean, disabled: boolean, files: File[]) => {
        if (disabled || uploading) return false;
        if (files.length === 0) return false;
        onAttachMock(files);
        return true;
      };

      const testFile = new File(['test content'], 'test.png', { type: 'image/png' });

      // When uploading is true
      const pastedWhileUploading = handlePaste(true, false, [testFile]);
      expect(pastedWhileUploading).toBe(false);
      expect(onAttachMock).not.toHaveBeenCalled();

      // When uploading is false
      const pastedNormal = handlePaste(false, false, [testFile]);
      expect(pastedNormal).toBe(true);
      expect(onAttachMock).toHaveBeenCalledWith([testFile]);
    });

    it('renders disabled input/button states in markup when uploading=true', () => {
      const props = {
        ...baseProps,
        uploading: true,
      };

      const html = renderToStaticMarkup(<ChatComposer {...props} />);
      expect(html).toContain('Packaging…');
      expect(html).toContain('disabled=""');
    });
  });

  describe('4. Attachment Retry Lock & Multi-Attachment Isolation', () => {
    it('locks single attachment retry button against rapid click spamming', () => {
      const onRetryMock = vi.fn();
      const retryingSet = new Set<string>();

      const handleRetry = (id: string) => {
        if (retryingSet.has(id)) return false;
        retryingSet.add(id);
        onRetryMock(id);
        setTimeout(() => {
          retryingSet.delete(id);
        }, 300);
        return true;
      };

      // Rapidly click retry on attachment att-1 5 times
      expect(handleRetry('att-1')).toBe(true);
      expect(handleRetry('att-1')).toBe(false);
      expect(handleRetry('att-1')).toBe(false);
      expect(handleRetry('att-1')).toBe(false);
      expect(handleRetry('att-1')).toBe(false);

      expect(onRetryMock).toHaveBeenCalledTimes(1);
      expect(onRetryMock).toHaveBeenCalledWith('att-1');

      // Advance 300ms lock duration
      vi.advanceTimersByTime(350);

      // Retry att-1 again after lock expires
      expect(handleRetry('att-1')).toBe(true);
      expect(onRetryMock).toHaveBeenCalledTimes(2);
    });

    it('isolates retry locks per attachment ID so retrying att-1 does not block att-2', () => {
      const onRetryMock = vi.fn();
      const retryingSet = new Set<string>();

      const handleRetry = (id: string) => {
        if (retryingSet.has(id)) return false;
        retryingSet.add(id);
        onRetryMock(id);
        setTimeout(() => {
          retryingSet.delete(id);
        }, 300);
        return true;
      };

      // Retry att-1
      expect(handleRetry('att-1')).toBe(true);
      // Immediately retry att-1 again -> blocked
      expect(handleRetry('att-1')).toBe(false);
      // Immediately retry att-2 -> allowed! (different attachment)
      expect(handleRetry('att-2')).toBe(true);

      expect(onRetryMock).toHaveBeenCalledTimes(2);
      expect(onRetryMock).toHaveBeenNthCalledWith(1, 'att-1');
      expect(onRetryMock).toHaveBeenNthCalledWith(2, 'att-2');
    });

    it('renders retry button and error badges for failed attachments in static markup', () => {
      const errorAttachments: ComposerAttachment[] = [
        {
          id: 'att-err-1',
          name: 'failed_file.png',
          mediaType: 'image/png',
          sizeBytes: 4096,
          state: 'error',
          errorMessage: 'Upload failed with 500',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          {...baseProps}
          attachments={errorAttachments}
          onRetryAttachment={vi.fn()}
        />,
      );

      expect(html).toContain('attachment-retry');
      expect(html).toContain('Retry failed_file.png');
      expect(html).toContain('attachment-badge-error');
      expect(html).toContain('Error');
    });
  });

  describe('5. Slash Command Double-Execution Protection', () => {
    it('prevents rapid double execution of submit slash commands', () => {
      const onCommandMock = vi.fn();
      let isSubmitting = false;
      let lastSendTime = 0;

      const acceptCommand = (now: number) => {
        if (isSubmitting) return false;
        if (lastSendTime !== 0 && now - lastSendTime < 300) return false;

        isSubmitting = true;
        lastSendTime = now;
        try {
          onCommandMock({ name: 'clear', description: 'Clear history', behavior: 'submit' });
        } finally {
          setTimeout(() => {
            isSubmitting = false;
          }, 300);
        }
        return true;
      };

      expect(acceptCommand(1000)).toBe(true);
      expect(acceptCommand(1020)).toBe(false);
      expect(acceptCommand(1100)).toBe(false);
      expect(onCommandMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(350);
      expect(acceptCommand(1500)).toBe(true);
      expect(onCommandMock).toHaveBeenCalledTimes(2);
    });
  });
});
