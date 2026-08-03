import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
import type { TerminalClosedEvent, TerminalOutputEvent } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

export interface TerminalModifiers {
  ctrl: boolean;
  alt: boolean;
}

export interface TerminalHandle {
  paste(text: string): void;
  run(command: string): void;
  focus(): void;
  /** 直接送出原始序列（ESC、方向鍵等），不套用 modifier。 */
  sendRaw(data: string): void;
  /** Scroll the local xterm scrollback without sending keys to the remote shell. */
  scrollLines(amount: number): void;
  scrollPages(pageCount: number): void;
  scrollToBottom(): void;
  /** sticky modifier：作用於下一個輸入字元（Termux 行為）。 */
  setModifier(mod: 'ctrl' | 'alt', on: boolean): void;
}

export function terminalScrollLinesForTouch(
  deltaY: number,
  lineHeight: number,
): number {
  if (!Number.isFinite(deltaY) || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    return 0;
  }
  const lines = Math.trunc(deltaY / lineHeight);
  return lines === 0 ? 0 : -lines;
}

/** a-z 與 @[\]^_ 轉為對應 control character（Ctrl+C → \x03）。 */
function toControlChar(ch: string): string | null {
  if (ch >= 'a' && ch <= 'z') return String.fromCharCode(ch.charCodeAt(0) - 96);
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  return null;
}

/** 右鍵行為：有選取＝複製選取，無選取＝貼上剪貼簿（Flutter 版同款）。 */
async function handleTerminalContextMenu(
  term: Terminal,
  paste: (text: string) => void,
  notify: (message: string) => void,
): Promise<void> {
  const bridge = getBridge();
  const selection = term.getSelection();
  if (selection !== '') {
    try {
      await bridge.writeClipboard(selection);
      term.clearSelection();
      notify('已複製選取內容');
    } catch {
      notify('複製失敗');
    }
    return;
  }
  try {
    const text = await bridge.readClipboard();
    if (text !== '') paste(text);
    else notify('剪貼簿是空的');
  } catch {
    notify('貼上失敗');
  }
}

interface TerminalViewProps {
  profileId: string;
  onExit?: () => void;
  onHandle?: (handle: TerminalHandle | null) => void;
  onNotify?: (message: string) => void;
  onModifiersChange?: (modifiers: TerminalModifiers) => void;
}

