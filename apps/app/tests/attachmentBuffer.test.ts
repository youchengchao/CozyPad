import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { MAX_AGENT_ATTACHMENT_BYTES } from '@cozypad/contracts';
import {
  attachmentFileToBase64,
  bufferAttachmentFiles,
  clipboardAttachmentFiles,
  createAgyMediaUploadArchive,
  promptWithAttachmentReferences,
} from '../src/workspaces/agents/attachmentBuffer';

function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

describe('agent attachment buffer', () => {
  it('turns a pasted nameless image into a locally previewable attachment', () => {
    const image = fakeFile('', 'image/jpeg', 2048);
    const result = bufferAttachmentFiles([image], 0, {
      now: 1234,
      createId: () => 'local-id',
      createPreviewUrl: () => 'blob:preview',
    });

    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: 'local-id',
        name: 'pasted-image-1234-1.jpg',
        mediaType: 'image/jpeg',
        previewUrl: 'blob:preview',
        file: image,
        // SPEC 1401-1408: every tray item starts in the Buffered state and
        // moves through the explicit lifecycle from there.
        state: 'buffered',
      }),
    ]);
  });

  it('collects only file clipboard items and ignores empty clipboard entries', () => {
    const image = fakeFile('shot.png', 'image/png', 128);
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image },
      { kind: 'file', getAsFile: () => null },
    ];

    expect(clipboardAttachmentFiles(items)).toEqual([image]);
  });

  it('falls back to the clipboard file list when item conversion is unavailable', () => {
    const image = fakeFile('clipboard.png', 'image/png', 128);
    expect(
      clipboardAttachmentFiles(
        [{ kind: 'file', getAsFile: () => null }],
        [image],
      ),
    ).toEqual([image]);
  });

  it('keeps valid files while reporting size and count rejections', () => {
    const valid = fakeFile('notes.txt', 'text/plain', 64);
    const oversized = fakeFile(
      'huge.bin',
      'application/octet-stream',
      MAX_AGENT_ATTACHMENT_BYTES + 1,
    );
    const result = bufferAttachmentFiles([valid, valid, oversized], 9, {
      createId: () => 'local-id',
      now: 1,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.oversizedCount).toBe(1);
    expect(result.limitCount).toBe(1);
  });

  it('encodes buffered bytes without overflowing a single string conversion', async () => {
    const file = {
      arrayBuffer: () => Promise.resolve(Uint8Array.from([0, 1, 2, 253]).buffer),
    } as File;

    await expect(attachmentFileToBase64(file)).resolves.toBe('AAEC/Q==');
  });

  it('adds uploaded session paths to a native agent prompt', () => {
    expect(
      promptWithAttachmentReferences('請看截圖', [
        {
          name: 'notes.txt',
          mediaType: 'text/plain',
          sizeBytes: 2048,
          remotePath: '/tmp/conversation/notes.txt',
        },
      ]),
    ).toContain('/tmp/conversation/notes.txt');
  });

  it('does not turn a session path into an AGY path-only media object', () => {
    const prompt = promptWithAttachmentReferences('inspect it', [
      {
        name: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 4,
        remotePath: '/tmp/conversation/notes.txt',
      },
    ]);
    expect(prompt).not.toContain('@/tmp/conversation/notes.txt');
  });

  it('packages buffered AGY media as one valid tgz upload', async () => {
    const file = {
      arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3, 4]).buffer),
    } as File;
    const archiveBase64 = await createAgyMediaUploadArchive([
      { mediaType: 'image/png', file },
    ]);
    const tar = gunzipSync(Buffer.from(archiveBase64, 'base64'));

    expect(tar.subarray(0, 100).toString('utf8')).toContain(
      'cozypad-media-1.png',
    );
    expect([...tar.subarray(512, 516)]).toEqual([1, 2, 3, 4]);
  });
});
