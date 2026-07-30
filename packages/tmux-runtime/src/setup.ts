import type { TmuxStatus } from '@cozypad/contracts';
import { TMUX_TARGET_VERSION } from '@cozypad/contracts';
import type { RemoteExec } from './runtime';

/**
 * 真正無法繞過的工具——沒有這些就不能從原始碼建置任何東西。
 * yacc/bison 與 pkg-config 刻意不列入：前者缺少時我們順便建置 bison，
 * 後者可用顯式的 CFLAGS/LIBS 取代。
 */
const REQUIRED_TOOLS = ['curl', 'tar', 'make', 'cc'];
/** bison 建置需要 m4；缺 m4 又缺 yacc 才是真的擋住。 */
const REQUIRED_ANY: string[][] = [];

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
# yacc 缺少時我們會自行建置 bison，但那需要 m4；兩者都缺才無解。
if ! command -v yacc >/dev/null 2>&1 && ! command -v bison >/dev/null 2>&1 && ! command -v byacc >/dev/null 2>&1; then
  if command -v m4 >/dev/null 2>&1; then
    printf '__EXTRA_BUILD__\\tbison\\n'
  else
    printf '__MISSING__\\tm4（yacc/bison 亦缺少，無法自行建置）\\n'
  fi
fi
`;
  const output = await exec(command, 8000);
  const pathMatch = /__PATH__\t(.*)/.exec(output);
  const versionMatch = /__VERSION__\t(.*)/.exec(output);
  const missingTools = [...output.matchAll(/__MISSING__\t(\S+)/g)].map((match) => match[1]!);
  const extraBuilds = [...output.matchAll(/__EXTRA_BUILD__\t(\S+)/g)].map(
    (match) => match[1]!,
  );

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
    extraBuilds,
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
  const bison = '3.8.2';
  return `PREFIX="$HOME/.local"
SRC="${TMUX_BUILD_DIR}"
LOG="${TMUX_INSTALL_LOG}"
LOCK_DIR="$HOME/.cozypad/install.lock"
mkdir -p "$PREFIX/bin" "$SRC" "$(dirname "$LOG")"

# 單一安裝程序：重複點擊或多裝置同時安裝會互相破壞建置目錄。
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  other="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    printf '__FAILED__\\t另一個安裝程序正在執行中（pid %s）\\n' "$other"
    exit 1
  fi
  rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR"
fi
echo $$ > "$LOCK_DIR/pid"

: > "$LOG"
cd "$SRC"

stage() { printf '__STAGE__\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }
fail() {
  printf '__FAILED__\\t%s\\n' "$1"
  printf '__LOG_TAIL__\\n'
  tail -n 40 "$LOG" 2>/dev/null
  rm -f "$LOCK_DIR/pid" 2>/dev/null
  rmdir "$LOCK_DIR" 2>/dev/null
  exit 1
}
# 逐行同時輸出到本機 UI（__LOG__）與遠端 log 檔，讓使用者看到真實過程。
run() { # run <描述> <指令...>
  desc="$1"; shift
  printf '__CMD__\\t%s\\n' "$*"
  printf '\\n$ %s\\n' "$*" >> "$LOG"
  rc_file="$SRC/.last_rc"
  rm -f "$rc_file"
  { "$@" 2>&1; echo $? > "$rc_file"; } | while IFS= read -r line; do
    printf '__LOG__\\t%s\\n' "$line"
    printf '%s\\n' "$line" >> "$LOG"
  done
  [ "$(cat "$rc_file" 2>/dev/null || echo 1)" = "0" ] || fail "$desc"
}

stage starting 1 "檢查磁碟空間"
avail_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 1048576 ]; then
  printf '__FAILED__\\t家目錄可用空間不足（%s MB，建置需要約 1 GB）\\n' "$((avail_kb / 1024))"
  exit 1
fi

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

# 遠端沒有 yacc/bison 時自行建置一份（僅供這次建置使用）。
NEED_BISON=0
if ! command -v yacc >/dev/null 2>&1 && ! command -v bison >/dev/null 2>&1 && ! command -v byacc >/dev/null 2>&1; then
  NEED_BISON=1
fi
if [ "$NEED_BISON" = "1" ]; then
  stage downloading 12 "遠端缺少 yacc，下載 bison"
  [ -f bison.tar.gz ] || run "download bison" curl -fsSL --retry 3 -o bison.tar.gz \\
    "https://ftp.gnu.org/gnu/bison/bison-${bison}.tar.gz"
  stage building 14 "解壓 bison"
  rm -rf bison-${bison}
  run "extract bison" tar xzf bison.tar.gz
  cd bison-${bison}
  stage building 16 "設定 bison"
  run "configure bison" ./configure --prefix="$PREFIX"
  stage building 19 "編譯 bison（約 1-3 分鐘）"
  run "make bison" make -j"$JOBS"
  stage building 21 "安裝 bison"
  run "install bison" make install
  cd "$SRC"
  export PATH="$PREFIX/bin:$PATH"
  # YACC 必須是 PATH 可解析的名稱：autoconf 的 AC_CHECK_PROG 會把絕對路徑
  # 再接到各個 PATH 目錄底下尋找，導致永遠找不到。
  export YACC="bison -y"
  run "verify bison" command -v bison
fi

stage building 23 "解壓 libevent"
rm -rf libevent-${libevent}
run "extract libevent" tar xzf libevent.tar.gz
cd libevent-${libevent}
stage building 26 "設定 libevent"
run "configure libevent" ./configure --prefix="$PREFIX" --disable-shared --disable-openssl --disable-samples
stage building 30 "編譯 libevent（約 1-2 分鐘）"
run "make libevent" make -j"$JOBS"
stage building 34 "安裝 libevent"
run "install libevent" make install
cd "$SRC"

stage building 36 "解壓 ncurses"
rm -rf ncurses-${ncurses}
run "extract ncurses" tar xzf ncurses.tar.gz
cd ncurses-${ncurses}
stage building 40 "設定 ncurses"
# --enable-widec 才會產生 libncursesw（CJK 寬字元與 UTF-8 必需，也是 tmux 連結的目標）。
# 建成靜態連結，避免 tmux 執行時還要靠 LD_LIBRARY_PATH 才找得到 .so。
run "configure ncurses" ./configure --prefix="$PREFIX" --enable-widec --with-termlib \\
  --without-shared --with-normal \\
  --enable-pc-files --with-pkg-config-libdir="$PREFIX/lib/pkgconfig" \\
  --without-ada --without-manpages --without-tests --without-debug
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
# 顯式提供 libevent/ncurses 旗標，遠端沒有 pkg-config 也能設定成功。
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" run "configure tmux" ./configure --prefix="$PREFIX" \\
  CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw" \\
  LDFLAGS="-L$PREFIX/lib -Wl,-rpath,$PREFIX/lib" \\
  LIBEVENT_CFLAGS="-I$PREFIX/include" LIBEVENT_LIBS="-L$PREFIX/lib -levent" \\
  NCURSES_CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw" \\
  NCURSES_LIBS="-L$PREFIX/lib -lncursesw -ltinfow"
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
# 這裡不設 LD_LIBRARY_PATH：若少了它就跑不動，代表使用者日後直接執行也會失敗。
"$PREFIX/bin/tmux" kill-session -t cozypad_verify 2>/dev/null || true
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
rm -f "$LOCK_DIR/pid" 2>/dev/null
rmdir "$LOCK_DIR" 2>/dev/null
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
