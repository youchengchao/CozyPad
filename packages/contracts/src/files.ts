import { z } from 'zod';

/** `find -printf '%y'` 的檔案類型：d=目錄、f=一般檔案、l=symlink、其餘照原字元。 */
export const RemoteFileItemSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  modified: z.string(),
});
export type RemoteFileItem = z.infer<typeof RemoteFileItemSchema>;

export const DirectoryListingSchema = z.object({
  path: z.string().min(1),
  items: z.array(RemoteFileItemSchema),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const FsPathRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsPathRequest = z.infer<typeof FsPathRequestSchema>;

export const FsReadRequestSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().default(262144),
  offset: z.number().int().min(0).default(0),
});
export type FsReadRequest = z.infer<typeof FsReadRequestSchema>;

export const FsWriteRequestSchema = z.object({
  path: z.string().min(1),
  contentBase64: z.string(),
});
export type FsWriteRequest = z.infer<typeof FsWriteRequestSchema>;

export const FsCreateRequestSchema = z.object({
  directory: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['file', 'directory']),
});
export type FsCreateRequest = z.infer<typeof FsCreateRequestSchema>;

export const FsRenameRequestSchema = z.object({
  path: z.string().min(1),
  newName: z.string().min(1),
});
export type FsRenameRequest = z.infer<typeof FsRenameRequestSchema>;

export const FsTransferRequestSchema = z.object({
  sourcePath: z.string().min(1),
  destinationDirectory: z.string().min(1),
});
export type FsTransferRequest = z.infer<typeof FsTransferRequestSchema>;

export const FsContentSchema = z.object({
  content: z.string(),
});
export type FsContent = z.infer<typeof FsContentSchema>;

export const FsBytesSchema = z.object({
  dataBase64: z.string(),
});
export type FsBytes = z.infer<typeof FsBytesSchema>;

export const FsPathResultSchema = z.object({
  path: z.string().min(1),
});
export type FsPathResult = z.infer<typeof FsPathResultSchema>;
