import {
  fileSnapshot,
  workProductInputs,
  type InputResolution,
  type WorkProduct,
  type WorkProductInput,
  type WorkProductStore,
} from "./workProducts";

const DATABASE = "beaver-work-products";
const DRAFTS = "drafts";
const HANDLES = "fileHandles";
const OUTPUTS = "outputs";
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
type StoredHandle = { id: string; handle: FileSystemFileHandle; createdAt: number };

export const standaloneWorkProducts: WorkProductStore = {
  async list(kind) {
    const drafts = await all<WorkProduct>(DRAFTS);
    return drafts.filter((draft) => draft.kind === kind)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) as never;
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
    const database = await openDatabase(), transaction = database.transaction(DRAFTS, "readwrite");
    const store = transaction.objectStore(DRAFTS);
    assertDependencies(draft.id, draft.state, await request<WorkProduct[]>(store.getAll()));
    store.add(draft);
    await completed(transaction);
    return draft as never;
  },
  async update(id, patch) {
    const database = await openDatabase();
    const transaction = database.transaction([DRAFTS, HANDLES], "readwrite");
    const store = transaction.objectStore(DRAFTS);
    const drafts = await request<WorkProduct[]>(store.getAll());
    const current = drafts.find((draft) => draft.id === id);
    if (!current) throw new Error("This draft no longer exists.");
    if (current.revision !== patch.revision) throw new Error("This draft changed elsewhere. Reopen it and try again.");
    if (patch.outputs !== undefined) {
      throw new Error("Standalone outputs must be saved with their built artifacts.");
    }
    const next: WorkProduct = {
      ...current,
      title: patch.title === undefined ? current.title : draftTitle(patch.title),
      projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
      state: patch.state === undefined ? current.state : patch.state,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    assertDependencies(id, next.state, drafts);
    store.put(next);
    await cleanupHandles(transaction.objectStore(HANDLES), [
      ...drafts.filter((draft) => draft.id !== id), next,
    ], handleIds(current));
    await completed(transaction);
    return next as never;
  },
  async duplicate(id, input = {}) {
    const database = await openDatabase(), transaction = database.transaction(DRAFTS, "readwrite");
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
    await completed(transaction);
    return copy as never;
  },
  async remove(id) {
    const database = await openDatabase();
    const transaction = database.transaction([DRAFTS, HANDLES, OUTPUTS], "readwrite");
    const store = transaction.objectStore(DRAFTS), outputStore = transaction.objectStore(OUTPUTS);
    const [drafts, outputs] = await Promise.all([
      request<WorkProduct[]>(store.getAll()), request<StoredOutput[]>(outputStore.getAll()),
    ]);
    const current = drafts.find((draft) => draft.id === id);
    if (!current) throw new Error("This draft no longer exists.");
    store.delete(id);
    for (const output of outputs) if (output.workProductId === id) outputStore.delete(output.id);
    await cleanupHandles(transaction.objectStore(HANDLES),
      drafts.filter((draft) => draft.id !== id), handleIds(current));
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
  const transaction = database.transaction([DRAFTS, OUTPUTS], "readwrite");
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
    .filter(({ id }) => !used.has(id)).sort((left, right) => right.createdAt - left.createdAt);
  const cutoff = Date.now() - UNCLAIMED_HANDLE_MAX_AGE;
  unclaimed.forEach((item, index) => {
    if (removed.has(item.id) || item.createdAt < cutoff || index >= maximum) store.delete(item.id);
  });
}

type PickerWindow = Window & typeof globalThis & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle[]>;
};
type PermissionFileHandle = FileSystemFileHandle & {
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};

export function canRetainLocalFiles() {
  return typeof window !== "undefined" &&
    typeof (window as PickerWindow).showOpenFilePicker === "function";
}

export async function pickRetainedFiles(multiple: boolean): Promise<Array<{
  file: File; input: Extract<WorkProductInput, { kind: "local-file" }>;
}>> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (!picker) return [];
  const handles = await picker({
    multiple,
    types: [{
      description: "PDF or Word document",
      accept: {
        "application/pdf": [".pdf"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      },
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
  return selected.map(({ file, handleId }) => ({
    file, input: { kind: "local-file", handleId, lastSeen: fileSnapshot(file) },
  }));
}

export async function resolveLocalFile(input: WorkProductInput): Promise<InputResolution> {
  if (input.kind !== "local-file") return { status: "missing", reason: "unavailable" };
  const saved = await read<{ id: string; handle: FileSystemFileHandle }>(HANDLES, input.handleId);
  if (!saved) return { status: "missing", reason: "deleted" };
  return resolveRetainedFile(saved.handle, input);
}

export async function resolveRetainedFile(handle: FileSystemFileHandle,
  input: Extract<WorkProductInput, { kind: "local-file" }>): Promise<InputResolution> {
  try {
    const query = (handle as PermissionFileHandle).queryPermission;
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

export async function relinkLocalFile(input: WorkProductInput): Promise<InputResolution> {
  if (input.kind !== "local-file") return { status: "missing", reason: "unavailable" };
  const existing = await read<StoredHandle>(HANDLES, input.handleId);
  const requestPermission = existing && (existing.handle as PermissionFileHandle).requestPermission;
  if (existing && requestPermission) {
    try {
      if (await requestPermission.call(existing.handle, { mode: "read" }) === "granted") {
        return resolveRetainedFile(existing.handle, input);
      }
    } catch { /* The replacement picker remains available. */ }
  }
  const picked = await pickRetainedFiles(false);
  const replacement = picked[0];
  if (!replacement) return { status: "missing", reason: "unavailable" };
  const saved = await read<StoredHandle>(HANDLES, replacement.input.handleId);
  if (!saved) return { status: "missing", reason: "unavailable" };
  const database = await openDatabase(), transaction = database.transaction(HANDLES, "readwrite");
  const store = transaction.objectStore(HANDLES);
  store.put({ id: input.handleId, handle: saved.handle, createdAt: saved.createdAt });
  store.delete(replacement.input.handleId);
  await completed(transaction);
  return { status: "ready", file: replacement.file, input: { ...replacement.input, handleId: input.handleId } };
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 2);
    opening.onupgradeneeded = () => {
      for (const name of Array.from(opening.result.objectStoreNames)) {
        opening.result.deleteObjectStore(name);
      }
      opening.result.createObjectStore(DRAFTS, { keyPath: "id" });
      opening.result.createObjectStore(HANDLES, { keyPath: "id" });
      opening.result.createObjectStore(OUTPUTS, { keyPath: "id" });
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

async function all<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  return request<T[]>(db.transaction(storeName).objectStore(storeName).getAll());
}

async function read<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  return request<T | undefined>(db.transaction(storeName).objectStore(storeName).get(key));
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
