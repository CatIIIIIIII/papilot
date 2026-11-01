import { t } from './i18n.ts';

export type ImportFile = { file: File; path: string };
export const ignoredImportPath = (name: string) => name.split('/').some(part => ['.git', '__macosx', '.ds_store', 'node_modules', '.papilot'].includes(part.toLowerCase()) || part.startsWith('._'));
export function checkUpload(count: number, bytes: number) {
  if (count > 5000 || bytes > 64 * 1024 * 1024) throw new Error(t('Choose up to 5,000 files, totaling less than 64 MB.'));
}

// Browsers upload copies. Desktop directory drops bypass this traversal and
// send the original directory path instead.
export async function droppedFolder(entry: FileSystemDirectoryEntry): Promise<ImportFile[]> {
  const files: ImportFile[] = [], pending: FileSystemEntry[] = [entry];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!, name = item.fullPath.replace(/^\//, '');
    if (ignoredImportPath(name)) continue;
    if (item.isDirectory) {
      const reader = (item as FileSystemDirectoryEntry).createReader();
      // Chromium returns directory entries in batches, not all at once.
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        pending.push(...batch);
      }
    } else if (item.isFile) {
      const file = await new Promise<File>((resolve, reject) => (item as FileSystemFileEntry).file(resolve, reject));
      bytes += file.size; checkUpload(files.length + 1, bytes);
      files.push({ file, path: name });
    }
  }
  return files;
}
