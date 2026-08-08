import { useEffect, useRef, useState } from 'react';
import { MAX_AGENT_ATTACHMENTS } from '@cozypad/contracts';
import type { SlashCommand } from '@cozypad/contracts';
import { clipboardAttachmentFiles, formatAttachmentSize, getAttachmentFileTypeBadge } from './attachmentBuffer';
import type { ComposerAttachment } from './attachmentBuffer';
export type { ComposerAttachment } from './attachmentBuffer';

interface ChatComposerProps {
  agentLabel: string;
  value: string;
  history: string[];
  commands: SlashCommand[];
  attachments: ComposerAttachment[];
  uploading?: boolean;
  disabled?: boolean;
  /** SPEC 1362-1364: why the composer is unavailable, and what to do next. */
  disabledReason?: { text: string; nextStep?: string };
  /** Optional banner message for attachment validation (e.g. limit or size exceeded). */
  attachmentNotice?: string;
  running?: boolean;
  stopping?: boolean;
  onChange(value: string): void;
  onAttach(files: File[]): void;
  onRemoveAttachment(id: string): void;
  /** SPEC 1415: retry one failed attachment without touching the rest. */
  onRetryAttachment?(id: string): void;
  onStop?(): void;
  onSend(text: string): void;
}

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '');
}

export function isExactSlashCommand(value: string, command: SlashCommand): boolean {
  return (
    value.trim().toLowerCase() ===
    `/${normalizeSlashCommandName(command.name).toLowerCase()}`
  );
}

export const ATTACHMENT_STATE_LABEL: Record<ComposerAttachment['state'], string> = {
  buffered: 'Buffered',
  uploading: 'Uploading',
  packaging: 'Packaging',
  transferring: 'Transferring',
  verifying: 'Verifying',
  ready: 'Ready',
  error: 'Error',
};

export interface PromptHistoryResult {
  index: number | null;
  value: string;
}

export function navigatePromptHistory(
  history: string[],
  index: number | null,
  draft: string,
  direction: 'previous' | 'next',
): PromptHistoryResult | null {
  if (history.length === 0) return null;
  if (direction === 'previous') {
    const nextIndex = index === null ? history.length - 1 : Math.max(0, index - 1);
    return { index: nextIndex, value: history[nextIndex]! };
  }
  if (index === null) return null;
  const nextIndex = index + 1;
  return nextIndex >= history.length
    ? { index: null, value: draft }
    : { index: nextIndex, value: history[nextIndex]! };
}

export function caretIsOnHistoryEdge(
  textarea: HTMLTextAreaElement,
  direction: 'previous' | 'next',
): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  if (direction === 'previous') {
    return !textarea.value.slice(0, textarea.selectionStart).includes('\n');
  }
  return !textarea.value.slice(textarea.selectionEnd).includes('\n');
}

