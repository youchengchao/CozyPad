import { useRef } from 'react';
import type { TerminalModifiers } from './TerminalView';

interface KeyDef {
  label: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
  repeat?: boolean;
  wide?: boolean;
}

/** Termux 風格排列：上排符號與導航、下排 TAB/CTRL/ALT 與方向鍵。 */
const ROW_TOP: KeyDef[] = [
  { label: 'ESC', seq: '' },
  { label: '/', seq: '/' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '-', seq: '-' },
  { label: 'HOME', seq: '[H' },
  { label: '↑', seq: '[A', repeat: true },
  { label: 'END', seq: '[F' },
  { label: 'PGUP', seq: '[5~' },
];

const ROW_BOTTOM: KeyDef[] = [
  { label: 'TAB', seq: '\t' },
  { label: 'CTRL', mod: 'ctrl', wide: true },
  { label: 'ALT', mod: 'alt', wide: true },
  { label: '←', seq: '[D', repeat: true },
  { label: '↓', seq: '[B', repeat: true },
  { label: '→', seq: '[C', repeat: true },
  { label: 'PGDN', seq: '[6~' },
];

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 110;

interface TerminalKeysBarProps {
  modifiers: TerminalModifiers;
  onSend(sequence: string): void;
  onToggleModifier(mod: 'ctrl' | 'alt'): void;
}

/**
 * 手機軟鍵盤上方的特殊鍵列（參考 Termux extra keys）。
 * CTRL/ALT 為 sticky：點亮後作用於下一個輸入字元（CTRL 亮 + c → ^C）。
 */
export function TerminalKeysBar({
  modifiers,
  onSend,
  onToggleModifier,
}: TerminalKeysBarProps) {
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatDelay = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRepeat = (): void => {
    if (repeatDelay.current !== null) clearTimeout(repeatDelay.current);
    if (repeatTimer.current !== null) clearInterval(repeatTimer.current);
    repeatDelay.current = null;
    repeatTimer.current = null;
  };

  const press = (key: KeyDef, event: React.PointerEvent): void => {
    // preventDefault 讓按鈕不搶走 terminal 焦點，軟鍵盤才不會縮回去。
    event.preventDefault();
    if (key.mod !== undefined) {
      onToggleModifier(key.mod);
      return;
    }
    if (key.seq === undefined) return;
    onSend(key.seq);
    if (key.repeat === true) {
      stopRepeat();
      repeatDelay.current = setTimeout(() => {
        repeatTimer.current = setInterval(() => onSend(key.seq!), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    }
  };

  const renderRow = (row: KeyDef[]) => (
    <div className="tkeys-row">
      {row.map((key) => {
        const modActive = key.mod !== undefined && modifiers[key.mod];
        return (
          <button
            key={key.label}
            className={`tkey${modActive ? ' tkey-active' : ''}${key.wide === true ? ' tkey-wide' : ''}`}
            onPointerDown={(event) => press(key, event)}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
            onContextMenu={(event) => event.preventDefault()}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="terminal-keys" onContextMenu={(event) => event.preventDefault()}>
      {renderRow(ROW_TOP)}
      {renderRow(ROW_BOTTOM)}
    </div>
  );
}
