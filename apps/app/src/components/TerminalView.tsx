import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
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
  /** sticky modifier：作用於下一個輸入字元（Termux 行為）。 */
  setModifier(mod: 'ctrl' | 'alt', on: boolean): void;
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

    unsubscribes.push(
      bridge.onTerminalOutput((event) => {
        if (event.terminalId === terminalId) {
          term.write(base64ToBytes(event.dataBase64));
        }
      }),
    );
    unsubscribes.push(
      bridge.onTerminalClosed((event) => {
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

    void bridge
      .openTerminal({ profileId, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (disposed) {
          void bridge.closeTerminal({ terminalId: opened.terminalId });
          return;
        }
        terminalId = opened.terminalId;
        term.focus();
        onHandleRef.current?.({
          paste: pasteToTerminal,
          run: (command) => pasteToTerminal(command + '\r'),
          focus: () => term.focus(),
          sendRaw: pasteToTerminal,
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
