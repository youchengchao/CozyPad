import type { DirectoryListing, RemoteFileItem } from '@cozypad/contracts';
import { quoteShellArg } from '@cozypad/contracts';
import type { RemoteFilesPort } from './RemoteFilesPort';

export type RemoteExec = (command: string, timeoutMs?: number) => Promise<string>;

export { quoteShellArg };

function throwOnErrorMarker(output: string, fallback: string): string {
  if (output.startsWith('__ERROR__')) {
    const parts = output.split('\t');
    throw new Error(parts.length > 1 ? parts[1]!.trim() : fallback);
  }
  return output;
}

/**
 * 與 Flutter 版（lib/providers/ssh_provider.dart）相同的 shell-over-SSH 檔案操作：
 * POSIX 腳本、in-band __ERROR__ 標記、原子寫入（mktemp + mv）、刪除防呆。
 */
export class ShellRemoteFiles implements RemoteFilesPort {
  /** 單一目錄最多回傳的項目數；超過即截斷並標記。 */
  static readonly ENTRY_LIMIT = 2000;

  constructor(private readonly exec: RemoteExec) {}

  /**
   * 單層列目錄（`-maxdepth 1`），不遞迴、不掛 file watcher——這是不會像
   * VS Code 那樣燒遠端 CPU 的原因。大目錄以 ENTRY_LIMIT 截斷，避免傳輸爆量。
   */
  async list(path: string): Promise<DirectoryListing> {
    const target = path.trim() === '' ? '~' : path.trim();
    const command = `target=${quoteShellArg(target)}
case "$target" in
  '~') target="$HOME" ;;
  '~/'*) target="$HOME/\${target#~/}" ;;
esac
if [ ! -d "$target" ]; then
  echo "__ERROR__\tNot a directory: $target"
  exit 1
fi
cd "$target" 2>/dev/null || { echo "__ERROR__\tPermission denied: $target"; exit 1; }
printf "__PWD__\\t%s\\n" "$(pwd -P)"
find . -maxdepth 1 -mindepth 1 \\
  -printf '%y\\t%f\\t%s\\t%TY-%Tm-%Td %TH:%TM\\t%Y\\t%l\\t%m\\n' 2>/dev/null \\
  | sort -t"$(printf '\\t')" -k1,1 -k2,2 | head -n ${ShellRemoteFiles.ENTRY_LIMIT + 1}
`;
    const output = await this.exec(command, 10000);

    let resolvedPath = target;
    const items: RemoteFileItem[] = [];
    for (const rawLine of output.split('\n')) {
      if (rawLine.trim() === '') continue;
      const parts = rawLine.split('\t');
      if (parts[0] === '__PWD__' && parts.length >= 2) {
        resolvedPath = parts[1]!;
        continue;
      }
      if (parts[0] === '__ERROR__') {
        throw new Error(parts.length >= 2 ? parts[1]! : 'Directory error');
      }
      if (parts.length < 4) continue;
      const name = parts[1]!;
      if (name === '.' || name === '..') continue;
      const linkTarget = parts[5] ?? '';
      const mode = parts[6] ?? '';
      items.push({
        name,
        path: resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`,
        type: parts[0]!,
        sizeBytes: Number.parseInt(parts[2]!, 10) || 0,
        modified: parts[3]!,
        ...(linkTarget === '' ? {} : { linkTarget }),
        ...(parts[4] === undefined || parts[4] === '' ? {} : { targetType: parts[4] }),
        executable: /[1357]/.test(mode.slice(-3)),
      });
    }

    const truncated = items.length > ShellRemoteFiles.ENTRY_LIMIT;
    const capped = truncated ? items.slice(0, ShellRemoteFiles.ENTRY_LIMIT) : items;

    capped.sort((a, b) => {
      const aDir = a.type === 'd' || (a.type === 'l' && a.targetType === 'd');
      const bDir = b.type === 'd' || (b.type === 'l' && b.targetType === 'd');
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return { path: resolvedPath, items: capped, truncated };
  }

  async readText(path: string, maxBytes: number, offset: number): Promise<string> {
    const command = `target=${quoteShellArg(path)}
if [ ! -f "$target" ]; then
  echo "Not a regular file: $target"
  exit 1
fi
size=$(wc -c < "$target" 2>/dev/null || echo 0)
tail -c +${offset + 1} "$target" | head -c ${maxBytes}
if [ "$size" -gt ${offset + maxBytes} ]; then
  printf "\\n\\n[Preview truncated: showing bytes ${offset + 1} to ${offset + maxBytes} of %s bytes]" "$size"
fi
`;
    return this.exec(command, 8000);
  }

  async readBytes(path: string, maxBytes = 12 * 1024 * 1024): Promise<string> {
    const command = `target=${quoteShellArg(path)}
if [ ! -f "$target" ]; then
  echo "__ERROR__\tNot a regular file: $target"
  exit 1
fi
size=$(wc -c < "$target" 2>/dev/null || echo 0)
if [ "$size" -gt ${maxBytes} ]; then
  echo "__TOO_LARGE__\t$size\t${maxBytes}"
  exit 2
fi
if base64 --help 2>&1 | grep -q -- '-w'; then
  base64 -w 0 "$target"
else
  base64 "$target" | tr -d '\\n'
fi
`;
    const output = (await this.exec(command, 35000)).trim();
    if (output.startsWith('__TOO_LARGE__')) {
      const parts = output.split('\t');
      throw new Error(
        `File is too large for download (${parts[1] ?? 'unknown'} bytes, limit ${parts[2] ?? maxBytes} bytes).`,
      );
    }
    throwOnErrorMarker(output, 'Read failed.');
    return output;
  }

  async write(path: string, contentBase64: string, maxBytes = 1024 * 1024): Promise<void> {
    const approximateBytes = Math.floor((contentBase64.length * 3) / 4);
    if (approximateBytes > maxBytes) {
      throw new Error(
        `File is too large to save from inline editor (${approximateBytes} bytes, limit ${maxBytes} bytes).`,
      );
    }
    const command = `target=${quoteShellArg(path)}
payload=${quoteShellArg(contentBase64)}
case "$target" in
  '~') target="$HOME" ;;
  '~/'*) target="$HOME/\${target#~/}" ;;
esac
if [ -z "$target" ] || [ -d "$target" ]; then
  echo "__ERROR__\tTarget is not a regular file path: $target"
  exit 1
fi
dir="$(dirname -- "$target")"
base="$(basename -- "$target")"
if [ ! -d "$dir" ]; then
  echo "__ERROR__\tParent directory does not exist: $dir"
  exit 1
fi
if [ -e "$target" ] && [ ! -f "$target" ]; then
  echo "__ERROR__\tTarget exists but is not a regular file: $target"
  exit 1
fi
tmp="$(mktemp "$dir/.$base.tmp.XXXXXX")" || {
  echo "__ERROR__\tUnable to create temp file in $dir"
  exit 1
}
if ! printf "%s" "$payload" | base64 -d > "$tmp" 2>/dev/null; then
  rm -f -- "$tmp"
  echo "__ERROR__\tUnable to decode edited content on remote host."
  exit 1
fi
if [ -e "$target" ]; then
  chmod --reference="$target" "$tmp" 2>/dev/null || true
fi
if ! mv -- "$tmp" "$target"; then
  rm -f -- "$tmp"
  echo "__ERROR__\tSave failed. Check permissions and available disk space."
  exit 1
fi
`;
    throwOnErrorMarker(await this.exec(command, 30000), 'Save failed.');
  }

  async create(directory: string, name: string, kind: 'file' | 'directory'): Promise<void> {
    if (name.includes('/')) throw new Error('Name cannot contain /.');
    const makeCommand = kind === 'file' ? ': > "$target"' : 'mkdir "$target"';
    const command = `dir=${quoteShellArg(directory)}
name=${quoteShellArg(name)}
case "$dir" in
  '~') dir="$HOME" ;;
  '~/'*) dir="$HOME/\${dir#~/}" ;;
esac
if [ ! -d "$dir" ]; then
  echo "__ERROR__\tNot a directory: $dir"
  exit 1
fi
target="$dir/$name"
if [ -e "$target" ]; then
  echo "__ERROR__\tAlready exists: $target"
  exit 1
fi
if ! ${makeCommand}; then
  echo "__ERROR__\tCreate failed. Check permissions."
  exit 1
fi
`;
    throwOnErrorMarker(await this.exec(command, 8000), 'Create failed.');
  }

  async rename(path: string, newName: string): Promise<void> {
    if (newName.trim() === '' || newName.includes('/')) {
      throw new Error('New name cannot be empty or contain /.');
    }
    const command = `src=${quoteShellArg(path)}
dir=$(dirname -- "$src")
if [ -e "$dir"/${quoteShellArg(newName.trim())} ]; then
  echo "__ERROR__\tDestination already exists: ${newName.trim()}"
  exit 1
fi
if ! mv -- "$src" "$dir"/${quoteShellArg(newName.trim())}; then
  echo "__ERROR__\tRename failed. Check permissions."
  exit 1
fi
`;
    throwOnErrorMarker(await this.exec(command, 8000), 'Rename failed.');
  }

  async duplicate(path: string): Promise<string> {
    const command = `src=${quoteShellArg(path)}
dir=$(dirname -- "$src")
base=$(basename -- "$src")
dest="$dir/\${base}_copy"
if [ -e "$dest" ]; then
  dest="$dir/\${base}_copy_$(date +%Y%m%d_%H%M%S)"
fi
if ! cp -a -- "$src" "$dest"; then
  echo "__ERROR__\tCopy failed. Check permissions and available disk space."
  exit 1
fi
printf "%s" "$dest"
`;
    return throwOnErrorMarker(await this.exec(command, 30000), 'Copy failed.').trim();
  }

  async copyTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    const destination =
      destinationDirectory.trim() === '' ? '~' : destinationDirectory.trim();
    const command = `src=${quoteShellArg(sourcePath)}
dest_dir=${quoteShellArg(destination)}
case "$dest_dir" in
  '~') dest_dir="$HOME" ;;
  '~/'*) dest_dir="$HOME/\${dest_dir#~/}" ;;
