export type WatchedFolderHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};
export function folderFileId(file: File): string;
export function chooseWatchedFolder(id: string): Promise<{ handle: WatchedFolderHandle } | { files: File[] } | null>;
export function folderPermission(handle: WatchedFolderHandle): Promise<PermissionState>;
export function requestFolderAccess(handle: WatchedFolderHandle): Promise<PermissionState>;
export function watchFolder(handle: WatchedFolderHandle, options: {
  offer: (files: File[], tried: (file: File) => void) => Promise<void> | void;
  lost: (error: unknown) => void;
  interval?: number;
}): { look: () => Promise<void>; stop: () => void; name: string; forget: () => void };
