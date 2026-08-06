import { useEffect, useMemo, useRef, useState } from 'react';
import { base64ToBytes } from '@cozypad/contracts';
import type { ChatAttachment, PlatformBridge } from '@cozypad/contracts';
import { getBridge } from '../../platform/bridge';

const INLINE_IMAGE_MEDIA_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isInlineAttachmentImage(mediaType: string): boolean {
  return INLINE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

export function attachmentDataUrl(mediaType: string, dataBase64: string): string {
  if (!isInlineAttachmentImage(mediaType)) {
    throw new Error(`Unsupported inline attachment media type: ${mediaType}`);
  }
  return `data:${mediaType.toLowerCase()};base64,${dataBase64}`;
}

// Lives in attachmentBuffer so the composer trays can share it without
// pulling this file's bridge dependency into their graph; re-exported to
// keep existing import paths working.
import { formatAttachmentSize } from './attachmentBuffer';
export { formatAttachmentSize };

export function isTextPreviewAttachment(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/xml' ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'image/svg+xml'
  );
}

function AttachmentImage({
  attachment,
  bridge,
}: {
  attachment: ChatAttachment;
  bridge: PlatformBridge;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setFailed(false);
    void bridge
      .fsReadBytes({ path: attachment.remotePath })
      .then(({ dataBase64 }) => {
        if (!cancelled) setSource(attachmentDataUrl(attachment.mediaType, dataBase64));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.mediaType, attachment.remotePath, bridge]);

  if (source !== null) {
    return <img src={source} alt={attachment.name} loading="lazy" />;
  }
  return (
    <span className="message-attachment-placeholder" aria-hidden="true">
      {failed ? 'IMG?' : 'IMG'}
    </span>
  );
}

function AttachmentPreviewDialog({
  attachment,
  bridge,
  onClose,
}: {
  attachment: ChatAttachment;
  bridge: PlatformBridge;
  onClose(): void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const image = isInlineAttachmentImage(attachment.mediaType);
  const textPreview = isTextPreviewAttachment(attachment.mediaType);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (controls === undefined || controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setText(null);
    setFailed(false);
    if (!image && !textPreview) return () => {
      cancelled = true;
    };
    void bridge
      .fsReadBytes({ path: attachment.remotePath })
      .then(({ dataBase64 }) => {
        if (cancelled) return;
        if (image) {
          setSource(attachmentDataUrl(attachment.mediaType, dataBase64));
          return;
        }
        const bytes = base64ToBytes(dataBase64);
        const previewBytes = bytes.subarray(0, 512 * 1024);
        const decoded = new TextDecoder().decode(previewBytes);
        setText(
          bytes.byteLength > previewBytes.byteLength
            ? `${decoded}\n\n[Preview truncated at 512 KB]`
            : decoded,
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.mediaType, attachment.remotePath, bridge, image, textPreview]);

  return (
    <div className="modal-overlay attachment-preview-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal attachment-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Attachment preview: ${attachment.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head attachment-preview-head">
          <div>
            <h2>{attachment.name}</h2>
            <span>
              {attachment.mediaType} · {formatAttachmentSize(attachment.sizeBytes)}
            </span>
          </div>
          <button
            ref={closeButtonRef}
            className="modal-close"
            aria-label="Close attachment preview"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="attachment-preview-content">
          {failed ? (
            <div className="attachment-preview-empty">Unable to load this attachment.</div>
          ) : image ? (
            source === null ? (
              <div className="attachment-preview-empty">Loading image…</div>
            ) : (
              <img src={source} alt={attachment.name} />
            )
          ) : textPreview ? (
            text === null ? (
              <div className="attachment-preview-empty">Loading file…</div>
            ) : (
              <pre>{text}</pre>
            )
          ) : (
            <div className="attachment-preview-empty">
              <span className="attachment-preview-file-icon">FILE</span>
              <strong>No inline preview for this file type</strong>
              <span>The file remains available in the conversation folder.</span>
            </div>
          )}
        </div>
        <div className="attachment-preview-footer">
          <code title={attachment.remotePath}>{attachment.remotePath}</code>
          <button
            type="button"
            onClick={() => {
              void bridge.writeClipboard(attachment.remotePath).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Persistent attachment presentation for an already-submitted user turn.
 * Metadata is in the timeline; image bytes are fetched lazily from the
 * session-owned path so reopening a conversation restores the same preview.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: ChatAttachment[];
}) {
  const bridge = useMemo(() => getBridge(), []);
  const [selected, setSelected] = useState<ChatAttachment | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="message-attachments" aria-label="Message attachments">
        {attachments.map((attachment) => {
          const image = isInlineAttachmentImage(attachment.mediaType);
          return (
            <button
              type="button"
              className={`message-attachment${image ? ' message-attachment-image' : ''}`}
              key={attachment.id}
              title={`Open ${attachment.name}`}
              aria-haspopup="dialog"
              onClick={() => setSelected(attachment)}
            >
              {image ? (
                <AttachmentImage attachment={attachment} bridge={bridge} />
              ) : (
                <span className="message-attachment-placeholder" aria-hidden="true">
                  FILE
                </span>
              )}
              <span className="message-attachment-meta">
                <strong>{attachment.name}</strong>
                <small>
                  {attachment.mediaType} · {formatAttachmentSize(attachment.sizeBytes)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {selected === null ? null : (
        <AttachmentPreviewDialog
          attachment={selected}
          bridge={bridge}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