esac
if [ ! -e "$src" ]; then
  echo "__ERROR__\tSource does not exist: $src"
  exit 1
fi
if [ ! -d "$dest_dir" ]; then
  echo "__ERROR__\tDestination is not a directory: $dest_dir"
  exit 1
fi
dest_dir="$(cd "$dest_dir" && pwd -P)"
base="$(basename -- "$src")"
candidate="$dest_dir/$base"
if [ -e "$candidate" ]; then
  stem="$base"
  ext=""
  case "$base" in
    *.*) stem="\${base%.*}"; ext=".\${base##*.}" ;;
  esac
  i=1
  while [ -e "$dest_dir/\${stem}_copy$i$ext" ]; do
    i=$((i + 1))
  done
  candidate="$dest_dir/\${stem}_copy$i$ext"
fi
if ! cp -a -- "$src" "$candidate"; then
  echo "__ERROR__\tCopy failed. Check permissions and available disk space."
  exit 1
fi
printf "%s" "$candidate"
`;
    return throwOnErrorMarker(await this.exec(command, 120000), 'Copy failed.').trim();
  }

  async moveTo(sourcePath: string, destinationDirectory: string): Promise<string> {
    const destination =
      destinationDirectory.trim() === '' ? '~' : destinationDirectory.trim();
    const command = `src=${quoteShellArg(sourcePath)}
