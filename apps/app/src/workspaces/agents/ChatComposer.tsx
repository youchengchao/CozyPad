import { useEffect, useRef, useState } from 'react';
import type { SlashCommand } from '@cozypad/contracts';

interface ChatComposerProps {
  agentLabel: string;
  value: string;
  commands: SlashCommand[];
  onChange(value: string): void;
  onSend(text: string): void;
}

export function ChatComposer({
  agentLabel,
  value,
  commands,
  onChange,
  onSend,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const slashQuery =
    value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1).toLowerCase()
      : null;
  const matches =
    slashQuery !== null && !slashDismissed
      ? commands.filter((command) => command.name.toLowerCase().startsWith(slashQuery))
      : [];
  const menuOpen = matches.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashQuery === null) setSlashDismissed(false);
  }, [slashQuery]);

  const accept = (command: SlashCommand) => {
    onChange(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const send = () => {
    const text = value.trim();
    if (text === '') return;
    onSend(text);
    textareaRef.current?.focus();
  };

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <div className="slash-menu">
          {matches.map((command, index) => (
            <button
              key={command.name}
              className={`slash-item${index === slashIndex ? ' slash-item-active' : ''}`}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => accept(command)}
            >
              <span className="slash-name">/{command.name}</span>
              <span className="slash-desc">{command.description}</span>
            </button>
          ))}
          <div className="slash-hint hint">↑↓ 選擇 · Tab/Enter 帶入 · Esc 關閉</div>
        </div>
      ) : null}
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          placeholder={`Message ${agentLabel}…（Enter 送出、Shift+Enter 換行、/ 指令）`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (menuOpen) {
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
                accept(matches[slashIndex] ?? matches[0]!);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
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
          <button className="composer-attach" title="附件：Phase 4" disabled>
            ＋
          </button>
          <button className="composer-send" onClick={send} disabled={value.trim() === ''}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
