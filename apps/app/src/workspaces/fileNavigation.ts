export interface FileBreadcrumb {
  label: string;
  path: string;
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
