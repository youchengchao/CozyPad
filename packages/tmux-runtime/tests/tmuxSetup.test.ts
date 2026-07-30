import { describe, expect, it } from 'vitest';
import { TMUX_TARGET_VERSION } from '@cozypad/contracts';
import {
  buildRemoteCleanupScript,
  buildTmuxInstallScript,
  compareTmuxVersions,
  detectTmux,
  parseInstallFailure,
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

  it('checks for the tools that actually break the build (yacc, pkg-config, tar)', async () => {
    let sent = '';
    await detectTmux((command) => {
      sent = command;
      return Promise.resolve('__PATH__\t\n__VERSION__\t\n');
    });
    expect(sent).toContain('pkg-config');
    expect(sent).toContain('tar');
    expect(sent).toContain('yacc');
    expect(sent).toContain('bison');
  });

  it('treats yacc/bison/byacc as interchangeable', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t\n__VERSION__\t\n__MISSING__\tyacc/bison/byacc\n'),
    );
    expect(status.missingTools).toEqual(['yacc/bison/byacc']);
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

  it('keeps build output in a log instead of discarding it', () => {
    // 失敗時必須拿得到真正的錯誤，不能 >/dev/null 吞掉。
    expect(script).not.toContain('>/dev/null 2>&1');
    expect(script).toContain('LOG="$HOME/.cozypad/tmux-install.log"');
    expect(script).toContain('tail -n 40 "$LOG"');
    expect(script).toContain('__FAILED__');
  });

  it('cleans the build cache on success so nothing large is left behind', () => {
    expect(script).toContain('rm -rf "$SRC"');
    expect(buildTmuxInstallScript(undefined, { keepBuildDir: true })).not.toContain(
      'rm -rf "$SRC"',
    );
  });

  /** 腳本中的進度呼叫寫成 `stage <name> <percent> "<message>"`。 */
  const scriptStages = [...script.matchAll(/^stage (\S+) (\d+) "([^"]+)"$/gm)].map(
    (match) => ({ stage: match[1]!, percent: Number(match[2]), message: match[3]! }),
  );

  it('emits monotonically increasing progress percentages ending at 100', () => {
    expect(scriptStages.length).toBeGreaterThan(10);
    const percents = scriptStages.map((entry) => entry.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents[percents.length - 1]).toBe(100);
    expect(scriptStages[scriptStages.length - 1]?.stage).toBe('done');
  });

  it('each stage carries a human-readable message', () => {
    for (const stage of scriptStages) {
      expect(stage.message.trim().length).toBeGreaterThan(0);
    }
  });

  it('runtime stage lines parse back into progress events', () => {
    const emitted = '__STAGE__\tbuilding\t48\t編譯 ncurses（最久，約 2-5 分鐘）';
    expect(parseInstallStages(emitted)).toEqual([
      { stage: 'building', percent: 48, message: '編譯 ncurses（最久，約 2-5 分鐘）' },
    ]);
  });
});

describe('parseInstallFailure', () => {
  it('extracts the failing step and log tail', () => {
    const output = [
      '__STAGE__\tbuilding\t40\t設定 ncurses',
      '__FAILED__\tconfigure ncurses',
      '__LOG_TAIL__',
      'configure: error: no acceptable cc found',
    ].join('\n');
    expect(parseInstallFailure(output)).toEqual({
      step: 'configure ncurses',
      logTail: 'configure: error: no acceptable cc found',
    });
  });

  it('returns null for successful runs', () => {
    expect(parseInstallFailure('__STAGE__\tdone\t100\tok')).toBeNull();
  });
});

describe('buildRemoteCleanupScript', () => {
  it('removes the build cache and managed config blocks', () => {
    const script = buildRemoteCleanupScript({ removeTmuxBinary: false });
    expect(script).toContain('rm -rf "$HOME/.cozypad/src"');
    expect(script).toContain('cozypad (managed|path)');
    expect(script).toContain('.tmux.conf');
  });

  it('leaves the tmux binary alone unless explicitly asked', () => {
    expect(buildRemoteCleanupScript({ removeTmuxBinary: false })).not.toContain(
      '.local/bin/tmux',
    );
    expect(buildRemoteCleanupScript({ removeTmuxBinary: true })).toContain(
      'rm -f "$HOME/.local/bin/tmux"',
    );
  });

  it('never touches anything outside the user home', () => {
    const script = buildRemoteCleanupScript({ removeTmuxBinary: true });
    for (const match of script.matchAll(/rm -[rf]+ "([^"]+)"/g)) {
      expect(match[1]).toMatch(/^\$HOME\//);
    }
  });
});
