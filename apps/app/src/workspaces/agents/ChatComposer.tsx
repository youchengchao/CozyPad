import { useEffect, useRef, useState } from 'react';
import type { SlashCommand } from '@cozypad/contracts';

export interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  previewUrl?: string;
}

interface ChatComposerProps {
  agentLabel: string;
  value: string;
  history: string[];
  commands: SlashCommand[];
  attachments: ComposerAttachment[];
  uploading?: boolean;
  disabled?: boolean;
  running?: boolean;
  stopping?: boolean;
  onChange(value: string): void;
  onAttach(files: File[]): void;
  onRemoveAttachment(id: string): void;
  onCommand?(command: SlashCommand): void;
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

export function slashCommandSelectionBehavior(
  command: SlashCommand,
): 'insert' | 'submit' | 'picker' {
  return command.behavior ?? 'insert';
}

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

function caretIsOnHistoryEdge(
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
  running = false,
  stopping = false,
  onChange,
  onAttach,
  onRemoveAttachment,
  onCommand,
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

  const accept = (command: SlashCommand) => {
    const commandText = `/${normalizeSlashCommandName(command.name)}`;
    const behavior = slashCommandSelectionBehavior(command);
    if (behavior === 'picker' && onCommand !== undefined) {
      setSlashDismissed(true);
      onChange('');
      onCommand(command);
    } else if (behavior === 'submit') {
      setSlashDismissed(true);
      onChange('');
      if (onCommand === undefined) onSend(commandText);
      else onCommand(command);
    } else {
      onChange(commandText);
    }
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
    if (disabled || uploading) return;
    const text = value.trim();
    if (text === '' && attachments.length === 0) return;
    resetHistoryNavigation();
    onSend(text);
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
                </button>
              ))
            )}
          </div>
          <div className="slash-hint hint">
            ↑↓ 選擇 · Tab/Enter 帶入 · 完整指令再按 Enter 執行 · Esc 關閉
          </div>
        </div>
      ) : null}
      <div className="composer">
        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.id}>
                {attachment.previewUrl === undefined ? (
                  <span className="composer-file-icon">FILE</span>
                ) : (
                  <img src={attachment.previewUrl} alt="" />
                )}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KB</small>
                </span>
                <button
                  type="button"
                  title="Remove attachment"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  disabled={disabled || uploading}
                >
                  ×
                </button>
              </div>
            ))}
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
            const files = [...event.clipboardData.items]
              .filter((item) => item.kind === 'file')
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
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
                if (
                  event.key === 'Enter' &&
                  isExactSlashCommand(value, command) &&
                  slashCommandSelectionBehavior(command) === 'insert'
                ) {
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
              const enteringHistory = historyIndex === null;
              const canNavigate =
                !enteringHistory ||
                (direction === 'previous' &&
                  value === '' &&
                  caretIsOnHistoryEdge(event.currentTarget, direction));
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
            disabled={disabled || uploading || attachments.length >= 10}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? '…' : '+'}
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
