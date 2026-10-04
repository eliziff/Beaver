// A2AJ's public corpus on Hugging Face, kept in a folder the user chose: one Parquet file per court
// or jurisdiction (a2aj/canadian-case-law, a2aj/canadian-laws), each downloaded on its own, resumed
// where it stopped, verified by its SHA-256 and replaced only once whole. Updates compare each
// file's hash with the dataset's current revision, so an update fetches only the files that changed.
//
// Ported from ALR-Quote-Verifier local_a2aj.py (LocalA2AJCorpus.fetch_metadata, status,
// bytes_to_download, install_or_update, _download_file; manifest version 2), per file instead of
// per snapshot so a user can keep only the courts they cite.
//
// Nothing here touches Node or the DOM: the folder (Node's file system, or a browser's File System
// Access directory), fetch and SHA-256 come from the caller, so the page and the desktop runtime
// install and read the same folder.

export type A2AJKind = "cases" | "laws";
export const A2AJ_KINDS: readonly A2AJKind[] = ["cases", "laws"];
export const A2AJ_REPOSITORIES: Record<A2AJKind, string> = {
  cases: "a2aj/canadian-case-law",
  laws: "a2aj/canadian-laws",
};
const HF_API = "https://huggingface.co/api/datasets";
const HF_RESOLVE = "https://huggingface.co/datasets";

export type A2AJCorpusFile = { path: string; sha256: string; size: number };
export type A2AJSnapshot = {
  kind: A2AJKind; repository: string; revision: string; lastModified: string; files: A2AJCorpusFile[];
};
/** local_a2aj.py's manifest (version 2): `files` and `local_files` list the files in the folder. */
export type A2AJManifest = {
  version: 2; kind: A2AJKind; repository: string; revision: string; last_modified: string;
  files: A2AJCorpusFile[]; local_files: A2AJCorpusFile[];
};

/** A folder holding the corpus, at relative POSIX paths ("cases/SCC/train.parquet"). */
export interface A2AJCorpusFolder {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** Bytes in the file, or null when there is no such file. */
  size(path: string): Promise<number | null>;
  read(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Writes from byte `at` on, keeping the bytes before it. Each close() makes what was written durable. */
  append(path: string, at: number): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void> }>;
  /** How many bytes a download writes before closing and reopening its writer to keep them, when
   *  writes become durable only on close (a browser's File System Access writer). */
  commitBytes?: number;
  /** Moves `from` over `to`. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type Sha256 = () => { update(bytes: Uint8Array): unknown; digest(): Uint8Array | string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The court or jurisdiction a corpus file holds: its folder ("SCC", "LEGISLATION-FED"). */
export const courtOf = (path: string) => path.split("/")[0];

function safeRelative(path: string) {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`Unsafe A2AJ corpus path: ${path}`);
  return path;
}
const localPath = (kind: A2AJKind, file: Pick<A2AJCorpusFile, "path">) => `${kind}/${safeRelative(file.path)}`;

