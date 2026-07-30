import type { TmuxStatus } from '@cozypad/contracts';
import { TMUX_TARGET_VERSION } from '@cozypad/contracts';
import type { RemoteExec } from './runtime';

/**
 * 從原始碼建置 tmux 實際需要的工具。
 * yacc/bison 與 pkg-config 是最常見的缺件——沒檢查就會在 configure 階段才炸。
 */
const REQUIRED_TOOLS = ['curl', 'tar', 'make', 'cc', 'pkg-config'];
/** 這些是等價選項，只要其中一個存在即可。 */
const REQUIRED_ANY = [['yacc', 'bison', 'byacc']];

export const TMUX_INSTALL_LOG = '$HOME/.cozypad/tmux-install.log';
/** 建置暫存目錄；安裝成功後預設清除，避免在使用者主機留下數百 MB。 */
export const TMUX_BUILD_DIR = '$HOME/.cozypad/src';

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
  const anyChecks = REQUIRED_ANY.map(
    (group) =>
      `if ${group.map((tool) => `! command -v ${tool} >/dev/null 2>&1`).join(' && ')}; then printf '__MISSING__\\t%s\\n' '${group.join('/')}'; fi`,
  ).join('\n');

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
${anyChecks}
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
 *
 * 與前一版的差異（皆為除錯性）：
 * - 每個步驟輸出 `__STAGE__ stage percent message`，配合 execStream 即時顯示進度
 * - 所有建置輸出寫入 log 檔而非丟棄，失敗時回傳最後 40 行
 * - 任一步驟失敗會標明是哪個階段失敗，而不是靜默結束
 * - 成功後清除建置暫存（數百 MB），不在使用者主機留垃圾
 */
export function buildTmuxInstallScript(
  version = TMUX_TARGET_VERSION,
  options: { keepBuildDir?: boolean } = {},
): string {
  const libevent = '2.1.12-stable';
  const ncurses = '6.4';
  return `PREFIX="$HOME/.local"
SRC="${TMUX_BUILD_DIR}"
LOG="${TMUX_INSTALL_LOG}"
mkdir -p "$PREFIX/bin" "$SRC" "$(dirname "$LOG")"
: > "$LOG"
cd "$SRC"

stage() { printf '__STAGE__\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }
fail() {
  printf '__FAILED__\\t%s\\n' "$1"
  printf '__LOG_TAIL__\\n'
  tail -n 40 "$LOG" 2>/dev/null
  exit 1
}
run() { # run <描述> <指令...>
  desc="$1"; shift
  printf '\\n=== %s ===\\n' "$desc" >> "$LOG"
  "$@" >> "$LOG" 2>&1 || fail "$desc"
}

stage downloading 3 "下載 libevent"
[ -f libevent.tar.gz ] || run "download libevent" curl -fsSL --retry 3 -o libevent.tar.gz \\
  "https://github.com/libevent/libevent/releases/download/release-${libevent}/libevent-${libevent}.tar.gz"
stage downloading 7 "下載 ncurses"
[ -f ncurses.tar.gz ] || run "download ncurses" curl -fsSL --retry 3 -o ncurses.tar.gz \\
  "https://ftp.gnu.org/pub/gnu/ncurses/ncurses-${ncurses}.tar.gz"
stage downloading 11 "下載 tmux ${version}"
[ -f tmux.tar.gz ] || run "download tmux" curl -fsSL --retry 3 -o tmux.tar.gz \\
  "https://github.com/tmux/tmux/releases/download/${version}/tmux-${version}.tar.gz"

JOBS="$(nproc 2>/dev/null || echo 2)"

stage building 14 "解壓 libevent"
rm -rf libevent-${libevent}
run "extract libevent" tar xzf libevent.tar.gz
cd libevent-${libevent}
stage building 18 "設定 libevent"
run "configure libevent" ./configure --prefix="$PREFIX" --disable-shared --disable-openssl --disable-samples
stage building 24 "編譯 libevent（約 1-2 分鐘）"
run "make libevent" make -j"$JOBS"
stage building 33 "安裝 libevent"
run "install libevent" make install
cd "$SRC"

stage building 36 "解壓 ncurses"
rm -rf ncurses-${ncurses}
run "extract ncurses" tar xzf ncurses.tar.gz
cd ncurses-${ncurses}
stage building 40 "設定 ncurses"
run "configure ncurses" ./configure --prefix="$PREFIX" --with-shared --with-termlib \\
  --enable-pc-files --with-pkg-config-libdir="$PREFIX/lib/pkgconfig" \\
  --without-ada --without-manpages --without-tests
stage building 48 "編譯 ncurses（最久，約 2-5 分鐘）"
run "make ncurses" make -j"$JOBS"
stage building 68 "安裝 ncurses"
run "install ncurses" make install
cd "$SRC"

stage building 72 "解壓 tmux"
rm -rf tmux-${version}
run "extract tmux" tar xzf tmux.tar.gz
cd tmux-${version}
stage building 76 "設定 tmux"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" run "configure tmux" ./configure --prefix="$PREFIX" \\
  CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncurses" \\
  LDFLAGS="-L$PREFIX/lib" \\
  LIBEVENT_CFLAGS="-I$PREFIX/include" LIBEVENT_LIBS="-L$PREFIX/lib -levent"
stage building 82 "編譯 tmux（約 1-2 分鐘）"
run "make tmux" make -j"$JOBS"
stage installing 90 "安裝 tmux"
run "install tmux" make install
cd "$SRC"

stage installing 93 "設定 PATH"
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q '# >>> cozypad path >>>' "$rc" && continue
  printf '\\n# >>> cozypad path >>>\\nexport PATH="$HOME/.local/bin:$PATH"\\n# <<< cozypad path <<<\\n' >> "$rc"
done

stage verifying 96 "驗證 tmux 可實際啟動 session"
export PATH="$PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib:\${LD_LIBRARY_PATH:-}"
run "tmux -V" "$PREFIX/bin/tmux" -V
run "start test session" "$PREFIX/bin/tmux" new-session -d -s cozypad_verify 'sleep 5'
run "check test session" "$PREFIX/bin/tmux" has-session -t cozypad_verify
run "kill test session" "$PREFIX/bin/tmux" kill-session -t cozypad_verify
${
  options.keepBuildDir === true
    ? 'stage verifying 99 "保留建置暫存"'
    : `stage verifying 99 "清除建置暫存"
cd "$HOME"
rm -rf "$SRC"`
}
stage done 100 "tmux ${version} 已就緒"
`;
}

