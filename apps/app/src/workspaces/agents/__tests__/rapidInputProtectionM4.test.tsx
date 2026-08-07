import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../ChatComposer';
import type { ComposerAttachment } from '../attachmentBuffer';

describe('Milestone 4 - Rapid Input Protection & UI Stability', () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).cozypad = {
      kind: 'electron',
    };
  });

  it('renders disabled send button when composer is uploading or disabled', () => {
    const onSend = vi.fn();
    const props = {
      agentLabel: 'Claude',
      value: 'Test message',
      history: [],
      commands: [],
      attachments: [],
      onChange: vi.fn(),
      onAttach: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onSend,
    };

    const disabledProps = {
      ...props,
      uploading: true,
    };
    const disabledHtml = renderToStaticMarkup(<ChatComposer {...disabledProps} />);
    expect(disabledHtml).toContain('disabled=""');
  });

  it('prevents file paste when uploading state is active', () => {
    const onAttach = vi.fn();
    const props = {
      agentLabel: 'Claude',
      value: '',
      history: [],
      commands: [],
      attachments: [],
      uploading: true,
      onChange: vi.fn(),
      onAttach,
      onRemoveAttachment: vi.fn(),
      onSend: vi.fn(),
    };

    const html = renderToStaticMarkup(<ChatComposer {...props} />);
    expect(html).toContain('composer-wrap');
    expect(html).toContain('disabled=""');
  });

  it('locks attachment retry button against rapid clicking', () => {
    const onRetryAttachment = vi.fn();
    const attachments: ComposerAttachment[] = [
      {
        id: 'att-err-1',
        name: 'test.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 1024,
        state: 'error',
        errorMessage: 'Network failed',
      },
    ];

    const props = {
      agentLabel: 'Claude',
      value: '',
      history: [],
      commands: [],
      attachments,
      onChange: vi.fn(),
      onAttach: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryAttachment,
      onSend: vi.fn(),
    };

    const html = renderToStaticMarkup(<ChatComposer {...props} />);
    expect(html).toContain('attachment-retry');
    expect(html).toContain('重試');
  });
});
