/**
 * The default spawn path — the one that runs in production.
 *
 * Every other test in this package injects its own `spawn`, so the lambda in
 * `AgyCliTransport`'s constructor was reachable by nothing: replacing its body
 * with `throw new Error('DEFAULT SPAWN REACHED')` left the whole suite green, and
 * so did flipping its `shell: false` to `shell: true`. The only assertion that
 * looked like a guard checked the *injected* spawn's options, whose declared type
 * (`AgySpawnOptions`) has no `shell` member at all, so it could never fail.
 *
 * This file mocks `node:child_process` instead, which leaves the real lambda in
 * the path and puts the exact options object it builds under assertion.
 *
 * The assertion is `toBe(false)`, not `not.toBe(true)`: node gives `shell: true`
 * and `shell: '<some shell>'` the same argv-joining treatment, so the weaker form
 * let `shell: 'powershell.exe'` through with the suite still green.
 *
 * Why `shell: true` is a hard no: on Windows it concatenates argv into one
 * unescaped command line. A prompt containing a space is shredded into several
 * arguments, `--output-format stream-json` is lost with it, and agy then answers
 * a different, truncated prompt in plain text that nothing here can parse. The
 * failure is silent — a plausible-looking wrong answer, not a crash.
 */
import { describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  interface SpawnCall {
    readonly command: string;
    readonly args: unknown;
    readonly options: Record<string, unknown>;
  }
  const calls: SpawnCall[] = [];

  const spawn = (command: string, args: unknown, options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const listeners = new Map<string, (arg: never) => void>();
    const silentStream = { setEncoding: () => undefined, on: () => undefined };
    return {
      stdout: silentStream,
      stderr: silentStream,
      kill: () => true,
      once: (event: string, listener: (arg: never) => void) => {
        listeners.set(event, listener);
      },
      /** Test-only: end the fake child so `runTurn`'s iterable completes. */
      finish: (code: number | null) => listeners.get('close')?.(code as never),
    };
  };

  return { calls, spawn };
});

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }));

const { AgyCliTransport, defaultAgyExecutable } = await import('../src/cliTransport.js');

/** Run one turn through the real default spawn and return what node was handed. */
function spawnedWith(
  prompt: string,
  conversationId: string | null = null,
  additionalDirectories: readonly string[] = [],
  model: string | null = null,
) {
  const before = childProcess.calls.length;
  void new AgyCliTransport({ executable: 'agy-under-test' }).runTurn({
    prompt,
    cwd: '/w',
    additionalDirectories,
    conversationId,
    model,
  });
  const call = childProcess.calls[before];
  expect(call, 'the default spawn lambda was never reached').toBeDefined();
  expect(childProcess.calls).toHaveLength(before + 1);
  return call!;
}

describe('the spawn AgyCliTransport uses when none is injected', () => {
  it('is actually reached — no test may quietly bypass it', () => {
    const call = spawnedWith('hello');
    expect(call.command).toBe('agy-under-test');
  });

  it('hands node shell: false — not merely "not true"', () => {
    // `not.toBe(true)` was too weak to be a guard: node treats `shell: <string>`
    // (`'powershell.exe'`, `'cmd.exe'`, `'/bin/sh'`) exactly like `shell: true`,
    // joining argv into one command line, so the whole suite stayed green with
    // the regression in place. The invariant is the literal `false`.
    expect(spawnedWith('hello').options.shell).toBe(false);
  });

  it('keeps shell off even for a prompt full of things a shell would eat', () => {
    const prompt = 'write a "hello world" script & echo $HOME | tee out.txt';
    const call = spawnedWith(prompt);
    expect(call.options.shell).toBe(false);
    // And the prompt reached node as one argv element, spaces and quotes intact.
    expect(call.args).toEqual([
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--add-dir',
      '/w',
    ]);
  });

  it('passes argv as a real array, never a pre-joined command string', () => {
    const call = spawnedWith('a b c');
    expect(Array.isArray(call.args)).toBe(true);
    expect(typeof call.args).not.toBe('string');
  });

  it('forwards --conversation through the default path too', () => {
    expect(spawnedWith('again', 'conv-77').args).toEqual([
      '-p',
      'again',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/w',
      '--conversation',
      'conv-77',
    ]);
  });

  it('forwards every workspace root through the default path too', () => {
    // The guard that matters for D5 on the production path: an injected spawn
    // replaces the lambda outright, so only this file sees what node is really
    // handed. A `--add-dir` lost here is a wrong answer, not a crash.
    expect(spawnedWith('go', null, ['/extra']).args).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/w',
      '--add-dir',
      '/extra',
    ]);
  });

  it('gives node the cwd, a mutable stdio array and NO_COLOR', () => {
    const call = spawnedWith('hello');
    expect(call.options.cwd).toBe('/w');
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // The transport declares stdio readonly and must copy it; node mutates.
    expect(Object.isFrozen(call.options.stdio)).toBe(false);
    expect((call.options.env as NodeJS.ProcessEnv).NO_COLOR).toBe('1');
  });

  it('defaults the executable to the platform agy binary', () => {
    const expected = process.platform === 'win32' ? 'agy.exe' : 'agy';
    expect(defaultAgyExecutable()).toBe(expected);

    const before = childProcess.calls.length;
    void new AgyCliTransport().runTurn({
      prompt: 'x',
      cwd: '/w',
      additionalDirectories: [],
      conversationId: null,
      model: null,
    });
    expect(childProcess.calls[before]?.command).toBe(expected);
  });

  it('forwards a pinned --model through the default path too', () => {
    // Same reason the `--add-dir` guard above lives in this file: an injected
    // spawn replaces the lambda outright, so nothing else sees what node is
    // really handed. A `--model` lost here does not fail — the turn runs on
    // agy's saved default and reports nothing, which is the F1 defect.
    expect(spawnedWith('go', null, [], 'claude-sonnet-4-6').args).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--model',
      'claude-sonnet-4-6',
      '--add-dir',
      '/w',
    ]);
  });
});