export function ChatComposer({
  agentLabel,
  value,
  history,
  commands,
  attachments,
  uploading = false,
  disabled = false,
  disabledReason,
  attachmentNotice,
  running = false,
  stopping = false,
  onChange,
  onAttach,
  onRemoveAttachment,
  onRetryAttachment,
  onStop,
  onSend,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeSlashItemRef = useRef<HTMLButtonElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef('');
  const isSubmittingRef = useRef(false);
  const lastSendTimeRef = useRef(0);
  const retryingAttachmentRef = useRef<Set<string>>(new Set());

  const slashQuery =
    value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1).toLowerCase()
      : null;
  const matches =
    slashQuery !== null && !slashDismissed
      ? commands.filter((command) =>
          normalizeSlashCommandName(command.name).toLowerCase().startsWith(slashQuery),
        )
      : [];
  const menuOpen = slashQuery !== null && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setSlashIndex((index) =>
      matches.length === 0 ? 0 : Math.min(index, matches.length - 1),
    );
  }, [matches.length]);

  useEffect(() => {
    activeSlashItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex]);

  useEffect(() => {
    if (slashQuery === null) setSlashDismissed(false);
  }, [slashQuery]);

  const handleRetryAttachment = (id: string) => {
    if (retryingAttachmentRef.current.has(id)) return;
    retryingAttachmentRef.current.add(id);
    onRetryAttachment?.(id);
    window.setTimeout(() => {
      retryingAttachmentRef.current.delete(id);
    }, 300);
  };

  const accept = (command: SlashCommand) => {
    if (disabled || uploading || isSubmittingRef.current) return;
    if (Date.now() - lastSendTimeRef.current < 300) return;
    // Selection inserts the command into the draft; sending stays an explicit
    // second step, whatever the command.
    onChange(`/${normalizeSlashCommandName(command.name)}`);
    textareaRef.current?.focus();
  };

  const resetHistoryNavigation = () => {
    setHistoryIndex(null);
    historyDraftRef.current = '';
  };

  const moveThroughHistory = (direction: 'previous' | 'next') => {
    if (direction === 'previous' && historyIndex === null) {
      historyDraftRef.current = value;
    }
    const result = navigatePromptHistory(
      history,
      historyIndex,
      historyDraftRef.current,
      direction,
    );
    if (result === null) return false;
    setHistoryIndex(result.index);
    onChange(result.value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      const caret = textarea.value.length;
      textarea.setSelectionRange(caret, caret);
    });
    return true;
  };

  const send = () => {
    const now = Date.now();
    if (disabled || uploading || isSubmittingRef.current) return;
    if (now - lastSendTimeRef.current < 300) return;

    const text = value.trim();
    if (text === '' && attachments.length === 0) return;

    isSubmittingRef.current = true;
    lastSendTimeRef.current = now;
    resetHistoryNavigation();

    try {
      onSend(text);
    } finally {
      window.setTimeout(() => {
        isSubmittingRef.current = false;
      }, 300);
    }
    textareaRef.current?.focus();
  };

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <div className="slash-menu" role="listbox" aria-label="Slash commands">
          <div className="slash-menu-title">
            <span>Slash commands</span>
            <span>{matches.length}</span>
          </div>
          <div className="slash-menu-items">
            {matches.length === 0 ? (
              <div className="slash-empty">
                {commands.length === 0
                  ? 'This agent has not announced any slash commands yet.'
                  : `No command matches /${slashQuery}`}
              </div>
            ) : (
              matches.map((command, index) => (
                <button
                  key={command.name}
                  ref={index === slashIndex ? activeSlashItemRef : undefined}
                  role="option"
                  aria-selected={index === slashIndex}
                  className={`slash-item${index === slashIndex ? ' slash-item-active' : ''}`}
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => accept(command)}
                >
                  <span className="slash-terminal">›_</span>
                  <span className="slash-name">
                    /{normalizeSlashCommandName(command.name)}
                  </span>
                  <span className="slash-desc">{command.description}</span>
                  {command.owner === 'cozypad' ? (
                    // SPEC 1445: this command is completed by CozyPad itself —
                    // no agent turn, no Running state.
                    <span className="slash-owner">CozyPad</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          <div className="slash-hint hint">
            ↑↓ 選擇 · Tab/Enter 帶入 · 完整指令再按 Enter 執行 · Esc 關閉
          </div>
        </div>
      ) : null}
      {disabled && disabledReason !== undefined ? (
        // SPEC 1362-1364: a dead input box explains itself — the reason and
        // the next step, not just a grey field.
        <div className="composer-unavailable" role="status">
          <span>{disabledReason.text}</span>
          {disabledReason.nextStep === undefined ? null : (
            <span className="composer-unavailable-next">
              {disabledReason.nextStep}
            </span>
          )}
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="attachment-notice-banner" role="alert">
          {attachmentNotice}
        </div>
      ) : null}
      <div
        className={`composer${attachments.length > 0 ? ' composer-with-attachments' : ''}`}
      >
        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => {
              const fileBadgeText = getAttachmentFileTypeBadge(attachment.mediaType, attachment.name);
              const isUploading =
                attachment.state === 'uploading' ||
                attachment.state === 'packaging' ||
                attachment.state === 'transferring' ||
                attachment.state === 'verifying';
              return (
                <div
                  className={`composer-attachment composer-attachment-${attachment.state}`}
                  key={attachment.id}
                >
                  {attachment.previewUrl === undefined ? (
                    <span className="composer-file-icon">{fileBadgeText}</span>
                  ) : (
                    <img src={attachment.previewUrl} alt="" />
                  )}
                  <span>
                    <strong>{attachment.name}</strong>
                    <small
                      className={
                        attachment.state === 'error' ? 'attachment-state-error' : ''
                      }
                      title={attachment.errorMessage}
                    >
                      <span className={`attachment-badge attachment-badge-${attachment.state}`}>
                        {attachment.state === 'ready' ? (
                          '✓'
                        ) : attachment.state === 'error' ? (
                          '!'
                        ) : isUploading ? (
                          <span className="attachment-spinner" aria-hidden="true" />
                        ) : (
                          '•'
                        )}
                      </span>
                      {' '}
                      {ATTACHMENT_STATE_LABEL[attachment.state]}
                      {' · '}
                      {attachment.mediaType}
                      {' · '}
                      {formatAttachmentSize(attachment.sizeBytes)}
                    </small>
                  </span>
                  {attachment.state === 'error' && onRetryAttachment !== undefined ? (
                    <button
                      type="button"
                      className="attachment-retry"
                      title={`Retry ${attachment.name}`}
                      onClick={() => handleRetryAttachment(attachment.id)}
                    >
                      重試
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Remove attachment"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onRemoveAttachment(attachment.id)}
                    // SPEC 1414: only Processing forbids removal — a buffered
                    // or failed file stays removable while the agent runs.
                    disabled={isUploading}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          placeholder={`Message ${agentLabel} · Enter to send · Shift+Enter for newline`}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            if (historyIndex !== null) resetHistoryNavigation();
            onChange(event.target.value);
          }}
          onPaste={(event) => {
            if (disabled || uploading) return;
            const files = clipboardAttachmentFiles(
              event.clipboardData.items,
              event.clipboardData.files,
            );
            if (files.length === 0) return;
            if (event.clipboardData.getData('text') === '') event.preventDefault();
            onAttach(files);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (menuOpen && matches.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashIndex((index) => (index + 1) % matches.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex((index) => (index - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                const command = matches[slashIndex] ?? matches[0]!;
                if (event.key === 'Enter' && isExactSlashCommand(value, command)) {
                  send();
                } else {
                  accept(command);
                }
                return;
              }
            }
            if (menuOpen && event.key === 'Escape') {
              event.preventDefault();
              setSlashDismissed(true);
              return;
            }
            if (
              !menuOpen &&
              (event.key === 'ArrowUp' || event.key === 'ArrowDown')
            ) {
              const direction = event.key === 'ArrowUp' ? 'previous' : 'next';
              // SPEC 1350: history engages only at the caret's boundary —
              // every time, not just on entry. Once a multi-line prompt is
              // recalled, arrows inside it move the caret; swapping the
              // entry destroyed the text mid-edit. This also lets a
              // non-empty draft enter history (it is saved and restored on
              // the way back out).
              const canNavigate = caretIsOnHistoryEdge(
                event.currentTarget,
                direction,
              );
              if (canNavigate && moveThroughHistory(direction)) {
                event.preventDefault();
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) onAttach(files);
            }}
          />
          <button
            type="button"
            className="composer-attach"
            title="Attach image or file"
            aria-label="Attach image or file"
            // SPEC 1395-1399: only the count/size limits gate adding — a
            // buffered file makes no remote request, so a running turn is
            // no reason to refuse it.
            disabled={uploading || attachments.length >= MAX_AGENT_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? 'Packaging…' : '＋ Attach'}
          </button>
          {running && onStop !== undefined ? (
            <button
              type="button"
              className="composer-stop"
              disabled={stopping}
              onClick={onStop}
            >
              <span className="composer-stop-icon" aria-hidden="true" />
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : null}
          <button
            type="button"
            className="composer-send"
            onClick={send}
            disabled={
              disabled || uploading || (value.trim() === '' && attachments.length === 0)
            }
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
