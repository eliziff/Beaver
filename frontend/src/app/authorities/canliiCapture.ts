type DirectoryFile = { kind: "file"; name: string; getFile(): Promise<File> };
export type DownloadDirectory = {
  values(): AsyncIterable<DirectoryFile | { kind: "directory"; name: string }>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};

export function canliiPdfFilename(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")
      .replace(/[^A-Za-z0-9._-]/gu, "");
  } catch { return ""; }
}

export function matchesCanliiDownload(name: string, expected: string) {
  const stem = expected.replace(/\.pdf$/iu, "");
  if (!stem || stem === expected) return false;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}(?: \\(\\d+\\))?\\.pdf$`, "iu").test(name);
}

export async function chooseDownloadDirectory() {
  const picker = (window as Window & { showDirectoryPicker?: (options: {
    id: string; mode: "read";
  }) => Promise<DownloadDirectory> }).showDirectoryPicker;
  if (!picker) return null;
  const directory = await picker({ id: "canlii-downloads", mode: "read" });
  return !directory.requestPermission ||
    await directory.requestPermission({ mode: "read" }) === "granted" ? directory : null;
}

export async function captureCanliiDownload(directory: DownloadDirectory, url: string,
  { signal, attempts = 80, pollMs = 1_250, handoff }: {
    signal?: AbortSignal; attempts?: number; pollMs?: number; handoff?: () => void;
  } = {}) {
  const expected = canliiPdfFilename(url);
  if (!expected) return null;
  const before = new Map<string, string>();
  for await (const handle of directory.values()) if (handle.kind === "file" &&
      matchesCanliiDownload(handle.name, expected)) {
    const file = await handle.getFile();
    before.set(handle.name, `${file.size}:${file.lastModified}`);
  }
  signal?.throwIfAborted(); handoff?.();
  let candidate = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    signal?.throwIfAborted();
    let newest: File | null = null;
    for await (const handle of directory.values()) if (handle.kind === "file" &&
        matchesCanliiDownload(handle.name, expected)) {
      const file = await handle.getFile();
      if (before.get(handle.name) !== `${file.size}:${file.lastModified}` &&
          (!newest || file.lastModified > newest.lastModified)) newest = file;
    }
    if (!newest) { candidate = ""; continue; }
    const fingerprint = `${newest.name}:${newest.size}:${newest.lastModified}`;
    if (candidate === fingerprint && await newest.slice(0, 5).text() === "%PDF-") return newest;
    candidate = fingerprint;
  }
  return null;
}
