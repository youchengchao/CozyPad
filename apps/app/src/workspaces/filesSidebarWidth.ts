export const FILES_SIDEBAR_MIN = 180;
export const FILES_SIDEBAR_MAX = 600;
export const FILES_PREVIEW_MIN = 360;
export const FILES_SIDEBAR_DEFAULT = 268;
export const FILES_RESIZE_HANDLE_WIDTH = 4;

export function filesSidebarMaxWidth(containerWidth?: number): number {
  if (containerWidth === undefined || !Number.isFinite(containerWidth)) {
    return FILES_SIDEBAR_MAX;
  }

  const available = containerWidth - FILES_PREVIEW_MIN - FILES_RESIZE_HANDLE_WIDTH;
  return Math.min(FILES_SIDEBAR_MAX, Math.max(FILES_SIDEBAR_MIN, available));
}

export function clampFilesSidebarWidth(width: number, containerWidth?: number): number {
  const safeWidth = Number.isFinite(width) ? width : FILES_SIDEBAR_DEFAULT;
  return Math.max(
    FILES_SIDEBAR_MIN,
    Math.min(filesSidebarMaxWidth(containerWidth), safeWidth),
  );
}
