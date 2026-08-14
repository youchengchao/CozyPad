import { describe, expect, it } from 'vitest';
import {
  AgentSessionDeletedEventSchema,
  AgentSessionListRequestSchema,
  ArchiveAgentSessionRequestSchema,
  ChatItemSchema,
  CreateAgentSessionRequestSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  SendAgentMessageRequestSchema,
  UploadAgentAttachmentsRequestSchema,
  TerminalOpenRequestSchema,
} from '../src';

describe('agent communication attachment contracts', () => {
  it('queries active, archived, or all sessions within an optional project', () => {
    expect(
      AgentSessionListRequestSchema.parse({
        profileId: 'profile-1',
        projectId: '/srv/project',
        archive: 'archived',
      }),
    ).toEqual({
      profileId: 'profile-1',
      projectId: '/srv/project',
      archive: 'archived',
    });
    expect(
      AgentSessionListRequestSchema.parse({ profileId: 'legacy-profile' }),
    ).toEqual({ profileId: 'legacy-profile' });
  });

  it('requires an explicit terminal cwd and supports stop-and-archive', () => {
    expect(
      TerminalOpenRequestSchema.parse({
        profileId: 'profile-1',
        cwd: '/srv/project',
        cols: 100,
        rows: 30,
      }).cwd,
    ).toBe('/srv/project');
    expect(() =>
      TerminalOpenRequestSchema.parse({
        profileId: 'profile-1',
        cols: 100,
        rows: 30,
      }),
    ).toThrow();
    expect(
      ArchiveAgentSessionRequestSchema.parse({
        sessionId: 'session-1',
        stopActive: true,
      }),
    ).toMatchObject({ stopActive: true });
  });

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

  it('accepts a create request without any interaction mode — every session is chat', () => {
    // The terminal mode and its open-terminal request left with the
    // screen-scraping path; a request that still carries the old field is
    // tolerated (unknown keys strip) but nothing reads it.
    expect(
      CreateAgentSessionRequestSchema.parse({
        profileId: 'profile-1',
        agentKind: 'agy',
        cwd: '/srv/project',
        interactionMode: 'terminal',
      }),
    ).not.toHaveProperty('interactionMode');
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
