import {
  fileSnapshot,
  workProductInputs,
  type InputResolution,
  type WorkProduct,
  type WorkProductInput,
  type WorkProductMetadata,
  type WorkProductStore,
} from "./workProducts";

const DATABASE = "beaver-work-products";
const DRAFTS = "drafts";
const METADATA = "metadata";
const HANDLES = "fileHandles";
const FILES = "files";
const OUTPUTS = "outputs";
const OUTPUT_FOLDER = "preference:authorities-output-folder";
const MAX_UNCLAIMED_HANDLES = 64;
const UNCLAIMED_HANDLE_MAX_AGE = 24 * 60 * 60 * 1_000;

export type StandaloneArtifact = {
  role: string;
  filename: string;
  mimeType: string;
  sha256: string;
  pageCount: number | null;
  bytes: Uint8Array;
  receipt: unknown;
};
export type StandaloneNamedOutput = {
  product: WorkProduct;
  role: string;
  output: WorkProduct["outputs"][string];
};
type StoredOutput = Omit<StandaloneArtifact, "bytes"> & {
  id: string;
  workProductId: string;
  documentId: string;
  bytes: ArrayBuffer;
  createdAt: string;
};
type StoredHandle = {
  id: string;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  createdAt: number;
};
type StoredFile = { id: string; mimeType: string; bytes: ArrayBuffer };
type LocalFileInput = Extract<WorkProductInput, { kind: "local-file" }>;
const storedFileId = (sha256: string) => `stored:${sha256}`;

const selectedInputs = new WeakMap<File, LocalFileInput>();

