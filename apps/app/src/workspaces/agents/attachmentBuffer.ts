import {
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  base64ToBytes,
} from '@cozypad/contracts';
import type { AgentAttachment } from '@cozypad/contracts';

/** SPEC 1401-1408: the six states a tray item moves through. */
export type ComposerAttachmentState =
  | 'buffered'
  | 'packaging'
  | 'transferring'
  | 'verifying'
  | 'ready'
  | 'error';

export interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  state: ComposerAttachmentState;
  errorMessage?: string;
  previewUrl?: string;
  /** Present only while the attachment is buffered in this renderer. */
  file?: File;
  /** Present once the attachment has landed on the host (state 'ready'). */
  remotePath?: string;
}

/** One human-readable size for every tray and card (SPEC 1404: Size). */
export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.ceil(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface BufferAttachmentFilesResult {
  attachments: ComposerAttachment[];
  oversizedCount: number;
  limitCount: number;
}

interface BufferAttachmentFilesOptions {
  createId?(): string;
  createPreviewUrl?(file: File): string;
  now?: number;
}

function imageExtension(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase() ?? '';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return /^[a-z0-9]+$/u.test(subtype) ? subtype : 'png';
}

export function bufferAttachmentFiles(
  files: File[],
  currentCount: number,
  options: BufferAttachmentFilesOptions = {},
): BufferAttachmentFilesResult {
  const available = Math.max(0, MAX_AGENT_ATTACHMENTS - currentCount);
  const oversizedCount = files.filter(
    (file) => file.size > MAX_AGENT_ATTACHMENT_BYTES,
  ).length;
  const eligible = files.filter(
    (file) => file.size <= MAX_AGENT_ATTACHMENT_BYTES,
  );
  const selected = eligible.slice(0, available);
  const timestamp = options.now ?? Date.now();
  const createId = options.createId ?? (() => crypto.randomUUID());
  const createPreviewUrl =
    options.createPreviewUrl ?? ((file: File) => URL.createObjectURL(file));
  return {
    attachments: selected.map((file, index) => {
      const mediaType = file.type || 'application/octet-stream';
      const fallbackName = mediaType.startsWith('image/')
        ? `pasted-image-${timestamp}-${index + 1}.${imageExtension(mediaType)}`
        : `attachment-${timestamp}-${index + 1}.bin`;
      const previewUrl = mediaType.startsWith('image/')
        ? createPreviewUrl(file)
        : undefined;
      return {
        id: createId(),
        name: file.name.trim() || fallbackName,
        mediaType,
        sizeBytes: file.size,
        state: 'buffered' as const,
        file,
        ...(previewUrl === undefined ? {} : { previewUrl }),
      };
    }),
    oversizedCount,
    limitCount: Math.max(0, eligible.length - selected.length),
  };
}

export function clipboardAttachmentFiles(
  items: Iterable<Pick<DataTransferItem, 'kind' | 'getAsFile'>>,
  files: Iterable<File> = [],
): File[] {
  const itemFiles = [...items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return itemFiles.length > 0 ? itemFiles : [...files];
}

export async function attachmentFileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return browserBytesToBase64(bytes);
}

function browserBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function writeTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = Math.max(0, value).toString(8).padStart(length - 1, '0');
  const encoded = new TextEncoder().encode(octal.slice(-(length - 1)));
  header.set(encoded, offset);
  header[offset + length - 1] = 0;
}

function agyMediaArchiveName(index: number, mediaType: string): string {
  return `cozypad-media-${index + 1}.${imageExtension(mediaType)}`;
}

/**
 * Build the tgz payload requested by AGY over iTerm2's RequestUpload protocol.
 * All media leaves the renderer as one buffered batch, including over SSH.
 */
export async function createAgyMediaUploadArchive(
  attachments: Array<
    Pick<ComposerAttachment, 'mediaType' | 'file'> & { dataBase64?: string }
  >,
): Promise<string> {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const timestamp = Math.floor(Date.now() / 1000);
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    // A retry after a failed paste no longer holds the File — the upload
    // already succeeded and the encoded bytes were cached (SPEC 315).
    const data =
      attachment.file !== undefined
        ? new Uint8Array(await attachment.file.arrayBuffer())
        : attachment.dataBase64 !== undefined
          ? base64ToBytes(attachment.dataBase64)
          : undefined;
    if (data === undefined) {
      throw new Error('AGY media upload needs the buffered attachment bytes');
    }
    const name = agyMediaArchiveName(index, attachment.mediaType);
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.byteLength);
    writeTarOctal(header, 136, 12, timestamp);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    header.set(encoder.encode('cozypad'), 265);
    header.set(encoder.encode('cozypad'), 297);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0').slice(-6);
    header.set(encoder.encode(checksumText), 148);
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  const size = blocks.reduce((total, block) => total + block.byteLength, 0);
  const tar = new Uint8Array(size);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  const compressed = await new Response(
    new Blob([tar.buffer]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  return browserBytesToBase64(new Uint8Array(compressed));
}

/**
 * Non-media files stay available through their session-local paths. Do not
 * prefix them with `@`: AGY interprets that syntax as a native media object,
 * and a path-only image becomes a permanently invalid media history item.
 */
export function promptWithAttachmentReferences(
  prompt: string,
  attachments: Pick<
    AgentAttachment,
    'name' | 'mediaType' | 'sizeBytes' | 'remotePath'
  >[],
): string {
  if (attachments.length === 0) return prompt.trim();
  const attachmentText = [
    'The user attached these non-media files. Inspect each file at its exact session-local path before responding when its contents are relevant.',
    ...attachments.map(
      (attachment) =>
        `- ${attachment.remotePath} (original name: ${attachment.name}; ${attachment.mediaType}; ${attachment.sizeBytes} bytes)`,
    ),
  ].join('\n');
  return [prompt.trim(), attachmentText].filter(Boolean).join('\n\n');
}