/** The dataset's current revision and its Parquet files, from Hugging Face. */
export async function fetchA2AJSnapshot(kind: A2AJKind, fetch: Fetch, signal?: AbortSignal): Promise<A2AJSnapshot> {
  const repository = A2AJ_REPOSITORIES[kind];
  const response = await fetch(`${HF_API}/${repository}/revision/main?blobs=true`,
    { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Hugging Face did not list ${repository} (${response.status}).`);
  const payload = await response.json() as {
    sha?: string; lastModified?: string;
    siblings?: Array<{ rfilename?: string; size?: number; lfs?: { sha256?: string; size?: number } }>;
  };
  const files = (payload.siblings ?? []).flatMap((item) => {
    const path = String(item.rfilename ?? "");
    if (!path.endsWith(".parquet")) return [];
    const sha256 = String(item.lfs?.sha256 ?? "");
    if (sha256.length !== 64) throw new Error(`Hugging Face omitted the SHA-256 of ${repository}/${path}.`);
    return [{ path: safeRelative(path), sha256, size: Number(item.lfs?.size ?? item.size ?? 0) }];
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) throw new Error(`Hugging Face listed no Parquet files for ${repository}.`);
  return { kind, repository, revision: String(payload.sha ?? ""), lastModified: String(payload.lastModified ?? ""), files };
}

export async function readA2AJManifest(folder: A2AJCorpusFolder, kind: A2AJKind): Promise<A2AJManifest | null> {
  try {
    const manifest = JSON.parse(await folder.readText(`${kind}/manifest.json`) ?? "null") as A2AJManifest | null;
    return manifest && Array.isArray(manifest.files) ? manifest : null;
  } catch { return null; }
}

/** The files of the manifest that are in the folder at their recorded size. */
export async function installedA2AJFiles(folder: A2AJCorpusFolder, kind: A2AJKind) {
  const manifest = await readA2AJManifest(folder, kind);
  const files = manifest?.local_files ?? manifest?.files ?? [];
  const present = await Promise.all(files.map(async (file) => await folder.size(localPath(kind, file)) === file.size));
  return files.filter((_, index) => present[index]);
}

export type A2AJCourtStatus = {
  court: string; path: string;
  /** The installed file's size and hash, when the court is in the folder. */
  installed: A2AJCorpusFile | null;
  /** The current revision's file, when the remote listing was read. */
  remote: A2AJCorpusFile | null;
  /** Bytes of this court already in the folder from an unfinished download of the current file. */
  partial: number;
};
export type A2AJKindStatus = {
  kind: A2AJKind; installedRevision: string; remoteRevision: string; lastModified: string;
  courts: A2AJCourtStatus[];
};

/** Every court the folder or the remote revision has, with what is installed and what is current. */
export async function a2ajCorpusStatus(folder: A2AJCorpusFolder, kind: A2AJKind,
  remote?: A2AJSnapshot | null): Promise<A2AJKindStatus> {
  const manifest = await readA2AJManifest(folder, kind);
  const installed = new Map((await installedA2AJFiles(folder, kind)).map((file) => [file.path, file]));
  const current = new Map((remote?.files ?? []).map((file) => [file.path, file]));
  const paths = [...new Set([...installed.keys(), ...current.keys()])].sort();
  const courts = await Promise.all(paths.map(async (path) => {
    const wanted = current.get(path) ?? null, have = installed.get(path) ?? null;
    const partial = wanted && have?.sha256 !== wanted.sha256
      ? Math.min(await folder.size(`${localPath(kind, wanted)}.part`) ?? 0, wanted.size) : 0;
    return { court: courtOf(path), path, installed: have, remote: wanted, partial };
  }));
  return { kind, installedRevision: manifest?.revision ?? "", remoteRevision: remote?.revision ?? "",
    lastModified: remote?.lastModified ?? manifest?.last_modified ?? "", courts };
}

/** Whether an installed court differs from the current revision's file. */
export const a2ajCourtStale = (court: A2AJCourtStatus) =>
  !!court.installed && !!court.remote && court.installed.sha256 !== court.remote.sha256;

/** Bytes still to fetch to have these courts current: a resumed download counts only what is left. */
export function a2ajBytesToDownload(status: A2AJKindStatus, courts: Iterable<string>) {
  const wanted = new Set(courts);
  return status.courts.reduce((total, court) => !wanted.has(court.court) || !court.remote ||
    court.installed?.sha256 === court.remote.sha256 ? total : total + court.remote.size - court.partial, 0);
}

export type A2AJInstallProgress = {
  kind: A2AJKind; court: string; phase: "resume" | "download" | "installed";
  /** Bytes fetched over the network in this install, and the bytes it set out to fetch. */
  downloaded: number; toDownload: number;
};

const hex = (digest: Uint8Array | string) => typeof digest === "string" ? digest
  : [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const HASH_CHUNK = 8 * 1024 * 1024;

async function writeManifest(folder: A2AJCorpusFolder, snapshot: A2AJSnapshot, files: A2AJCorpusFile[]) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const manifest: A2AJManifest = { version: 2, kind: snapshot.kind, repository: snapshot.repository,
    revision: snapshot.revision, last_modified: snapshot.lastModified, files: sorted, local_files: sorted };
  await folder.writeText(`${snapshot.kind}/manifest.json`, JSON.stringify(manifest, null, 2));
}

async function downloadFile(folder: A2AJCorpusFolder, snapshot: A2AJSnapshot, file: A2AJCorpusFile,
  options: { fetch: Fetch; sha256: Sha256; signal?: AbortSignal; fetched: (bytes: number) => void }) {
  const target = localPath(snapshot.kind, file), part = `${target}.part`;
  let written = await folder.size(part) ?? 0;
  if (written > file.size) { await folder.remove(part); written = 0; }
  let hash = options.sha256();
  // What an earlier, stopped download kept is hashed again rather than trusted.
  for (let start = 0; start < written; start += HASH_CHUNK) {
    options.signal?.throwIfAborted();
    hash.update(await folder.read(part, start, Math.min(start + HASH_CHUNK, written)));
  }
  if (written < file.size) {
    const url = `${HF_RESOLVE}/${snapshot.repository}/resolve/${encodeURIComponent(snapshot.revision)}/${
      file.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await options.fetch(url, { signal: options.signal, credentials: "omit", referrerPolicy: "no-referrer",
      headers: written ? { Range: `bytes=${written}-` } : {} });
    if (!response.ok || !response.body) throw new Error(`Hugging Face did not send ${snapshot.repository}/${file.path} (${response.status}).`);
    if (written && response.status !== 206) { written = 0; hash = options.sha256(); }
    let writer = await folder.append(part, written), uncommitted = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await writer.write(value);
        written += value.byteLength; uncommitted += value.byteLength;
        options.fetched(value.byteLength);
        if (folder.commitBytes && uncommitted >= folder.commitBytes) {
          await writer.close();
          writer = await folder.append(part, written); uncommitted = 0;
        }
      }
    } finally {
      reader.releaseLock();
      await writer.close();
    }
  }
  if (written !== file.size || hex(hash.digest()) !== file.sha256) {
    await folder.remove(part);
    throw new Error(`The downloaded ${snapshot.repository}/${file.path} did not match its published SHA-256. Download it again.`);
  }
  await folder.rename(part, target);
}

