import { afterEach, describe, expect, it, vi } from "vitest";
import { bindStandaloneFile, chooseStandaloneOutputFolder, clearStandaloneOutputFolder,
  getStandaloneOutputFolder, inspectStandaloneFile, listStandaloneOutputs, pickRetainedFiles,
  readStandaloneOutput, resolveRetainedFile, resolveStandaloneFile,
  saveStandaloneArtifacts, standaloneWorkProducts,
  writeStandaloneArtifactsToOutputFolder } from "./standaloneWorkProducts";

const input = { kind: "local-file" as const, handleId: "handle-1", lastSeen: {
  name: "brief.pdf", size: 3, modified: 10, sha256: "a".repeat(64),
} };

describe("standalone retained files", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a known hash only while metadata still matches", async () => {
    const same = new File(["abc"], "brief.pdf", { lastModified: 10 });
    const changed = new File(["abcd"], "brief.pdf", { lastModified: 11 });
    const handle = (file: File) => ({ queryPermission: vi.fn(async () => "granted"),
      getFile: vi.fn(async () => file) }) as unknown as FileSystemFileHandle;

    await expect(resolveRetainedFile(handle(same), input)).resolves.toMatchObject({
      status: "ready", input: { lastSeen: { sha256: "a".repeat(64) } },
    });
    await expect(resolveRetainedFile(handle(changed), input)).resolves.toEqual({
      status: "changed", file: changed,
      input: { ...input, lastSeen: { name: "brief.pdf", size: 4, modified: 11 } },
    });
  });

  it("returns an actionable state when access is denied or the file moved", async () => {
    const denied = { queryPermission: vi.fn(async () => "denied"), getFile: vi.fn() };
    await expect(resolveRetainedFile(denied as unknown as FileSystemFileHandle, input))
      .resolves.toEqual({ status: "missing", reason: "permission" });
    expect(denied.getFile).not.toHaveBeenCalled();

    const moved = { queryPermission: vi.fn(async () => "granted"),
      getFile: vi.fn(async () => { throw new DOMException("gone", "NotFoundError"); }) };
    await expect(resolveRetainedFile(moved as unknown as FileSystemFileHandle, input))
      .resolves.toEqual({ status: "missing", reason: "deleted" });
  });

  it("atomically retains only current named outputs and cleans Draft-owned records", async () => {
    const memory = memoryIndexedDb();
    vi.stubGlobal("indexedDB", memory.factory);
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist } });
    const written = new Map<string, Uint8Array>(), permission = vi.fn(async () => "granted"),
      requestPermission = vi.fn(), handles = Array.from({ length: 70 }, (_, index) => fileHandle(index)),
      picker = vi.fn().mockResolvedValueOnce(handles).mockResolvedValueOnce([fileHandle(70)]),
      outputFiles = new Set<string>(),
      directory = { kind: "directory", name: "Court outputs", queryPermission: permission,
        requestPermission, getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
          if (!options?.create && !outputFiles.has(name)) {
            throw new DOMException("missing", "NotFoundError");
          }
          outputFiles.add(name);
          return {
          createWritable: vi.fn(async () => ({
            write: vi.fn(async (bytes: ArrayBuffer) => {
              written.set(name, new Uint8Array(bytes.slice(0)));
            }),
            close: vi.fn(async () => undefined),
          })),
        };
        }) } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal("window", { showOpenFilePicker: picker,
      showDirectoryPicker: vi.fn(async () => directory) });
    await expect(chooseStandaloneOutputFolder()).resolves.toBe("Court outputs");
    await expect(getStandaloneOutputFolder()).resolves.toBe("Court outputs");
    const draft = await standaloneWorkProducts.create({ kind: "court-record", title: "Record",
      state: { bindings: {} } });
    expect(memory.stores.has("legacy")).toBe(true);
    expect(memory.stores.get("metadata")?.get("existing")).toEqual({
      id: "existing", kind: "authorities", title: "Existing", projectId: null,
      revision: 1, createdAt: "2025-01-01", updatedAt: "2025-01-01",
    });
    const draftReads = memory.getAllCalls.get("drafts") ?? 0;
    await expect(standaloneWorkProducts.listMetadata!("court-record")).resolves.toEqual([{
      id: draft.id, kind: draft.kind, title: draft.title, projectId: null,
      revision: draft.revision, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
    }]);
    expect(memory.getAllCalls.get("drafts")).toBe(draftReads);
    expect(persist).toHaveBeenCalledTimes(1);
    const generated = new File(["%PDF-generated"], "Case.pdf", { type: "application/pdf" });
    const generatedInput = await bindStandaloneFile(generated), secondInput =
      await bindStandaloneFile(new File(["%PDF-second"], "Second.pdf",
        { type: "application/pdf" }));
    const generatedDraft = await standaloneWorkProducts.create({ kind: "authorities",
      title: "Book", state: { bindings: { case: generatedInput, second: secondInput } } });
    expect(generatedInput.handleId).toMatch(/^stored:[a-f0-9]{64}$/);
    await expect(inspectStandaloneFile(generatedInput)).resolves.toEqual({ status: "ready" });
    await expect(resolveStandaloneFile(generatedInput, true)).resolves.toMatchObject({
      status: "ready", file: { name: "Case.pdf", size: generated.size },
    });
    expect(memory.stores.get("files")?.size).toBe(2);
    await standaloneWorkProducts.remove(generatedDraft.id);
    expect(memory.stores.get("files")?.size).toBe(0);
    await expect(inspectStandaloneFile(generatedInput)).resolves.toEqual({
      status: "missing", reason: "deleted",
    });

    const stagedFile = new File(["%PDF-staged"], "Staged.pdf", { lastModified: 11 });
    const stagedInput = await bindStandaloneFile(stagedFile);
    const blank = await standaloneWorkProducts.create({ kind: "authorities", title: "Blank",
      state: { bindings: {} } });
    expect(memory.stores.get("files")?.size).toBe(0);
    const rebound = await bindStandaloneFile(stagedFile, stagedInput);
    const connected = await standaloneWorkProducts.update(blank.id, { revision: blank.revision,
      state: { bindings: { source: rebound } } });
    await expect(resolveStandaloneFile(rebound, true)).resolves.toMatchObject({ status: "ready" });
    await standaloneWorkProducts.remove(connected.id);
    expect(memory.stores.get("files")?.size).toBe(0);

    const bytes = new Uint8Array([1, 2, 3]), firstHash = await digest(bytes);
    const folderArtifact = { role: "record", filename: "Record.pdf", mimeType: "application/pdf",
      sha256: firstHash, pageCount: 1, bytes, receipt: {} };
    await expect(writeStandaloneArtifactsToOutputFolder([folderArtifact])).resolves.toBeNull();
    expect(written.get("Record.pdf")).toEqual(bytes);
    const collisionBytes = new Uint8Array([9, 8, 7]);
    await expect(writeStandaloneArtifactsToOutputFolder([{ ...folderArtifact,
      sha256: await digest(collisionBytes), bytes: collisionBytes }])).resolves.toBeNull();
    expect(written.get("Record.pdf")).toEqual(bytes);
    expect(written.get("Record (2).pdf")).toEqual(collisionBytes);
    permission.mockResolvedValueOnce("denied");
    await expect(writeStandaloneArtifactsToOutputFolder([folderArtifact]))
      .resolves.toContain("ready to download");
    expect(requestPermission).not.toHaveBeenCalled();
    const first = await saveStandaloneArtifacts(draft, [{ role: "record",
      filename: "Record.pdf", mimeType: "application/pdf", sha256: firstHash,
      pageCount: 1, bytes, receipt: { build: 1 } }]);
    expect(first).toMatchObject({ revision: 2, outputs: { record: {
      filename: "Record.pdf", sha256: firstHash } } });
    await expect(listStandaloneOutputs()).resolves.toMatchObject([{ product: { id: draft.id },
      role: "record", output: { versionId: first.outputs.record.versionId } }]);

    const rebuiltBytes = new Uint8Array([4, 5, 6]), rebuiltHash = await digest(rebuiltBytes);
    const rebuilt = await saveStandaloneArtifacts(first, [{ role: "record",
      filename: "Record.pdf", mimeType: "application/pdf", sha256: rebuiltHash,
      pageCount: 1, bytes: rebuiltBytes, receipt: { build: 2 } }]);
    expect(rebuilt.outputs.record.documentId).toBe(first.outputs.record.documentId);
    expect(rebuilt.outputs.record.versionId).not.toBe(first.outputs.record.versionId);
    await expect(readStandaloneOutput(draft.id, "record", first.outputs.record.versionId))
      .rejects.toThrow("output is unavailable");
    await expect(readStandaloneOutput(draft.id, "record"))
      .resolves.toMatchObject({ bytes: rebuiltBytes, receipt: { build: 2 } });
    expect(memory.stores.get("outputs")?.size).toBe(1);

    await expect(saveStandaloneArtifacts(first, [{ role: "record", filename: "Record.pdf",
      mimeType: "application/pdf", sha256: rebuiltHash, pageCount: 1,
      bytes: rebuiltBytes, receipt: {} }])).rejects.toThrow("changed elsewhere");
    await expect(saveStandaloneArtifacts(rebuilt, [{ role: "record", filename: "Record.pdf",
      mimeType: "application/pdf", sha256: firstHash, pageCount: 1,
      bytes: rebuiltBytes, receipt: {} }])).rejects.toThrow("bytes do not match");
    expect(memory.stores.get("outputs")?.size).toBe(1);

    const renamed = await standaloneWorkProducts.update(rebuilt.id, {
      revision: rebuilt.revision, title: "Renamed record",
    });
    expect(renamed.outputs).toEqual({});
    expect(memory.stores.get("outputs")?.size).toBe(0);
    await expect(listStandaloneOutputs()).resolves.toEqual([]);
    const rebuiltAgain = await saveStandaloneArtifacts(renamed, [{ role: "record",
      filename: "Record.pdf", mimeType: "application/pdf", sha256: rebuiltHash,
      pageCount: 1, bytes: rebuiltBytes, receipt: { build: 3 } }]);
    const edited = await standaloneWorkProducts.update(rebuiltAgain.id, {
      revision: rebuiltAgain.revision, state: { bindings: {} },
    });
    expect(edited.outputs).toEqual({});
    expect(memory.stores.get("outputs")?.size).toBe(0);

    await standaloneWorkProducts.remove(draft.id);
    expect(memory.stores.get("outputs")?.size).toBe(0);
    await expect(readStandaloneOutput(draft.id, "record"))
      .rejects.toThrow("connected draft no longer exists");

    const retained = await pickRetainedFiles(true);
    expect((await bindStandaloneFile(retained[0].file)).handleId)
      .toBe(retained[0].input.handleId);
    expect(memory.stores.get("fileHandles")?.size).toBe(71);
    await pickRetainedFiles(false, "pdf");
    expect(picker.mock.calls[1][0].types[0].accept).toEqual({ "application/pdf": [".pdf"] });
    expect(memory.stores.get("fileHandles")?.size).toBe(65);
    await expect(getStandaloneOutputFolder()).resolves.toBe("Court outputs");
    await clearStandaloneOutputFolder();
    await expect(getStandaloneOutputFolder()).resolves.toBeNull();
  });
});