dest_dir=${quoteShellArg(destination)}
case "$dest_dir" in
  '~') dest_dir="$HOME" ;;
  '~/'*) dest_dir="$HOME/\${dest_dir#~/}" ;;
esac
if [ ! -e "$src" ]; then
  echo "__ERROR__\tSource does not exist: $src"
  exit 1
fi
if [ ! -d "$dest_dir" ]; then
  echo "__ERROR__\tDestination is not a directory: $dest_dir"
  exit 1
fi
dest_dir="$(cd "$dest_dir" && pwd -P)"
base="$(basename -- "$src")"
candidate="$dest_dir/$base"
if [ "$src" = "$candidate" ]; then
  echo "__ERROR__\tSource is already in this folder."
  exit 1
fi
if [ -e "$candidate" ]; then
  echo "__ERROR__\tDestination already exists: $candidate"
  exit 1
fi
if ! mv -- "$src" "$candidate"; then
  echo "__ERROR__\tMove failed. Check permissions."
  exit 1
fi
printf "%s" "$candidate"
`;
    return throwOnErrorMarker(await this.exec(command, 45000), 'Move failed.').trim();
  }

  async remove(path: string): Promise<void> {
    const command = `target=${quoteShellArg(path)}
if [ -z "$target" ] || [ "$target" = "/" ]; then
  echo "__ERROR__\tRefusing to delete root or empty path."
  exit 1
fi
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  echo "__ERROR__\tPath does not exist: $target"
  exit 1
fi
target_real="$(readlink -f -- "$target" 2>/dev/null || printf "%s" "$target")"
home_real="$(readlink -f -- "$HOME" 2>/dev/null || printf "%s" "$HOME")"
if [ "$target_real" = "/" ] || [ "$target_real" = "$home_real" ]; then
  echo "__ERROR__\tRefusing to delete root or home directory."
  exit 1
fi
if ! rm -rf -- "$target"; then
  echo "__ERROR__\tDelete failed. Check permissions."
  exit 1
fi
`;
    throwOnErrorMarker(await this.exec(command, 45000), 'Delete failed.');
  }
}
