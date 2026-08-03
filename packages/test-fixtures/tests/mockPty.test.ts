import { describe, expect, it } from 'vitest';
import { MockPtyEngine } from '../src/mockPty';

const encoder = new TextEncoder();

function collect(): { engine: MockPtyEngine; output: () => string; closes: number[] } {
  const chunks: Uint8Array[] = [];
  const closes: number[] = [];
  const decoder = new TextDecoder();
  const engine = new MockPtyEngine({
    onData: (d) => chunks.push(d),
    onClose: (info) => closes.push(info.exitCode ?? -1),
  });
  return {
    engine,
    output: () => chunks.map((c) => decoder.decode(c)).join(''),
    closes,
  };
}

function type(engine: MockPtyEngine, text: string): void {
  engine.write(encoder.encode(text));
}

describe('MockPtyEngine', () => {
  it('emits a banner and prompt on start', () => {
    const { engine, output } = collect();
    engine.start();
    expect(output()).toContain('CozyPad mock shell');
    expect(output()).toContain('cozy@mock');
  });

  it('echoes typed characters', () => {
    const { engine, output } = collect();
    engine.start();
    type(engine, 'ls');
    expect(output().endsWith('ls')).toBe(true);
  });

  it('runs ls on Enter and prints fake files', () => {
    const { engine, output } = collect();
    engine.start();
    type(engine, 'ls\r');
    expect(output()).toContain('cozypad.study.yaml');
    expect(output()).toContain('projects');
  });

  it('handles backspace with erase sequence', () => {
    const { engine, output } = collect();
    engine.start();
    type(engine, 'lsx');
    type(engine, '');
    type(engine, '\r');
    expect(output()).toContain('\b \b');
    expect(output()).toContain('cozypad.study.yaml');
  });

  it('reports unknown commands', () => {
    const { engine, output } = collect();
    engine.start();
    type(engine, 'flutter\r');
    expect(output()).toContain('command not found: flutter');
  });

  it('handles CJK input split across chunks', () => {
    const { engine, output } = collect();
    engine.start();
    engine.write(new Uint8Array([0xe4, 0xb8]));
    engine.write(new Uint8Array([0xad]));
    expect(output().endsWith('中')).toBe(true);
  });

  it('closes on exit and reports exit code once', () => {
    const { engine, output, closes } = collect();
    engine.start();
    type(engine, 'exit\r');
    expect(output()).toContain('logout');
    expect(closes).toEqual([0]);
    engine.close();
    expect(closes).toEqual([0]);
  });

  it('tracks resize', () => {
    const { engine } = collect();
    engine.resize(120, 40);
    expect(engine.size).toEqual({ cols: 120, rows: 40 });
  });

  it('drives the AGY TUI with all four direction-key sequences and Enter', () => {
    const { engine, output } = collect();
    engine.startAgy();
    expect(output()).toContain('AGY 1.1.9');

    type(engine, '\u001b[B');
    expect(output()).toContain('❯ Resume a conversation');
    type(engine, '\u001b[C');
    expect(output()).toContain('❯ Review settings');
    type(engine, '\u001b[A');
    expect(output()).toContain('❯ Resume a conversation');
    type(engine, '\u001b[D');
    expect(output()).toContain('❯ Start a task');

    type(engine, '\r');
    expect(output()).toContain('What would you like AGY to work on?');
  });

  it('redraws slash autocomplete after every character without losing the draft', () => {
    const { engine, output } = collect();
    engine.startAgy();
    type(engine, '\r');
    type(engine, '/');
    expect(output()).toContain('/model');
    type(engine, 'm');
    type(engine, 'o');
    expect(output()).toContain('❯ /mo');
    type(engine, '\t');
    expect(output()).toContain('❯ /model');
  });
});