/**
 * Makes these courts of a kind current in the folder: each court whose file differs from the
 * snapshot's is downloaded (resuming a stopped download), verified and put in place, and the
 * manifest records it at once, so stopping keeps every court finished so far. Courts not listed stay
 * as they are; `remove` deletes those courts from the folder.
 */
export async function installA2AJCourts(folder: A2AJCorpusFolder, snapshot: A2AJSnapshot, courts: Iterable<string>,
  options: { fetch: Fetch; sha256: Sha256; signal?: AbortSignal; remove?: Iterable<string>;
    progress?: (progress: A2AJInstallProgress) => void }) {
  const wanted = new Set(courts), removing = new Set(options.remove ?? []);
  const status = await a2ajCorpusStatus(folder, snapshot.kind, snapshot);
  const installed = new Map(status.courts.flatMap((court) => court.installed ? [[court.path, court.installed] as const] : []));
  for (const court of status.courts) {
    if (!removing.has(court.court) || wanted.has(court.court)) continue;
    installed.delete(court.path);
    await writeManifest(folder, snapshot, [...installed.values()]);
    await folder.remove(localPath(snapshot.kind, court));
    await folder.remove(`${localPath(snapshot.kind, court)}.part`);
  }
  const toDownload = a2ajBytesToDownload(status, wanted);
  let downloaded = 0;
  for (const court of status.courts) {
    options.signal?.throwIfAborted();
    const file = court.remote;
    if (!wanted.has(court.court) || !file || court.installed?.sha256 === file.sha256) continue;
    const report = (phase: A2AJInstallProgress["phase"]) =>
      options.progress?.({ kind: snapshot.kind, court: court.court, phase, downloaded, toDownload });
    report(court.partial ? "resume" : "download");
    await downloadFile(folder, snapshot, file, { ...options, fetched: (bytes) => {
      downloaded += bytes; report("download");
    } });
    installed.set(file.path, file);
    await writeManifest(folder, snapshot, [...installed.values()]);
    report("installed");
  }
  if (!installed.size) return;
  // The manifest names the revision last checked, even when nothing needed fetching.
  await writeManifest(folder, snapshot, [...installed.values()]);
}

/** The parts of a File System Access directory handle (the browser's) a corpus folder uses. */
type DirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
};
type FileHandle = {
  getFile(): Promise<{ size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
    text(): Promise<string>; stream(): ReadableStream<Uint8Array> }>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    seek(position: number): Promise<void>; truncate(size: number): Promise<void>;
    write(data: Uint8Array | string): Promise<void>; close(): Promise<void> }>;
  move?(name: string): Promise<void>;
};
const notFound = (error: unknown) => (error as { name?: string })?.name === "NotFoundError" ||
  (error as { name?: string })?.name === "TypeMismatchError";

/**
 * A corpus folder the user picked in a browser (File System Access), usable in the page and in a
 * Worker the handle was sent to. A browser keeps a writer's bytes only once it closes, and reopening
 * one copies the file so far, so a download closes its writer every 256 MB.
 */
export function directoryA2AJFolder(root: DirectoryHandle): A2AJCorpusFolder {
  const parent = async (path: string, create: boolean) => {
    const parts = safeRelative(path).split("/"), name = parts.pop()!;
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name };
  };
  const file = async (path: string, create = false) => {
    const { directory, name } = await parent(path, create);
    return directory.getFileHandle(name, { create });
  };
  const existing = async (path: string) => {
    try { return await (await file(path)).getFile(); } catch (error) { if (notFound(error)) return null; throw error; }
  };
  const folder: A2AJCorpusFolder = {
    commitBytes: 256 * 1024 * 1024,
    readText: async (path) => (await existing(path))?.text() ?? null,
    async writeText(path, text) {
      const writer = await (await file(path, true)).createWritable();
      await writer.write(text);
      await writer.close();
    },
    size: async (path) => (await existing(path))?.size ?? null,
    async read(path, start, end) {
      const found = await existing(path);
      if (!found) throw new Error(`${path} is not in the corpus folder.`);
      return new Uint8Array(await found.slice(start, end).arrayBuffer());
    },
    async append(path, at) {
      const writer = await (await file(path, true)).createWritable({ keepExistingData: at > 0 });
      await writer.truncate(at);
      await writer.seek(at);
      return { write: (bytes) => writer.write(bytes), close: () => writer.close() };
    },
    async rename(from, to) {
      const source = await file(from), { name } = await parent(to, true);
      if (source.move) { await folder.remove(to); await source.move(name); return; }
      // Without move(), the file is copied into place and the original removed.
      const writer = await (await file(to, true)).createWritable();
      const reader = (await source.getFile()).stream().getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; await writer.write(value); }
      await writer.close();
      await folder.remove(from);
    },
    async remove(path) {
      try { const { directory, name } = await parent(path, false); await directory.removeEntry(name); }
      catch (error) { if (!notFound(error)) throw error; }
    },
  };
  return folder;
}
