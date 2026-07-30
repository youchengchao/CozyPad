import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuAction {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 在此項目上方畫分隔線。 */
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  title?: string;
  subtitle?: string;
  actions: MenuAction[];
  onSelect(id: string): void;
  onClose(): void;
}

/** 滑鼠右鍵與長按共用的動作選單；會自動避開視窗邊緣。 */
export function ContextMenu({
  x,
  y,
  title,
  subtitle,
  actions,
  onSelect,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: position.left, top: position.top }}
        onClick={(event) => event.stopPropagation()}
      >
        {title !== undefined ? (
          <div className="menu-header">
            <span className="menu-title">{title}</span>
            {subtitle !== undefined ? (
              <span className="menu-subtitle mono">{subtitle}</span>
            ) : null}
          </div>
        ) : null}
        {actions.map((action) => (
          <button
            key={action.id}
            className={`menu-item${action.danger === true ? ' menu-item-danger' : ''}${
              action.separatorBefore === true ? ' menu-sep' : ''
            }`}
            disabled={action.disabled === true}
            onClick={() => {
              onSelect(action.id);
              onClose();
            }}
          >
            <span className="menu-label">{action.label}</span>
            {action.hint !== undefined ? (
              <span className="menu-hint">{action.hint}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE_PX = 10;

/**
 * 產生同時支援滑鼠右鍵與觸控長按的 handler（手機沒有右鍵）。
 */
export function useLongPress(open: (x: number, y: number) => void): {
  onContextMenu(event: React.MouseEvent): void;
  onPointerDown(event: React.PointerEvent): void;
  onPointerUp(): void;
  onPointerMove(event: React.PointerEvent): void;
  onPointerCancel(): void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  return {
    onContextMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      open(event.clientX, event.clientY);
    },
    onPointerDown(event) {
      if (event.pointerType === 'mouse') return;
      const { clientX, clientY } = event;
      origin.current = { x: clientX, y: clientY };
      timer.current = setTimeout(() => open(clientX, clientY), LONG_PRESS_MS);
    },
    onPointerMove(event) {
      const start = origin.current;
      if (start === null) return;
      if (
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}
