import { useRef } from 'react';

interface ChatComposerProps {
  agentLabel: string;
  value: string;
  onChange(value: string): void;
  onSend(text: string): void;
}

export function ChatComposer({ agentLabel, value, onChange, onSend }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const text = value.trim();
    if (text === '') return;
    onSend(text);
    textareaRef.current?.focus();
  };

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        rows={Math.min(6, Math.max(1, value.split('\n').length))}
        placeholder={`Message ${agentLabel}…（Enter 送出、Shift+Enter 換行）`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
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
  );
}
