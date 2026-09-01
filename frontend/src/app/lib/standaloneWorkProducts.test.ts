import { afterEach, describe, expect, it, vi } from "vitest";
import { bindStandaloneFile, canRetainLocalFiles, listStandaloneOutputs, pickRetainedFiles,
  readStandaloneOutput, resolveRetainedFile, resolveStandaloneFile,
  saveStandaloneArtifacts, standaloneWorkProducts } from "./standaloneWorkProducts";

const input = { kind: "local-file" as const, handleId: "handle-1", lastSeen: {
  name: "brief.pdf", size: 3, modified: 10, sha256: "a".repeat(64),
} };

describe("standalone retained files", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads safely outside a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(canRetainLocalFiles()).toBe(false);
  });

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

  it("keeps a directly added file available for the browser session", async () => {
    const file = new File(["brief"], "brief.pdf", { lastModified: 10 });
    const binding = await bindStandaloneFile(file);

    expect(binding).toMatchObject({ kind: "local-file", handleId: expect.stringMatching(/^session:/),
      lastSeen: { name: "brief.pdf", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    await expect(resolveStandaloneFile(binding)).resolves.toMatchObject({
      status: "ready", file, input: binding,
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
    const draft = await standaloneWorkProducts.create({ kind: "court-record", title: "Record",
      state: { bindings: {} } });
    expect(memory.stores.has("legacy")).toBe(false);
    const bytes = new Uint8Array([1, 2, 3]), firstHash = await digest(bytes);
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

    await standaloneWorkProducts.remove(draft.id);
    expect(memory.stores.get("outputs")?.size).toBe(0);
    await expect(readStandaloneOutput(draft.id, "record"))
      .rejects.toThrow("connected draft no longer exists");

    const handles = Array.from({ length: 70 }, (_, index) => fileHandle(index));
    vi.stubGlobal("window", { showOpenFilePicker: vi.fn()
      .mockResolvedValueOnce(handles).mockResolvedValueOnce([fileHandle(70)]) });
    const retained = await pickRetainedFiles(true);
    expect((await bindStandaloneFile(retained[0].file)).handleId)
      .toBe(retained[0].input.handleId);
    expect(memory.stores.get("fileHandles")?.size).toBe(70);
    await pickRetainedFiles(false);
    expect(memory.stores.get("fileHandles")?.size).toBe(64);
  });
});

async function digest(bytes: Uint8Array) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fileHandle(index: number) {
  return { getFile: vi.fn(async () => new File([String(index)], `file-${index}.pdf`, {
    type: "application/pdf", lastModified: index,
  })) } as unknown as FileSystemFileHandle;
}

function memoryIndexedDb() {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  stores.set("legacy", new Map([["obsolete", true]]));
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
        getAll: () => operation(() => [...values.values()]),
        get: (key: IDBValidKey) => operation(() => values.get(key)),
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
    const opening = { result: db, error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    queueMicrotask(() => {
      if (!opened) { opened = true; opening.onupgradeneeded?.(); }
      opening.onsuccess?.();
    });
    return opening as unknown as IDBOpenDBRequest;
  } } as unknown as IDBFactory;
  return { factory, stores };
}
