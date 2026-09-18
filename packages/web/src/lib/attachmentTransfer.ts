// Обход DataTransfer с поддержкой папок: webkitGetAsEntry рекурсивно раскрывает
// каталоги в их содержимое, чтобы одно попадание мышью отдало все вложенные файлы.

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  isFile: true;
  isDirectory: false;
  file(onSuccess: (file: File) => void, onError: (err: unknown) => void): void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  isFile: false;
  isDirectory: true;
  createReader(): FileSystemDirectoryReaderLike;
}

interface FileSystemDirectoryReaderLike {
  readEntries(
    onSuccess: (entries: FileSystemEntryLike[]) => void,
    onError: (err: unknown) => void,
  ): void;
}

function readEntryAsFile(entry: FileSystemFileEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

function readDirectory(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(all);
            return;
          }
          all.push(...entries);
          readBatch();
        },
        () => resolve(all),
      );
    };
    readBatch();
  });
}

async function walkEntry(entry: FileSystemEntryLike | null): Promise<File[]> {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await readEntryAsFile(entry as FileSystemFileEntryLike);
    return file ? [file] : [];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntryLike).createReader();
    const children = await readDirectory(reader);
    const nested = await Promise.all(children.map((c) => walkEntry(c)));
    return nested.flat();
  }
  return [];
}

interface DataTransferItemLike {
  kind: string;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
  getAsFile?: () => File | null;
}

export async function traverseDataTransferItems(
  items: ArrayLike<DataTransferItemLike>,
): Promise<File[]> {
  const out: File[] = [];
  const list = Array.from(items as ArrayLike<DataTransferItemLike>);
  for (const item of list) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      const files = await walkEntry(entry);
      out.push(...files);
      continue;
    }
    const fallback = item.getAsFile?.();
    if (fallback) out.push(fallback);
  }
  return out;
}

interface DataTransferLike {
  items?: ArrayLike<DataTransferItemLike> | null;
  files?: ArrayLike<File> | null;
}

export async function readDroppedFiles(dataTransfer: DataTransferLike): Promise<File[]> {
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    const sample = (items as ArrayLike<DataTransferItemLike>)[0];
    if (sample && typeof sample.webkitGetAsEntry === "function") {
      return traverseDataTransferItems(items);
    }
  }
  const files = dataTransfer.files;
  if (!files) return [];
  return Array.from(files as ArrayLike<File>);
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

export function summarizeAttachments(files: { size: number }[]): string {
  const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return `${files.length} file${files.length === 1 ? "" : "s"} · ${formatAttachmentSize(total)}`;
}
