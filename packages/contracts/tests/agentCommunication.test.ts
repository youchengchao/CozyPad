import { describe, expect, it } from 'vitest';
import {
  AgentTerminalOpenRequestSchema,
  AgentSessionDeletedEventSchema,
  CreateAgentSessionRequestSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  SendAgentMessageRequestSchema,
  UploadAgentAttachmentRequestSchema,
} from '../src';

describe('agent communication attachment contracts', () => {
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
      UploadAgentAttachmentRequestSchema.parse({
        sessionId: 'session-1',
        name: 'image.png',
        mediaType: 'image/png',
        dataBase64: 'not base64!',
      }),
    ).toThrow();
  });

  it('rejects payloads larger than the declared attachment limit', () => {
    const oversizedBase64 = 'A'.repeat(
      Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4 + 8,
    );
    expect(() =>
      UploadAgentAttachmentRequestSchema.parse({
        sessionId: 'session-1',
        name: 'large.bin',
        dataBase64: oversizedBase64,
      }),
    ).toThrow();
  });
});
