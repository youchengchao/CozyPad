export interface FileBreadcrumb {
  label: string;
  path: string;
}

export interface FileLocation {
  path: string;
  line?: number;
}

interface ParsedFilePath {
  root: string;
  segments: string[];
  absolute: boolean;
  caseInsensitive: boolean;
}

function parseFilePath(input: string): ParsedFilePath {
  const slashPath = input.replace(/\\/gu, '/');
  let root = '';
  let rest = slashPath;
  let absolute = false;
  let caseInsensitive = false;

  const drive = /^([A-Za-z]):(?:\/+|$)/u.exec(slashPath);
  const unc = /^\/{2,}([^/]+)\/+([^/]+)(?:\/+|$)/u.exec(slashPath);
  if (drive !== null) {
    root = `${drive[1]!.toUpperCase()}:/`;
    rest = slashPath.slice(drive[0].length);
    absolute = true;
    caseInsensitive = true;
  } else if (unc !== null) {
    root = `//${unc[1]!}/${unc[2]!}`;
    rest = slashPath.slice(unc[0].length);
    absolute = true;
    caseInsensitive = true;
  } else if (slashPath.startsWith('/')) {
    root = '/';
    rest = slashPath.replace(/^\/+/, '');
    absolute = true;
  }

  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { root, segments, absolute, caseInsensitive };
}

function renderFilePath(parsed: ParsedFilePath): string {
  if (parsed.root === '/') return `/${parsed.segments.join('/')}`;
  if (parsed.root.endsWith('/')) return `${parsed.root}${parsed.segments.join('/')}`;
  if (parsed.root !== '') {
    return parsed.segments.length === 0
      ? parsed.root
      : `${parsed.root}/${parsed.segments.join('/')}`;
  }
  return parsed.segments.join('/');
}

/** Absolute on either host family, independent of the browser's own OS. */
export function isAbsoluteFilePath(input: string): boolean {
  return parseFilePath(input).absolute;
}

export function normalizeFilePath(input: string): string {
  return renderFilePath(parseFilePath(input));
}

export function parentFilePath(input: string): string {
  const parsed = parseFilePath(input);
  if (parsed.segments.length === 0) return renderFilePath(parsed);
  return renderFilePath({ ...parsed, segments: parsed.segments.slice(0, -1) });
}

export function isFileSystemRoot(input: string): boolean {
  const parsed = parseFilePath(input);
  return parsed.absolute && parsed.segments.length === 0;
}

export function filePathsEqual(left: string, right: string): boolean {
  const parsedLeft = parseFilePath(left);
  const parsedRight = parseFilePath(right);
  const normalizedLeft = renderFilePath(parsedLeft);
  const normalizedRight = renderFilePath(parsedRight);
  return parsedLeft.caseInsensitive && parsedRight.caseInsensitive
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Split source-link suffixes such as `file.ts:12:4` and `file.ts#L12`. */
export function parseFileLocation(input: string): FileLocation {
  let path = input;
  let line: number | undefined;
  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    const hash = path.slice(hashIndex + 1);
    path = path.slice(0, hashIndex);
    const match = /^L(\d+)/iu.exec(hash);
    if (match !== null) line = Number(match[1]);
  } else {
    const match = /:(\d+)(?::\d+)?$/u.exec(path);
    if (match !== null) {
      path = path.slice(0, match.index);
      line = Number(match[1]);
    }
  }
  return line === undefined ? { path } : { path, line };
}

function decodeFileReference(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    // A literal '%' in an agent-authored path must not break link handling.
    return input;
  }
}

function fileUriToPath(input: string): string {
  if (!/^file:/iu.test(input)) return input;
  let path = input.slice(5);

  // file://localhost/home/a -> /home/a
  path = path.replace(/^\/\/localhost(?=\/)/iu, '');
  // file:///C:/Users/a -> C:/Users/a, but file:///home/a -> /home/a.
  if (/^\/\/\/[A-Za-z]:[\\/]/u.test(path)) return path.slice(3);
  if (path.startsWith('///')) return path.slice(2);
  // Keep file://server/share as //server/share (UNC).
  return path;
}

/**
 * Resolve a file link from agent Markdown into the host path Files should open.
 * Unlike URL/path helpers supplied by the browser, this deliberately supports
 * Windows and POSIX paths at the same time because the connected host can use
 * a different OS than the device rendering the UI.
 */
export function resolveFileReference(input: string, cwd?: string): FileLocation | null {
  const decoded = decodeFileReference(input.trim());
  if (decoded === '') return null;
  const location = parseFileLocation(decoded);
  let filePath = fileUriToPath(location.path).replace(/\\/gu, '/');

  if (/^\/[A-Za-z]:\//u.test(filePath)) filePath = filePath.slice(1);

  const normalizedCwd = cwd?.replace(/\\/gu, '/');
  // Git/MSYS links use /d/project/file while their session cwd is D:/project.
  const msysMatch = /^\/([A-Za-z])\/(.*)$/u.exec(filePath);
  if (msysMatch !== null && normalizedCwd !== undefined && /^[A-Za-z]:\//u.test(normalizedCwd)) {
    filePath = `${msysMatch[1]!.toUpperCase()}:/${msysMatch[2]!}`;
  }

  if (!isAbsoluteFilePath(filePath)) {
    if (normalizedCwd === undefined || normalizedCwd === '') return null;
    filePath = `${normalizeFilePath(normalizedCwd)}/${filePath}`;
  }

  const path = normalizeFilePath(filePath);
  return location.line === undefined ? { path } : { path, line: location.line };
}

/** Resolve a symlink target without mistaking a Windows drive path for relative. */
export function resolveFileLinkTarget(linkPath: string, target: string): string {
  const normalizedTarget = target.replace(/\\/gu, '/');
  if (isAbsoluteFilePath(normalizedTarget)) return normalizeFilePath(normalizedTarget);
  return normalizeFilePath(`${parentFilePath(linkPath)}/${normalizedTarget}`);
}

/** Return only the listing for the active directory, never a root-anchored recursive tree. */
export function directoryItems<T>(
  cache: Readonly<Record<string, readonly T[]>>,
  currentPath: string,
): readonly T[] | undefined {
  return cache[currentPath];
}

export function buildFileBreadcrumbs(path: string): FileBreadcrumb[] {
  const parsed = parseFilePath(path);
  if (!parsed.absolute) return [];
  const rootLabel = parsed.root === '/'
    ? '/'
    : parsed.root.endsWith('/')
      ? parsed.root.slice(0, -1)
      : parsed.root;
  const crumbs: FileBreadcrumb[] = [{ label: rootLabel, path: parsed.root }];
  for (let index = 0; index < parsed.segments.length; index += 1) {
    crumbs.push({
      label: parsed.segments[index]!,
      path: renderFilePath({ ...parsed, segments: parsed.segments.slice(0, index + 1) }),
    });
  }
  return crumbs;
}