async function digest(bytes: Uint8Array) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fileHandle(index: number) {
  return { kind: "file", name: `file-${index}.pdf`,
    getFile: vi.fn(async () => new File([String(index)], `file-${index}.pdf`, {
    type: "application/pdf", lastModified: index,
  })) } as unknown as FileSystemFileHandle;
}

function memoryIndexedDb() {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const getAllCalls = new Map<string, number>();
  stores.set("legacy", new Map([["obsolete", true]]));
  stores.set("drafts", new Map([["existing", { id: "existing", kind: "authorities",
    title: "Existing", projectId: null, revision: 1, state: { large: "state" }, outputs: {},
    createdAt: "2025-01-01", updatedAt: "2025-01-01" }]]));
  for (const name of ["fileHandles", "files", "outputs"]) stores.set(name, new Map());
  class Transaction {
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error: DOMException | null = null;
    private pending = 0;
    private completion: ReturnType<typeof setTimeout> | undefined;

    objectStore(name: string) {
      const values = stores.get(name);
      if (!values) throw new Error(`Missing store ${name}`);
      const operation = <T>(run: () => T) => {
        const result = { result: undefined as T, error: null as DOMException | null,
          onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        this.pending += 1;
        if (this.completion) clearTimeout(this.completion);
        queueMicrotask(() => {
          try { result.result = run(); result.onsuccess?.(); }
          catch (error) {
            result.error = error instanceof DOMException ? error : new DOMException(String(error));
            this.error = result.error;
            result.onerror?.();
            this.onerror?.();
          } finally {
            this.pending -= 1;
            if (!this.pending) this.completion = setTimeout(() => this.oncomplete?.(), 0);
          }
        });
        return result as unknown as IDBRequest<T>;
      };
      return {
        getAll: () => operation(() => {
          getAllCalls.set(name, (getAllCalls.get(name) ?? 0) + 1);
          return [...values.values()];
        }),
        getAllKeys: () => operation(() => [...values.keys()]),
        get: (key: IDBValidKey) => operation(() => values.get(key)),
        getKey: (key: IDBValidKey) => operation(() => values.has(key) ? key : undefined),
        openCursor: () => {
          const entries = [...values.values()]; let index = 0;
          const cursor = { result: null as IDBCursorWithValue | null,
            onsuccess: null as (() => void) | null, onerror: null };
          const next = () => queueMicrotask(() => {
            cursor.result = index < entries.length ? { value: entries[index],
              continue: () => { index += 1; next(); } } as IDBCursorWithValue : null;
            cursor.onsuccess?.();
          });
          next();
          return cursor as unknown as IDBRequest<IDBCursorWithValue | null>;
        },
        add: (value: { id: IDBValidKey }) => operation(() => {
          if (values.has(value.id)) throw new DOMException("Duplicate", "ConstraintError");
          values.set(value.id, value); return value.id;
        }),
        put: (value: { id: IDBValidKey }) => operation(() => {
          values.set(value.id, value); return value.id;
        }),
        delete: (key: IDBValidKey) => operation(() => { values.delete(key); }),
      } as unknown as IDBObjectStore;
    }
  }
  const db = {
    get objectStoreNames() {
      const names = [...stores.keys()] as string[] & { contains(name: string): boolean };
      names.contains = (name) => stores.has(name);
      return names;
    },
    createObjectStore(name: string) { stores.set(name, new Map()); },
    deleteObjectStore(name: string) { stores.delete(name); },
    transaction: () => new Transaction(),
  };
  let opened = false;
  const factory = { open: () => {
    const opening = { result: db, error: null, transaction: new Transaction(),
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => {
      if (!opened) { opened = true; opening.onupgradeneeded?.(); }
      setTimeout(() => opening.onsuccess?.(), 0);
    });
    return opening as unknown as IDBOpenDBRequest;
  } } as unknown as IDBFactory;
  return { factory, stores, getAllCalls };
}
