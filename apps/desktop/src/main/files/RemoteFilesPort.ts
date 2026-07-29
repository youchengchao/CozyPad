import type { DirectoryListing } from '@cozypad/contracts';

/** 遠端檔案操作抽象：shell-over-SSH 與 mock 各自實作。 */
export interface RemoteFilesPort {
  list(path: string): Promise<DirectoryListing>;
  readText(path: string, maxBytes: number, offset: number): Promise<string>;
  readBytes(path: string): Promise<string>;
  write(path: string, contentBase64: string): Promise<void>;
  create(directory: string, name: string, kind: 'file' | 'directory'): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  duplicate(path: string): Promise<string>;
  copyTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  moveTo(sourcePath: string, destinationDirectory: string): Promise<string>;
  remove(path: string): Promise<void>;
}