export const standaloneWorkProducts: WorkProductStore = {
  async list(kind, projectId) {
    const drafts = await all<WorkProduct>(DRAFTS);
    return drafts.filter((draft) => draft.kind === kind &&
      (projectId === undefined || draft.projectId === projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) as never;
  },
  async listMetadata(kind, projectId) {
    return (await all<WorkProductMetadata>(METADATA)).filter((draft) => draft.kind === kind &&
      (projectId === undefined || draft.projectId === projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },
  async get(id) {
    const draft = await read<WorkProduct>(DRAFTS, id);
    if (!draft) throw new Error("This draft no longer exists.");
    return draft as never;
  },
  async create(input) {
    const now = new Date().toISOString();
    const draft: WorkProduct = {
      ...input,
      title: draftTitle(input.title),
      id: crypto.randomUUID(),
      projectId: input.projectId ?? null,
      revision: 1,
      outputs: {},
      createdAt: now,
      updatedAt: now,
    };
    const database = await openDatabase(), transaction = database.transaction(
      [DRAFTS, METADATA, FILES], "readwrite",
    );
    const store = transaction.objectStore(DRAFTS);
    const current = await request<WorkProduct[]>(store.getAll());
    assertDependencies(draft.id, draft.state, current);
    store.add(draft);
    transaction.objectStore(METADATA).add(draftMetadata(draft));
    await cleanupStoredFiles(transaction.objectStore(FILES), [...current, draft]);
    await completed(transaction);
    return draft as never;
  },
  async update(id, patch) {
    const database = await openDatabase();
    const transaction = database.transaction(
      [DRAFTS, METADATA, HANDLES, FILES, OUTPUTS], "readwrite",
    );
    const store = transaction.objectStore(DRAFTS);
    const drafts = await request<WorkProduct[]>(store.getAll());
    const current = drafts.find((draft) => draft.id === id);
    if (!current) throw new Error("This draft no longer exists.");
    if (current.revision !== patch.revision) throw new Error("This draft changed elsewhere. Reopen it and try again.");
    if (patch.outputs !== undefined) {
      throw new Error("Standalone outputs must be saved with their built artifacts.");
    }
    const invalidatesOutput = patch.title !== undefined || patch.state !== undefined;
    const next: WorkProduct = {
      ...current,
      title: patch.title === undefined ? current.title : draftTitle(patch.title),
      projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
      state: patch.state === undefined ? current.state : patch.state,
      outputs: invalidatesOutput ? {} : current.outputs,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    assertDependencies(id, next.state, drafts);
    store.put(next);
    transaction.objectStore(METADATA).put(draftMetadata(next));
    if (invalidatesOutput) for (const output of Object.values(current.outputs)) {
      transaction.objectStore(OUTPUTS).delete(output.versionId);
    }
    await cleanupHandles(transaction.objectStore(HANDLES), [
      ...drafts.filter((draft) => draft.id !== id), next,
    ], handleIds(current));
    await cleanupStoredFiles(transaction.objectStore(FILES), [
      ...drafts.filter((draft) => draft.id !== id), next,
    ]);
    await completed(transaction);
    return next as never;
  },
  async duplicate(id, input = {}) {
    const database = await openDatabase(), transaction = database.transaction(
      [DRAFTS, METADATA, FILES], "readwrite",
    );
    const store = transaction.objectStore(DRAFTS), drafts =
      await request<WorkProduct[]>(store.getAll());
    const source = drafts.find((draft) => draft.id === id);
    if (!source) throw new Error("This draft no longer exists.");
    const now = new Date().toISOString(), copy: WorkProduct = {
      ...source, id: crypto.randomUUID(),
      title: draftTitle(input.title ?? `${source.title.slice(0, 295)} copy`),
      projectId: input.projectId === undefined ? source.projectId : input.projectId,
      revision: 1, state: structuredClone(source.state), outputs: {}, createdAt: now, updatedAt: now,
    };
    store.add(copy);
    transaction.objectStore(METADATA).add(draftMetadata(copy));
    await cleanupStoredFiles(transaction.objectStore(FILES), [...drafts, copy]);
    await completed(transaction);
    return copy as never;
  },
  async remove(id) {
    const database = await openDatabase();
    const transaction = database.transaction(
      [DRAFTS, METADATA, HANDLES, FILES, OUTPUTS], "readwrite",
    );
    const store = transaction.objectStore(DRAFTS), outputStore = transaction.objectStore(OUTPUTS);
    const [drafts, outputs] = await Promise.all([
      request<WorkProduct[]>(store.getAll()), request<StoredOutput[]>(outputStore.getAll()),
    ]);
    const current = drafts.find((draft) => draft.id === id);
    if (!current) throw new Error("This draft no longer exists.");
    store.delete(id);
    transaction.objectStore(METADATA).delete(id);
    for (const output of outputs) if (output.workProductId === id) outputStore.delete(output.id);
    await cleanupHandles(transaction.objectStore(HANDLES),
      drafts.filter((draft) => draft.id !== id), handleIds(current));
    await cleanupStoredFiles(transaction.objectStore(FILES),
      drafts.filter((draft) => draft.id !== id));
    await completed(transaction);
  },
};

export async function saveStandaloneArtifacts<State>(
  product: WorkProduct<State>, artifacts: StandaloneArtifact[],
) {
  if (!artifacts.length) throw new Error("The build did not produce any files.");
  const roles = new Set<string>();
  const verified = await Promise.all(artifacts.map(async (artifact) => {
    const role = artifact.role.trim();
    if (!role || role.length > 200 || roles.has(role)) {
      throw new Error("Built output roles must be unique and named.");
    }
    roles.add(role);
    if (!artifact.filename.trim() || !artifact.mimeType.trim() ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        await digestBytes(artifact.bytes) !== artifact.sha256) {
      throw new Error(`The built bytes do not match ${artifact.filename || role}.`);
    }
    return { ...artifact, role };
  }));
  const database = await openDatabase();
  const transaction = database.transaction([DRAFTS, METADATA, OUTPUTS], "readwrite");
  const drafts = transaction.objectStore(DRAFTS), outputs = transaction.objectStore(OUTPUTS);
  const current = await request<WorkProduct<State> | undefined>(drafts.get(product.id));
  if (!current) throw new Error("This draft no longer exists.");
  if (current.revision !== product.revision) {
    throw new Error("This draft changed elsewhere. Reopen it and build again.");
  }
  const now = new Date().toISOString();
  for (const output of await request<StoredOutput[]>(outputs.getAll())) {
    if (output.workProductId === product.id) outputs.delete(output.id);
  }
  const saved = Object.fromEntries(verified.map((artifact) => {
    const documentId = current.outputs[artifact.role]?.documentId ?? crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const output = { documentId, versionId, filename: artifact.filename,
      mimeType: artifact.mimeType, sha256: artifact.sha256, pageCount: artifact.pageCount };
    outputs.add({ ...artifact, id: versionId, workProductId: product.id, documentId,
      bytes: artifact.bytes.slice().buffer, createdAt: now } satisfies StoredOutput);
    return [artifact.role, output];
  }));
  const next: WorkProduct<State> = { ...current, outputs: saved,
    revision: current.revision + 1, updatedAt: now };
  drafts.put(next);
  transaction.objectStore(METADATA).put(draftMetadata(next));
  await completed(transaction);
  return next;
}

export async function listStandaloneOutputs(excludeId?: string): Promise<StandaloneNamedOutput[]> {
  const database = await openDatabase();
  const transaction = database.transaction([DRAFTS, OUTPUTS]);
  const [drafts, stored] = await Promise.all([
    request<WorkProduct[]>(transaction.objectStore(DRAFTS).getAll()),
    request<StoredOutput[]>(transaction.objectStore(OUTPUTS).getAll()),
  ]);
  const versions = new Map(stored.map((output) => [output.id, output]));
  return drafts.filter((product) => product.id !== excludeId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .flatMap((product) => Object.entries(product.outputs).flatMap(([role, output]) => {
      const saved = versions.get(output.versionId);
      return saved && exactOutput(saved, product.id, role, output) ? [{ product, role, output }] : [];
    }));
}

export async function readStandaloneOutput(workProductId: string, role: string,
  versionId?: string) {
  const product = await read<WorkProduct>(DRAFTS, workProductId);
  if (!product) throw new Error("The connected draft no longer exists. Remove or replace this file.");
  const current = product.outputs[role];
  const selectedVersion = versionId ?? current?.versionId;
  if (!selectedVersion) {
    throw new Error(`The ${role} output is missing. Rebuild ${product.title} and try again.`);
  }
  const saved = await read<StoredOutput>(OUTPUTS, selectedVersion);
  if (!saved || saved.workProductId !== product.id || saved.role !== role ||
      !versionId && (!current || !exactOutput(saved, product.id, role, current))) {
    throw new Error(`The ${role} output is unavailable. Rebuild ${product.title} and try again.`);
  }
  return { product, role, output: storedOutput(saved), bytes: new Uint8Array(saved.bytes.slice(0)),
    receipt: structuredClone(saved.receipt) };
}

function draftTitle(value: string) {
  const title = value.trim();
  if (!title || title.length > 300) throw new Error("Draft title is required.");
  return title;
}

function assertDependencies(id: string, state: unknown, drafts: WorkProduct[]) {
  const states = new Map(drafts.map((draft) => [draft.id, draft.state]));
  states.set(id, state);
  const visited = new Set<string>();
  function visit(current: string, path: string[]) {
    const loop = path.indexOf(current);
    if (loop >= 0) throw new Error(`A draft cannot contain itself (${[
      ...path.slice(loop), current,
    ].join(" → ")}).`);
    if (visited.has(current)) return;
    visited.add(current);
    if (visited.size > 1_000) throw new Error("This draft contains too many nested drafts.");
    const nested = states.get(current);
    if (nested === undefined) throw new Error("A connected draft no longer exists.");
    for (const input of workProductInputs(nested)) {
      if (input.kind === "work-product-output") visit(input.workProductId, [...path, current]);
    }
  }
  visit(id, []);
}

const handleIds = (draft: WorkProduct) => new Set(workProductInputs(draft.state).flatMap((input) =>
  input.kind === "local-file" ? [input.handleId] : []));

async function cleanupHandles(store: IDBObjectStore, drafts: WorkProduct[],
  removed = new Set<string>(), maximum = MAX_UNCLAIMED_HANDLES) {
  const used = new Set(drafts.flatMap((draft) => [...handleIds(draft)]));
  const unclaimed = (await request<StoredHandle[]>(store.getAll()))
    .filter(({ id }) => id !== OUTPUT_FOLDER && !used.has(id))
    .sort((left, right) => right.createdAt - left.createdAt);
  const cutoff = Date.now() - UNCLAIMED_HANDLE_MAX_AGE;
  unclaimed.forEach((item, index) => {
    if (removed.has(item.id) || item.createdAt < cutoff || index >= maximum) store.delete(item.id);
  });
}

async function cleanupStoredFiles(store: IDBObjectStore, drafts: WorkProduct[]) {
  const used = new Set(drafts.flatMap((draft) => [...handleIds(draft)]));
  for (const id of await request<IDBValidKey[]>(store.getAllKeys())) {
    if (typeof id === "string" && !used.has(id)) store.delete(id);
  }
}

type PickerWindow = Window & typeof globalThis & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) =>
    Promise<FileSystemDirectoryHandle>;
};
type PermissionHandle = FileSystemHandle & {
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

async function outputFolder() {
  const saved = await read<StoredHandle>(HANDLES, OUTPUT_FOLDER);
  return saved?.handle.kind === "directory" ? saved.handle : null;
}

export async function getStandaloneOutputFolder() {
  try {
    const handle = await outputFolder(), query = (handle as PermissionHandle | null)?.queryPermission;
    return handle && (!query || await query.call(handle, { mode: "readwrite" }) === "granted")
      ? handle.name : null;
  } catch { return null; }
}

export async function chooseStandaloneOutputFolder() {
  const picker = typeof window === "undefined" ? undefined
    : (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    const handle = await picker({ id: "authorities-output", mode: "readwrite" });
    const database = await openDatabase(), transaction = database.transaction(HANDLES, "readwrite");
    transaction.objectStore(HANDLES).put({ id: OUTPUT_FOLDER, handle,
      createdAt: Date.now() } satisfies StoredHandle);
    await completed(transaction);
    return handle.name;
  } catch { return getStandaloneOutputFolder(); }
}

export async function clearStandaloneOutputFolder() {
  const database = await openDatabase(), transaction = database.transaction(HANDLES, "readwrite");
  transaction.objectStore(HANDLES).delete(OUTPUT_FOLDER);
  await completed(transaction);
}

export async function writeStandaloneArtifactsToOutputFolder(artifacts: StandaloneArtifact[]) {
  try {
    const handle = await outputFolder();
    if (!handle) return null;
    const query = (handle as PermissionHandle).queryPermission;
    if (query && await query.call(handle, { mode: "readwrite" }) !== "granted") {
      return "Built files are ready to download; the output folder could not be used.";
    }
    for (const artifact of artifacts) {
      const writable = await (await unusedFile(handle, artifact.filename)).createWritable();
      await writable.write(artifact.bytes.slice().buffer as ArrayBuffer); await writable.close();
    }
    return null;
  } catch { return "Built files are ready to download; the output folder could not be used."; }
}

export function canRetainLocalFiles() {
  return typeof document !== "undefined";
}

export async function pickRetainedFiles(multiple: boolean, accept: "source" | "pdf" = "source"):
Promise<Array<{
  file: File; input: LocalFileInput;
}>> {
  const picker = typeof window === "undefined" ? undefined
    : (window as PickerWindow).showOpenFilePicker;
  if (!picker) return Promise.all((await pickInputFiles(multiple, accept)).map(async (file) => ({
    file, input: await retainStandaloneFile(file),
  })));
  const handles = await picker({
    multiple,
    types: [{
      description: accept === "pdf" ? "PDF" : "PDF or Word document",
      accept: { "application/pdf": [".pdf"], ...(accept === "source" ? {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      } : {}) },
    }],
  });
  const selected = await Promise.all(handles.map(async (handle) => ({
    handle, file: await handle.getFile(), handleId: crypto.randomUUID(),
  })));
  const database = await openDatabase(), transaction = database.transaction([DRAFTS, HANDLES], "readwrite");
  const store = transaction.objectStore(HANDLES);
  const drafts = await request<WorkProduct[]>(transaction.objectStore(DRAFTS).getAll());
  await cleanupHandles(store, drafts, new Set(), Math.max(0,
    MAX_UNCLAIMED_HANDLES - selected.length));
  const createdAt = Date.now();
  for (const { handle, handleId } of selected) store.put({ id: handleId, handle, createdAt });
  await completed(transaction);
  return selected.map(({ file, handleId }) => {
    const input: LocalFileInput = { kind: "local-file", handleId, lastSeen: fileSnapshot(file) };
    selectedInputs.set(file, input);
    return { file, input };
  });
}

function pickInputFiles(multiple: boolean, accept: "source" | "pdf") {
  if (typeof document === "undefined") return Promise.resolve<File[]>([]);
  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = multiple;
    input.accept = accept === "pdf" ? ".pdf" : ".pdf,.docx";
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

export async function bindStandaloneFile(file: File, input?: WorkProductInput) {
  const retained = input?.kind === "local-file" ? input : selectedInputs.get(file);
  if (retained?.lastSeen.sha256 && retained.lastSeen.name === file.name &&
      retained.lastSeen.size === file.size && retained.lastSeen.modified === file.lastModified) {
    selectedInputs.set(file, retained);
    return retained.handleId.startsWith("stored:") ? retainStandaloneFile(file) : retained;
  }
  if (!retained) return retainStandaloneFile(file);
  const binding: LocalFileInput = {
    kind: "local-file", handleId: retained.handleId,
    lastSeen: await snapshotFile(file),
  };
  selectedInputs.set(file, binding);
  return binding;
}

/** Retains generated/downloaded bytes without pretending they have a user filesystem handle. */
export async function retainStandaloneFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer()), sha256 = await digestBytes(bytes);
  const id = storedFileId(sha256), database = await openDatabase();
  const transaction = database.transaction(FILES, "readwrite");
  transaction.objectStore(FILES).put({ id, mimeType: file.type,
    bytes: bytes.slice().buffer } satisfies StoredFile);
  await completed(transaction);
  const binding = { kind: "local-file", handleId: id,
    lastSeen: { name: file.name, size: file.size, modified: file.lastModified, sha256 } } as const;
  selectedInputs.set(file, binding);
  return binding;
}

export async function resolveStandaloneFile(input: WorkProductInput, verifyContents = false) {
  if (input.kind !== "local-file") return { status: "missing" as const, reason: "unavailable" as const };
  const result = input.handleId.startsWith("stored:") ? await resolveStoredFile(input)
    : await resolveLocalFile(input);
  if (result.status === "missing") return result;
  const metadata = fileSnapshot(result.file), previous = input.lastSeen;
  const metadataChanged = result.status === "changed" || metadata.name !== previous.name ||
    metadata.size !== previous.size || metadata.modified !== previous.modified;
  const current = verifyContents || metadataChanged || !previous.sha256
    ? await snapshotFile(result.file) : { ...metadata, sha256: previous.sha256 };
  const changed = metadataChanged || verifyContents && current.sha256 !== previous.sha256;
  const resolvedInput: LocalFileInput = { ...input, lastSeen: current };
  selectedInputs.set(result.file, resolvedInput);
  return { status: changed ? "changed" as const : "ready" as const, file: result.file,
    input: resolvedInput };
}

/** Checks retained-file availability without loading content-addressed bytes from IndexedDB. */
export async function inspectStandaloneFile(input: WorkProductInput) {
  if (input.kind !== "local-file") return { status: "missing" as const,
    reason: "unavailable" as const };
  if (input.handleId.startsWith("stored:")) return await exists(FILES, input.handleId)
    ? { status: "ready" as const } : { status: "missing" as const, reason: "deleted" as const };
  const result = await resolveLocalFile(input);
  return result.status === "missing" ? result : { status: result.status };
}

async function resolveStoredFile(input: LocalFileInput): Promise<InputResolution> {
  const saved = await read<StoredFile>(FILES, input.handleId);
  if (!saved) return { status: "missing", reason: "deleted" };
  const file = new File([saved.bytes.slice(0)], input.lastSeen.name,
    { type: saved.mimeType, lastModified: input.lastSeen.modified });
  return { status: file.size === input.lastSeen.size ? "ready" : "changed", file, input };
}

export async function relinkStandaloneFile(input: WorkProductInput, verifyContents = false,
  accept: "source" | "pdf" = "source") {
  const current = await resolveStandaloneFile(input, verifyContents);
  if (current.status !== "missing") return current;
  const replacement = await relinkLocalFile(input, accept);
  if (replacement.status === "missing") return replacement;
  return resolveStandaloneFile(replacement.input, verifyContents);
}

async function resolveLocalFile(input: WorkProductInput): Promise<InputResolution> {
  if (input.kind !== "local-file") return { status: "missing", reason: "unavailable" };
  const saved = await read<StoredHandle>(HANDLES, input.handleId);
  if (!saved || saved.handle.kind !== "file") return { status: "missing", reason: "deleted" };
  return resolveRetainedFile(saved.handle, input);
}

export async function resolveRetainedFile(handle: FileSystemFileHandle,
  input: Extract<WorkProductInput, { kind: "local-file" }>): Promise<InputResolution> {
  try {
    const query = (handle as PermissionHandle).queryPermission;
    if (query && await query.call(handle, { mode: "read" }) !== "granted") {
      return { status: "missing", reason: "permission" };
    }
    const file = await handle.getFile(), current = fileSnapshot(file);
    const changed = current.name !== input.lastSeen.name || current.size !== input.lastSeen.size ||
      current.modified !== input.lastSeen.modified;
    return {
      status: changed ? "changed" : "ready",
      file,
      input: { ...input, lastSeen: changed || !input.lastSeen.sha256 ? current
        : { ...current, sha256: input.lastSeen.sha256 } },
    };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    return { status: "missing", reason: ["NotAllowedError", "SecurityError"].includes(name)
      ? "permission" : name === "NotFoundError" ? "deleted" : "unavailable" };
  }
}

async function relinkLocalFile(input: WorkProductInput,
  accept: "source" | "pdf"): Promise<InputResolution> {
  if (input.kind !== "local-file") return { status: "missing", reason: "unavailable" };
  const existing = await read<StoredHandle>(HANDLES, input.handleId);
  const requestPermission = existing?.handle.kind === "file" &&
    (existing.handle as PermissionHandle).requestPermission;
  if (existing?.handle.kind === "file" && requestPermission) {
    try {
      if (await requestPermission.call(existing.handle, { mode: "read" }) === "granted") {
        return resolveRetainedFile(existing.handle, input);
      }
    } catch { /* The replacement picker remains available. */ }
  }
  const picked = await pickRetainedFiles(false, accept);
  const replacement = picked[0];
  if (!replacement) return { status: "missing", reason: "unavailable" };
  if (input.handleId.startsWith("stored:")) return { status: "ready",
    file: replacement.file, input: replacement.input };
  const saved = await read<StoredHandle>(HANDLES, replacement.input.handleId);
  if (!saved || saved.handle.kind !== "file") return { status: "missing", reason: "unavailable" };
  const database = await openDatabase(), transaction = database.transaction(HANDLES, "readwrite");
  const store = transaction.objectStore(HANDLES);
  store.put({ id: input.handleId, handle: saved.handle, createdAt: saved.createdAt });
  store.delete(replacement.input.handleId);
  await completed(transaction);
  const relinked = { ...replacement.input, handleId: input.handleId };
  selectedInputs.set(replacement.file, relinked);
  return { status: "ready", file: replacement.file, input: relinked };
}

let database: Promise<IDBDatabase> | undefined, persistenceRequested = false;

function openDatabase() {
  if (!persistenceRequested && typeof navigator !== "undefined") {
    persistenceRequested = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 5);
    opening.onupgradeneeded = (event) => {
      const names = opening.result.objectStoreNames;
      const migrate = names.contains(DRAFTS) &&
        (!names.contains(METADATA) || event.oldVersion < 5);
      for (const name of [DRAFTS, METADATA, HANDLES, FILES, OUTPUTS]) {
        if (!names.contains(name)) opening.result.createObjectStore(name, { keyPath: "id" });
      }
      if (migrate) {
        const metadata = opening.transaction!.objectStore(METADATA);
        const cursor = opening.transaction!.objectStore(DRAFTS).openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          metadata.put(draftMetadata(cursor.result.value as WorkProduct));
          cursor.result.continue();
        };
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

function draftMetadata({ state, ...metadata }: WorkProduct): WorkProductMetadata {
  const profileId = metadata.kind === "court-record" && state && typeof state === "object" &&
    "profileId" in state && typeof state.profileId === "string" ? state.profileId : undefined;
  return { ...metadata, ...(profileId ? { profileId } : {}) };
}

async function unusedFile(directory: FileSystemDirectoryHandle, filename: string) {
  const dot = filename.lastIndexOf("."), stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? filename : `${stem} (${index})${extension}`;
    try { await directory.getFileHandle(candidate); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return directory.getFileHandle(candidate, { create: true });
      }
      throw error;
    }
  }
}

async function all<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  return request<T[]>(db.transaction(storeName).objectStore(storeName).getAll());
}

async function read<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  return request<T | undefined>(db.transaction(storeName).objectStore(storeName).get(key));
}

async function exists(storeName: string, key: IDBValidKey) {
  const db = await openDatabase();
  return await request(db.transaction(storeName).objectStore(storeName).getKey(key)) !== undefined;
}

function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function storedOutput(value: StoredOutput) {
  return { documentId: value.documentId, versionId: value.id, filename: value.filename,
    mimeType: value.mimeType, sha256: value.sha256, pageCount: value.pageCount };
}

function exactOutput(stored: StoredOutput, workProductId: string, role: string,
  output: WorkProduct["outputs"][string]) {
  const saved = storedOutput(stored);
  return stored.workProductId === workProductId && stored.role === role &&
    Object.entries(output).every(([key, value]) =>
      saved[key as keyof typeof output] === value);
}

async function digestBytes(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function snapshotFile(file: File) {
  return { ...fileSnapshot(file), sha256: await digestBytes(new Uint8Array(await file.arrayBuffer())) };
}
