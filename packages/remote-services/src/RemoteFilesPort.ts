import type { DirectoryListing } from '@cozypad/contracts';

/** 遠端檔案操作抽象：shell-over-SSH 與 mock 各自實作。 */
export interface RemoteFilesPort {
  list(path: string, signal?: AbortSignal): Promise<DirectoryListing>;
  readText(path: string, maxBytes: number, offset: number, signal?: AbortSignal): Promise<string>;
  readBytes(path: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
  write(path: string, contentBase64: string, maxBytes?: number, signal?: AbortSignal): Promise<void>;
  create(directory: string, name: string, kind: 'file' | 'directory', signal?: AbortSignal): Promise<void>;
  rename(path: string, newName: string, signal?: AbortSignal): Promise<void>;
  duplicate(path: string, signal?: AbortSignal): Promise<string>;
  copyTo(sourcePath: string, destinationDirectory: string, signal?: AbortSignal): Promise<string>;
  moveTo(sourcePath: string, destinationDirectory: string, signal?: AbortSignal): Promise<string>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
}
