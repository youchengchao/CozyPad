import { describe, expect, it } from 'vitest';
import { TMUX_TARGET_VERSION } from '@cozypad/contracts';
import {
  buildTmuxInstallScript,
  compareTmuxVersions,
  detectTmux,
  parseInstallStages,
  parseTmuxVersion,
} from '../src/setup';

function fakeExec(output: string): (command: string) => Promise<string> {
  return () => Promise.resolve(output);
}

describe('compareTmuxVersions', () => {
  it('orders by major, minor, then suffix letter', () => {
    expect(compareTmuxVersions('3.5a', '3.5')).toBeGreaterThan(0);
    expect(compareTmuxVersions('3.4', '3.5a')).toBeLessThan(0);
    expect(compareTmuxVersions('4.0', '3.5a')).toBeGreaterThan(0);
    expect(compareTmuxVersions('3.5a', '3.5a')).toBe(0);
  });
});

describe('parseTmuxVersion', () => {
  it('reads the version from tmux -V output', () => {
    expect(parseTmuxVersion('tmux 3.5a')).toBe('3.5a');
    expect(parseTmuxVersion('tmux next-3.6')).toBe('3.6');
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('detectTmux', () => {
  it('reports a user-level install that satisfies the target', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t/home/y/.local/bin/tmux\n__VERSION__\ttmux 3.5a\n'),
    );
    expect(status).toMatchObject({
      installed: true,
      version: '3.5a',
      userLevel: true,
      satisfiesTarget: true,
      canInstall: true,
      missingTools: [],
    });
  });

  it('flags a system install that is too old', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t/usr/bin/tmux\n__VERSION__\ttmux 3.0a\n'),
    );
    expect(status.installed).toBe(true);
    expect(status.userLevel).toBe(false);
    expect(status.satisfiesTarget).toBe(false);
    expect(status.targetVersion).toBe(TMUX_TARGET_VERSION);
  });

  it('reports missing tmux and missing build tools', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t\n__VERSION__\t\n__MISSING__\tcc\n__MISSING__\tmake\n'),
    );
    expect(status.installed).toBe(false);
    expect(status.path).toBeNull();
    expect(status.canInstall).toBe(false);
    expect(status.missingTools).toEqual(['cc', 'make']);
  });
});

describe('buildTmuxInstallScript', () => {
  const script = buildTmuxInstallScript();

  it('installs into the user prefix without sudo', () => {
    expect(script).toContain('PREFIX="$HOME/.local"');
    expect(script).not.toContain('sudo');
  });

  it('builds libevent, ncurses and tmux at the target version', () => {
    expect(script).toContain('libevent');
    expect(script).toContain('ncurses');
    expect(script).toContain(`tmux-${TMUX_TARGET_VERSION}.tar.gz`);
  });

  it('adds ~/.local/bin to shell rc files via a managed block', () => {
    expect(script).toContain('# >>> cozypad path >>>');
    expect(script).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('verifies the install by starting and killing a real session', () => {
    expect(script).toContain('new-session -d -s cozypad_verify');
    expect(script).toContain('has-session -t cozypad_verify');
    expect(script).toContain('kill-session -t cozypad_verify');
  });

  it('emits machine-readable stage markers', () => {
    const stages = parseInstallStages(script.replace(/echo "/g, '').replace(/"$/gm, ''));
    expect(stages.map((entry) => entry.stage)).toEqual([
      'downloading',
      'building',
      'building',
      'building',
      'installing',
      'verifying',
      'done',
    ]);
  });
});