export interface InstallStageEvent {
  stage: string;
  percent: number;
  message: string;
}

export function parseInstallStages(output: string): InstallStageEvent[] {
  return [...output.matchAll(/__STAGE__\t(\S+)\t(\d+)\t(.*)/g)].map((match) => ({
    stage: match[1]!,
    percent: Number(match[2]),
    message: match[3]!.trim(),
  }));
}

export interface InstallFailure {
  step: string;
  logTail: string;
}

/** 從輸出擷取失敗步驟與 log 尾巴（腳本以 __FAILED__ / __LOG_TAIL__ 標記）。 */
export function parseInstallFailure(output: string): InstallFailure | null {
  const failed = /__FAILED__\t(.*)/.exec(output);
  if (!failed) return null;
  const tailIndex = output.indexOf('__LOG_TAIL__');
  return {
    step: failed[1]!.trim(),
    logTail: tailIndex >= 0 ? output.slice(tailIndex + '__LOG_TAIL__'.length).trim() : '',
  };
}

/** 移除 CozyPad 在遠端主機留下的所有痕跡（建置暫存、PATH 區塊、tmux 設定區塊）。 */
export function buildRemoteCleanupScript(options: { removeTmuxBinary: boolean }): string {
  return `removed=""
if [ -d "${TMUX_BUILD_DIR}" ]; then
  rm -rf "${TMUX_BUILD_DIR}" && removed="$removed build-cache"
fi
rm -f "${TMUX_INSTALL_LOG}"
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.tmux.conf"; do
  [ -f "$rc" ] || continue
  if grep -q '# >>> cozypad' "$rc"; then
    tmp="$(mktemp)"
    awk 'BEGIN{skip=0}
         /^# >>> cozypad (managed|path) >>>$/{skip=1}
         skip==0{print}
         /^# <<< cozypad (managed|path) <<<$/{skip=0}' "$rc" > "$tmp"
    mv -- "$tmp" "$rc" && removed="$removed $(basename "$rc")"
  fi
done
${
  options.removeTmuxBinary
    ? `if [ -x "$HOME/.local/bin/tmux" ]; then
  rm -f "$HOME/.local/bin/tmux" && removed="$removed tmux-binary"
fi`
    : ''
}
rmdir "$HOME/.cozypad" 2>/dev/null || true
printf '__CLEANED__\\t%s\\n' "$removed"
`;
}
