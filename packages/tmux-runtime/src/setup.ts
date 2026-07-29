import type { TmuxStatus } from '@cozypad/contracts';
import { TMUX_TARGET_VERSION } from '@cozypad/contracts';
import type { RemoteExec } from './runtime';

const REQUIRED_TOOLS = ['curl', 'make', 'cc'];

/** tmux 版本字串如 "3.5a"、"3.4"；比較主版、次版，再比字尾字母。 */
export function compareTmuxVersions(a: string, b: string): number {
  const parse = (value: string): [number, number, string] => {
    const match = /^(\d+)(?:\.(\d+))?([a-z]?)/.exec(value.trim());
    if (!match) return [0, 0, ''];
    return [Number(match[1]), Number(match[2] ?? 0), match[3] ?? ''];
  };
  const [aMajor, aMinor, aSuffix] = parse(a);
  const [bMajor, bMinor, bSuffix] = parse(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aSuffix.localeCompare(bSuffix);
}

export function parseTmuxVersion(output: string): string | null {
  const match = /tmux\s+(?:next-)?(\d+\.\d+[a-z]?)/i.exec(output);
  return match ? match[1]! : null;
}

/** 偵測遠端 tmux：優先使用者層級（~/.local/bin），其次 PATH。 */
export async function detectTmux(exec: RemoteExec): Promise<TmuxStatus> {
  const command = `user_bin="$HOME/.local/bin/tmux"
if [ -x "$user_bin" ]; then
  printf '__PATH__\\t%s\\n' "$user_bin"
  printf '__VERSION__\\t%s\\n' "$("$user_bin" -V 2>/dev/null || echo '')"
elif command -v tmux >/dev/null 2>&1; then
  printf '__PATH__\\t%s\\n' "$(command -v tmux)"
  printf '__VERSION__\\t%s\\n' "$(tmux -V 2>/dev/null || echo '')"
else
  printf '__PATH__\\t\\n__VERSION__\\t\\n'
fi
for tool in ${REQUIRED_TOOLS.join(' ')}; do
  command -v "$tool" >/dev/null 2>&1 || printf '__MISSING__\\t%s\\n' "$tool"
done
`;
  const output = await exec(command, 8000);
  const pathMatch = /__PATH__\t(.*)/.exec(output);
  const versionMatch = /__VERSION__\t(.*)/.exec(output);
  const missingTools = [...output.matchAll(/__MISSING__\t(\S+)/g)].map((match) => match[1]!);

  const binaryPath = pathMatch?.[1]?.trim() ?? '';
  const version = versionMatch ? parseTmuxVersion(versionMatch[1] ?? '') : null;

  return {
    installed: binaryPath !== '' && version !== null,
    version,
    path: binaryPath === '' ? null : binaryPath,
    userLevel: binaryPath.includes('/.local/bin/'),
    satisfiesTarget:
      version !== null && compareTmuxVersions(version, TMUX_TARGET_VERSION) >= 0,
    targetVersion: TMUX_TARGET_VERSION,
    canInstall: missingTools.length === 0,
    missingTools,
  };
}

/**
 * 使用者層級安裝腳本：不需要 sudo，全部裝進 $HOME/.local。
 * 依序取得 libevent、ncurses、tmux 原始碼，建置後把 ~/.local/bin 併入
 * PATH（寫入 shell rc 的 CozyPad 管理區塊）。
 */
export function buildTmuxInstallScript(version = TMUX_TARGET_VERSION): string {
  const libevent = '2.1.12-stable';
  const ncurses = '6.4';
  return `set -e
PREFIX="$HOME/.local"
SRC="$HOME/.cozypad/src"
mkdir -p "$PREFIX/bin" "$SRC"
cd "$SRC"

echo "__STAGE__\tdownloading\tfetching sources"
fetch() {
  url="$1"; out="$2"
  [ -f "$out" ] || curl -fsSL --retry 3 -o "$out" "$url"
}
fetch "https://github.com/libevent/libevent/releases/download/release-${libevent}/libevent-${libevent}.tar.gz" libevent.tar.gz
fetch "https://ftp.gnu.org/pub/gnu/ncurses/ncurses-${ncurses}.tar.gz" ncurses.tar.gz
fetch "https://github.com/tmux/tmux/releases/download/${version}/tmux-${version}.tar.gz" tmux.tar.gz

echo "__STAGE__\tbuilding\tlibevent"
rm -rf libevent-${libevent} && tar xzf libevent.tar.gz
cd libevent-${libevent}
./configure --prefix="$PREFIX" --disable-shared --disable-openssl >/dev/null
make -j"$(nproc 2>/dev/null || echo 2)" >/dev/null && make install >/dev/null
cd "$SRC"

echo "__STAGE__\tbuilding\tncurses"
rm -rf ncurses-${ncurses} && tar xzf ncurses.tar.gz
cd ncurses-${ncurses}
./configure --prefix="$PREFIX" --with-shared --with-termlib --enable-pc-files \\
  --with-pkg-config-libdir="$PREFIX/lib/pkgconfig" --without-ada --without-manpages >/dev/null
make -j"$(nproc 2>/dev/null || echo 2)" >/dev/null && make install >/dev/null
cd "$SRC"

echo "__STAGE__\tbuilding\ttmux ${version}"
rm -rf tmux-${version} && tar xzf tmux.tar.gz
cd tmux-${version}
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" \\
  CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncurses" \\
  LDFLAGS="-L$PREFIX/lib" >/dev/null
make -j"$(nproc 2>/dev/null || echo 2)" >/dev/null && make install >/dev/null

echo "__STAGE__\tinstalling\tupdating PATH"
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q '# >>> cozypad path >>>' "$rc" && continue
  printf '\\n# >>> cozypad path >>>\\nexport PATH="$HOME/.local/bin:$PATH"\\n# <<< cozypad path <<<\\n' >> "$rc"
done

echo "__STAGE__\tverifying\trunning a throwaway session"
export PATH="$PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib:\${LD_LIBRARY_PATH:-}"
"$PREFIX/bin/tmux" -V
"$PREFIX/bin/tmux" new-session -d -s cozypad_verify 'sleep 5'
"$PREFIX/bin/tmux" has-session -t cozypad_verify
"$PREFIX/bin/tmux" kill-session -t cozypad_verify
echo "__STAGE__\tdone\ttmux ready"
`;
}

export interface InstallStageEvent {
  stage: string;
  message: string;
}

export function parseInstallStages(output: string): InstallStageEvent[] {
  return [...output.matchAll(/__STAGE__\t(\S+)\t(.*)/g)].map((match) => ({
    stage: match[1]!,
    message: match[2]!.trim(),
  }));
}
