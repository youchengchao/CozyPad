import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { MockPtyEngine } from '@cozypad/test-fixtures';
import {
  agyKeySequence,
  agyOptionSelectionSequence,
  deriveAgyScreenModel,
  extractAgyAssistantText,
  isAgyComposerEditable,
} from '../src/workspaces/agents/agyTerminalModel';

const encoder = new TextEncoder();

function visibleLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '',
  );
}

function parsed(): {
  terminal: Terminal;
  engine: MockPtyEngine;
  flush(): Promise<void>;
} {
  const terminal = new Terminal({ cols: 100, rows: 32, scrollback: 100 });
  const pending: Promise<void>[] = [];
  const engine = new MockPtyEngine(
    {
      onData(data) {
        pending.push(
          new Promise<void>((resolve) => {
            terminal.write(data, resolve);
          }),
        );
      },
    },
    { cols: 100, rows: 32 },
  );
  return {
    terminal,
    engine,
    async flush() {
      await Promise.all(pending.splice(0));
    },
  };
}

describe('AGY PTY to native UI integration', () => {
  it('reconstructs a VT-redrawn AGY menu and follows real direction keys', async () => {
    const { terminal, engine, flush } = parsed();
    engine.startAgy();
    await flush();

    let model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('welcome');
    expect(model.options[0]).toMatchObject({
      label: 'Start a task',
      selected: true,
    });

    engine.write(encoder.encode(agyKeySequence('down')));
    await flush();
    model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.options[1]).toMatchObject({
      label: 'Resume a conversation',
      selected: true,
    });

    terminal.dispose();
  });

  it('reconstructs the real prompt after Enter instead of exposing ANSI', async () => {
    const { terminal, engine, flush } = parsed();
    engine.startAgy();
    await flush();
    engine.write(encoder.encode(agyKeySequence('enter')));
    await flush();

    const model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('prompt');
    expect(model.promptHint).toContain('What would you like AGY to work on?');
    expect(model.rawLines.join('\n')).not.toContain('\u001b');

    terminal.dispose();
  });

  it('supports continuous slash typing, clickable choices, replies, and verified stop', async () => {
    const { terminal, engine, flush } = parsed();
    engine.startAgy();
    await flush();
    engine.write(encoder.encode(agyKeySequence('enter')));
    await flush();

    for (const character of ['/', 'm', 'o']) {
      engine.write(encoder.encode(character));
      await flush();
      const current = deriveAgyScreenModel(visibleLines(terminal));
      expect(isAgyComposerEditable('connected', 'ready', current.mode, `/${
        character === '/' ? '' : character === 'm' ? 'm' : 'mo'
      }`)).toBe(true);
    }

    let model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('suggestions');
    expect(model.options.map((option) => option.command)).toContain('/model');
    const modelCommand = model.options.findIndex((option) => option.command === '/model');
    engine.write(
      encoder.encode(
        agyOptionSelectionSequence(model.selectedIndex, modelCommand, undefined, 'tab'),
      ),
    );
    await flush();
    engine.write(encoder.encode(agyKeySequence('enter')));
    await flush();

    model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('viewer');
    expect(model.options.map((option) => option.label)).toEqual([
      'Auto',
      'Gemini Flash',
      'Gemini Pro',
    ]);
    engine.write(
      encoder.encode(agyOptionSelectionSequence(model.selectedIndex, 1)),
    );
    await flush();
    expect(deriveAgyScreenModel(visibleLines(terminal)).mode).toBe('prompt');

    engine.write(encoder.encode('hello AGY'));
    engine.write(encoder.encode(agyKeySequence('enter')));
    await flush();
    model = deriveAgyScreenModel(visibleLines(terminal));
    expect(extractAgyAssistantText(model, 'hello AGY')).toContain(
      'Mock AGY received: hello AGY',
    );

    engine.write(encoder.encode('slow task'));
    engine.write(encoder.encode(agyKeySequence('enter')));
    await flush();
    model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('running');
    engine.write(encoder.encode(agyKeySequence('interrupt')));
    await flush();
    model = deriveAgyScreenModel(visibleLines(terminal));
    expect(model.mode).toBe('prompt');
    expect(isAgyComposerEditable('connected', 'ready', model.mode, '')).toBe(true);

    terminal.dispose();
  });
});
