import { describe, expect, it } from 'vitest';
import {
  AgentTerminalOpenRequestSchema,
  AgentSessionDeletedEventSchema,
  ChatItemSchema,
  CreateAgentSessionRequestSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  SendAgentMessageRequestSchema,
  UploadAgentAttachmentsRequestSchema,
} from '../src';

describe('agent communication attachment contracts', () => {
  it('persists attachment metadata with a user timeline message', () => {
    expect(
      ChatItemSchema.parse({
        id: 'message-1',
        kind: 'message',
        role: 'user',
        text: 'Inspect this screenshot',
        timestamp: '2026-08-05T00:00:00.000Z',
        attachments: [
          {
            id: '8b4c369f-d2dd-4d2c-8120-f84819a94855',
            name: 'screenshot.png',
            mediaType: 'image/png',
            sizeBytes: 68,
            remotePath: '/work/.cozypad/session-tmp/session-1/attachments/screenshot.png',
          },
        ],
      }),
    ).toMatchObject({
      attachments: [{ name: 'screenshot.png', mediaType: 'image/png' }],
    });
  });

  it('keeps old timeline messages compatible without attachment metadata', () => {
    expect(
      ChatItemSchema.parse({
        id: 'message-1',
        kind: 'message',
        role: 'assistant',
        text: 'Hello',
        timestamp: '2026-08-05T00:00:00.000Z',
      }),
    ).not.toHaveProperty('attachments');
  });

  it('distinguishes structured chat from native AGY terminal sessions', () => {
    expect(
      CreateAgentSessionRequestSchema.parse({
        profileId: 'profile-1',
        agentKind: 'agy',
        cwd: '/srv/project',
        interactionMode: 'terminal',
      }).interactionMode,
    ).toBe('terminal');
    expect(
      AgentTerminalOpenRequestSchema.parse({
        sessionId: 'session-1',
        cols: 120,
        rows: 36,
      }),
    ).toEqual({ sessionId: 'session-1', cols: 120, rows: 36 });
  });

  it('identifies the agent whose session was deleted', () => {
    expect(
      AgentSessionDeletedEventSchema.parse({
        sessionId: 'session-1',
        agentKind: 'agy',
      }),
    ).toEqual({ sessionId: 'session-1', agentKind: 'agy' });
  });

  it('allows attachment-only messages and defaults text messages to no attachments', () => {
    expect(
      SendAgentMessageRequestSchema.parse({
        sessionId: 'session-1',
        text: '',
        attachmentIds: ['8b4c369f-d2dd-4d2c-8120-f84819a94855'],
      }),
    ).toMatchObject({ text: '', attachmentIds: expect.any(Array) });
    expect(
      SendAgentMessageRequestSchema.parse({
        sessionId: 'session-1',
        text: 'hello',
      }).attachmentIds,
    ).toEqual([]);
  });

  it('rejects an empty message and malformed attachment data', () => {
    expect(() =>
      SendAgentMessageRequestSchema.parse({ sessionId: 'session-1', text: '' }),
    ).toThrow();
    expect(() =>
      UploadAgentAttachmentsRequestSchema.parse({
        sessionId: 'session-1',
        attachments: [
          {
            name: 'image.png',
            mediaType: 'image/png',
            dataBase64: 'not base64!',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects payloads larger than the declared attachment limit', () => {
    const oversizedBase64 = 'A'.repeat(
      Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4 + 8,
    );
    expect(() =>
      UploadAgentAttachmentsRequestSchema.parse({
        sessionId: 'session-1',
        attachments: [{ name: 'large.bin', dataBase64: oversizedBase64 }],
      }),
    ).toThrow();
  });

  it('accepts one buffered batch and caps it at ten attachments', () => {
    const attachment = {
      name: 'notes.txt',
      mediaType: 'text/plain',
      dataBase64: 'bm90ZXM=',
    };
    expect(
      UploadAgentAttachmentsRequestSchema.parse({
        sessionId: 'session-1',
        attachments: [attachment, attachment],
      }).attachments,
    ).toHaveLength(2);
    expect(() =>
      UploadAgentAttachmentsRequestSchema.parse({
        sessionId: 'session-1',
        attachments: Array.from(
          { length: MAX_AGENT_ATTACHMENTS + 1 },
          () => attachment,
        ),
      }),
    ).toThrow();
  });
});
