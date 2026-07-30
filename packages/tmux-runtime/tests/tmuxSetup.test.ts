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

  it('checks the tools that actually break the build', async () => {
    let sent = '';
    await detectTmux((command) => {
      sent = command;
      return Promise.resolve('__PATH__\t\n__VERSION__\t\n');
    });
    expect(sent).toContain('tar');
    expect(sent).toContain('yacc');
    expect(sent).toContain('bison');
    expect(sent).toContain('m4');
  });

  it('missing yacc is not a blocker - bison gets built alongside', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t\n__VERSION__\t\n__EXTRA_BUILD__\tbison\n'),
    );
    expect(status.canInstall).toBe(true);
    expect(status.missingTools).toEqual([]);
    expect(status.extraBuilds).toEqual(['bison']);
  });

  it('missing yacc AND m4 is a genuine blocker', async () => {
    const status = await detectTmux(
      fakeExec('__PATH__\t\n__VERSION__\t\n__MISSING__\tm4（yacc/bison\n'),
    );
    expect(status.canInstall).toBe(false);
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

  it('builds bison only when the host has no yacc', () => {
    expect(script).toContain('NEED_BISON=1');
    expect(script).toContain('bison-3.8.2.tar.gz');
    expect(script).toContain('if [ "$NEED_BISON" = "1" ]; then');
    expect(script).toContain('run "verify bison" command -v bison');
  });

  it('exposes YACC as a PATH-resolvable name, not an absolute path', () => {
    // autoconf 的 AC_CHECK_PROG 會把絕對路徑接到各 PATH 目錄下尋找，永遠失敗。
    expect(script).toContain('export YACC="bison -y"');
    expect(script).not.toMatch(/YACC="\$PREFIX/);
    expect(script).toContain('export PATH="$PREFIX/bin:$PATH"');
  });

  it('passes explicit ncurses/libevent flags so pkg-config is not required', () => {
    expect(script).toContain('NCURSES_LIBS=');
    expect(script).toContain('LIBEVENT_LIBS=');
  });

  it('builds wide-character ncurses, matching the -lncursesw it links against', () => {
    // 沒有 --enable-widec 就只會產生 libncurses，連結 -lncursesw 必定失敗，
    // 而且 CJK 寬字元也需要 widec。
    expect(script).toContain('--enable-widec');
    expect(script).toContain('-lncursesw');
    expect(script).toContain('include/ncursesw');
  });

  it('links ncurses statically and sets rpath so tmux runs without LD_LIBRARY_PATH', () => {
    expect(script).toContain('--without-shared');
    expect(script).toContain('-Wl,-rpath,$PREFIX/lib');
    // 驗證階段刻意不設 LD_LIBRARY_PATH：它必須在乾淨環境下也能跑。
    expect(script).not.toContain('export LD_LIBRARY_PATH');
  });

  it('guards against concurrent installs and low disk space', () => {
    expect(script).toContain('mkdir "$LOCK_DIR"');
    expect(script).toContain('df -Pk');
  });

  it('echoes every command it runs and streams output live', () => {
    expect(script).toContain("printf '__CMD__\\t%s\\n' \"$*\"");
    expect(script).toContain("printf '__LOG__\\t%s\\n' \"$line\"");
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
    // 失敗時必須拿得到真正的錯誤：建置指令不得把輸出丟進 /dev/null。
    const buildLines = script
      .split('\n')
      .filter((line) => /(\.\/configure|make -j|make install|curl -fsSL)/.test(line));
    expect(buildLines.length).toBeGreaterThan(8);
    for (const line of buildLines) {
      expect(line).not.toContain('/dev/null');
    }
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
