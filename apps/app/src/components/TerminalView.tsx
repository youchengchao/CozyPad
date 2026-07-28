import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { base64ToBytes, textToBase64 } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface TerminalViewProps {
  profileId: string;
  onExit?: () => void;
}

export function TerminalView({ profileId, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
      if (terminalId) {
        bridge.writeTerminal({ terminalId, dataBase64: textToBase64(data) });
      }
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
      })
      .catch((error: unknown) => {
        term.write(`\r\nfailed to open terminal: ${String(error)}\r\n`);
      });

    const observer = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()));
    observer.observe(container);

    return () => {
      disposed = true;
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