export function TerminalView({
  profileId,
  onExit,
  onHandle,
  onNotify,
  onModifiersChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const onModifiersChangeRef = useRef(onModifiersChange);
  onModifiersChangeRef.current = onModifiersChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bridge = getBridge();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 10_000,
      fontFamily: '"Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", monospace',
      theme: {
        background: '#101014',
        foreground: '#e6e6e6',
        cursor: '#ffb454',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    if (import.meta.env.DEV) {
      (window as unknown as { __cozypadDebug?: object }).__cozypadDebug = {
        term,
        bridge,
      };
    }

    let terminalId: string | null = null;
    const earlyOutput: TerminalOutputEvent[] = [];
    const earlyClosed: TerminalClosedEvent[] = [];
    let disposed = false;
    const unsubscribes: (() => void)[] = [];
    const modifiers: TerminalModifiers = { ctrl: false, alt: false };

    const notifyModifiers = (): void => {
      onModifiersChangeRef.current?.({ ...modifiers });
    };

    const pasteToTerminal = (text: string): void => {
      if (terminalId !== null) {
        bridge.writeTerminal({ terminalId, dataBase64: textToBase64(text) });
      }
    };

    /** 套用 sticky modifier 後送出（軟鍵盤輸入經過這裡）。 */
    const sendWithModifiers = (data: string): void => {
      let out = data;
      if (modifiers.ctrl && data.length === 1) {
        out = toControlChar(data) ?? out;
        modifiers.ctrl = false;
        notifyModifiers();
      }
      if (modifiers.alt && out.length === 1) {
        out = `${out}`;
        modifiers.alt = false;
        notifyModifiers();
      }
      pasteToTerminal(out);
    };

    // 右鍵在 terminal 建立時就綁定，即使開啟 session 失敗仍可複製畫面內容。
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      void handleTerminalContextMenu(term, pasteToTerminal, (message) =>
        onNotifyRef.current?.(message),
      );
    };
    container.addEventListener('contextmenu', onContextMenu);

    let touchPointerId: number | null = null;
    let touchLastY = 0;
    let touchRemainderY = 0;
    const touchLineHeight = Math.max(
      12,
      (term.options.fontSize ?? 14) * (term.options.lineHeight ?? 1),
    );
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      touchPointerId = event.pointerId;
      touchLastY = event.clientY;
      touchRemainderY = 0;
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== touchPointerId) return;
      touchRemainderY += event.clientY - touchLastY;
      touchLastY = event.clientY;
      const lines = terminalScrollLinesForTouch(touchRemainderY, touchLineHeight);
      if (lines === 0) return;
      try {
        if (!container.hasPointerCapture(event.pointerId)) {
          container.setPointerCapture(event.pointerId);
        }
      } catch {
        // Some Android WebViews do not expose pointer capture for xterm children.
      }
      term.scrollLines(lines);
      touchRemainderY += lines * touchLineHeight;
      event.preventDefault();
      event.stopPropagation();
    };
    const stopTouchScroll = (event: PointerEvent): void => {
      if (event.pointerId !== touchPointerId) return;
      touchPointerId = null;
      touchRemainderY = 0;
    };
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointermove', onPointerMove, {
      capture: true,
      passive: false,
    });
    container.addEventListener('pointerup', stopTouchScroll, true);
    container.addEventListener('pointercancel', stopTouchScroll, true);

    unsubscribes.push(
      bridge.onTerminalOutput((event) => {
        if (terminalId === null) {
          earlyOutput.push(event);
          if (earlyOutput.length > 128) earlyOutput.shift();
          return;
        }
        if (event.terminalId === terminalId) {
          term.write(base64ToBytes(event.dataBase64));
        }
      }),
    );
    unsubscribes.push(
      bridge.onTerminalClosed((event) => {
        if (terminalId === null) {
          earlyClosed.push(event);
          if (earlyClosed.length > 16) earlyClosed.shift();
          return;
        }
        if (event.terminalId === terminalId) {
          terminalId = null;
          term.write('\r\n[2m[session closed][0m\r\n');
          onExitRef.current?.();
        }
      }),
    );

    const dataDisposable = term.onData((data) => {
      sendWithModifiers(data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (terminalId) void bridge.resizeTerminal({ terminalId, cols, rows });
    });

    const opening = bridge.openTerminal({
      profileId,
      cols: term.cols,
      rows: term.rows,
    });
    void opening
      .then((opened) => {
        if (disposed) {
          void bridge.closeTerminal({ terminalId: opened.terminalId });
          return;
        }
        terminalId = opened.terminalId;
        for (const event of earlyOutput) {
          if (event.terminalId === terminalId) {
            term.write(base64ToBytes(event.dataBase64));
          }
        }
        earlyOutput.length = 0;
        const wasClosed = earlyClosed.some(
          (event) => event.terminalId === terminalId,
        );
        earlyClosed.length = 0;
        if (wasClosed) {
          terminalId = null;
          term.write('\r\n\u001b[2m[session closed]\u001b[0m\r\n');
          onExitRef.current?.();
          return;
        }
        term.focus();
        onHandleRef.current?.({
          paste: pasteToTerminal,
          run: (command) => pasteToTerminal(command + '\r'),
          focus: () => term.focus(),
          sendRaw: pasteToTerminal,
          scrollLines: (amount) => term.scrollLines(amount),
          scrollPages: (pageCount) => term.scrollPages(pageCount),
          scrollToBottom: () => term.scrollToBottom(),
          setModifier: (mod, on) => {
            modifiers[mod] = on;
            notifyModifiers();
          },
        });
      })
      .catch((error: unknown) => {
        term.write(`\r\nfailed to open terminal: ${String(error)}\r\n`);
      });

    const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
    observer.observe(container);

    return () => {
      disposed = true;
      onHandleRef.current?.(null);
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointermove', onPointerMove, true);
      container.removeEventListener('pointerup', stopTouchScroll, true);
      container.removeEventListener('pointercancel', stopTouchScroll, true);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      if (terminalId) void bridge.closeTerminal({ terminalId });
      term.dispose();
    };
  }, [profileId]);

  return <div className="terminal-host" ref={containerRef} />;
}
