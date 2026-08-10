export interface FileBreadcrumb {
  label: string;
  path: string;
}

export interface FileLocation {
  path: string;
  line?: number;
}

export function normalizeFilePath(input: string): string {
  const normalized = input.replace(/\\/gu, '/');
  if (/^\/+$/u.test(normalized)) return '/';
  if (/^[A-Za-z]:\/?$/u.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/u, '');
}

export function parentFilePath(input: string): string {
  const path = normalizeFilePath(input);
  if (path === '/' || /^[A-Za-z]:\/$/u.test(path)) return path;
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  if (index === 2 && /^[A-Za-z]:/u.test(path)) return `${path.slice(0, 2)}/`;
  return path.slice(0, index);
}

export function isFileSystemRoot(input: string): boolean {
  const path = normalizeFilePath(input);
  return path === '/' || /^[A-Za-z]:\/$/u.test(path);
}

export function filePathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeFilePath(left);
  const normalizedRight = normalizeFilePath(right);
  if (/^[A-Za-z]:\//u.test(normalizedLeft) && /^[A-Za-z]:\//u.test(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
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

/** Return only the listing for the active directory, never a root-anchored recursive tree. */
export function directoryItems<T>(
  cache: Readonly<Record<string, readonly T[]>>,
  currentPath: string,
): readonly T[] | undefined {
  return cache[currentPath];
}

export function buildFileBreadcrumbs(path: string): FileBreadcrumb[] {
  if (!path.startsWith('/')) return [];
  const segments = path.split('/').filter((segment) => segment !== '');
  const crumbs: FileBreadcrumb[] = [{ label: '/', path: '/' }];
  let accumulated = '';
  for (const segment of segments) {
    accumulated += `/${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}
