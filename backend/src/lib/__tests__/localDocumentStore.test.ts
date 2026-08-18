import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docxToPdf: vi.fn(async () => Buffer.from("%PDF repaired")),
}));

vi.mock("../convert", () => ({ docxToPdf: mocks.docxToPdf }));

vi.mock("../localPdfIngestion", () => ({
  queueLocalPdfParse: vi.fn(async () => ({
    status: "queued",
  })),
  peekLocalPdfParseState: vi.fn(async () => null),
  removeLocalPdfParseArtifacts: vi.fn(async () => undefined),
}));

let temporaryDirectory: string | null = null;

afterEach(async () => {
  if (temporaryDirectory) {
    try {
      const store = await import("../localDocumentStore");
      (await import("../localApplicationDatabase"))
        .closeLocalApplicationDatabase();
    } catch {}
  }
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local document store", () => {
  it("pages folders before documents and preserves literal substring search", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    await store.createLocalFolder("local-user", "file", "Authorities", null);
    for (const filename of ["Zulu.pdf", "Alpha lease.pdf", "100% brief.pdf"]) {
      await store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename,
        bytes: Buffer.from("%PDF"),
      });
    }

    const first = await store.pageLocalLibrary("local-user", "file", {
      parentFolderId: null, q: "", limit: 2, after: null,
    });
    expect(first.items.map((item) => item.kind === "folder"
      ? item.folder.name : item.document.filename)).toEqual([
      "Authorities", "100% brief.pdf",
    ]);
    const second = await store.pageLocalLibrary("local-user", "file", {
      parentFolderId: null, q: "", limit: 2, after: first.nextAfter,
    });
    expect(second.items.map((item) => item.kind === "document"
      ? item.document.filename : item.folder.name)).toEqual([
      "Alpha lease.pdf", "Zulu.pdf",
    ]);
    expect(second.nextAfter).toBeNull();

    for (const [q, filename] of [
      ["LEASE", "Alpha lease.pdf"],
      ["pha", "Alpha lease.pdf"],
      ["%", "100% brief.pdf"],
    ]) {
      const result = await store.pageLocalLibrary("local-user", "file", {
        parentFolderId: null, q, limit: 10, after: null,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].kind === "document" &&
        result.items[0].document.filename).toBe(filename);
    }
  });

  it("renders an Office document only when a PDF read requests it", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    mocks.docxToPdf.mockClear();
    const store = await import("../localDocumentStore");

    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes: Buffer.from("docx"),
    });
    expect(mocks.docxToPdf).not.toHaveBeenCalled();

    const file = await store.getLocalVersionFile(
      "local-user",
      document.id,
      document.current_version_id,
      true,
    );
    expect(file?.fileType).toBe("pdf");
    expect(mocks.docxToPdf).toHaveBeenCalledOnce();
  });

  it("persists uploaded Library files and their bytes", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const bytes = Buffer.from("%PDF-1.4 local smoke");

    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "sample.pdf",
      bytes,
    });
    const collection = await store.pageLocalDocuments("local-user", ["file"], {
      q: "", limit: 50, after: null,
    });
    const file = await store.getLocalVersionFile("local-user", document.id);

    expect(collection.items).toHaveLength(1);
    expect(collection.items[0]).toMatchObject({
      id: document.id,
      filename: "sample.pdf",
      status: "ready",
      active_version_number: 1,
    });
    expect(file).not.toBeNull();
    expect(await readFile(file!.path)).toEqual(bytes);
  });

  it("durably clears assistant provenance when version bytes are replaced", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.xlsx",
      bytes: Buffer.from("assistant-created"),
      provenance: {
        schemaVersion: 1,
        actor: "assistant",
        action: "revised",
        parentVersionId: "assistant-parent",
        changeCount: 2,
      },
    });

    const replaced = await store.replaceLocalVersion({
      userId: "local-user",
      documentId: document.id,
      versionId: document.current_version_id,
      filename: "draft.xlsx",
      bytes: Buffer.from("user-replacement"),
    });

    expect(replaced?.provenance).toBeUndefined();
    (await import("../localApplicationDatabase"))
      .closeLocalApplicationDatabase();
    vi.resetModules();
    const reloadedStore = await import("../localDocumentStore");
    const reloaded = await reloadedStore.listLocalVersions(
      "local-user",
      document.id,
    );
    expect(reloaded?.versions[0].provenance).toBeUndefined();
  });

  it("accepts only one concurrent version for the same expected parent", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.xlsx",
      bytes: Buffer.from("v1"),
    });

    const results = await Promise.all([
      store.addLocalVersion({
        userId: "local-user",
        documentId: document.id,
        filename: "draft.xlsx",
        bytes: Buffer.from("v2-a"),
        expectedVersionId: document.current_version_id,
      }),
      store.addLocalVersion({
        userId: "local-user",
        documentId: document.id,
        filename: "draft.xlsx",
        bytes: Buffer.from("v2-b"),
        expectedVersionId: document.current_version_id,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(
      (await store.listLocalVersions("local-user", document.id))?.versions,
    ).toHaveLength(2);
  });

  it("persists only legal source pointers", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");

    await expect(store.listLocalLegalSources("local-user")).resolves.toEqual([]);
    const reference = await store.saveLocalLegalSource({
      userId: "local-user",
      provider: "a2aj",
      docType: "cases",
      citation: "2024 SCC 1",
      language: "en",
      dataset: "SCC",
    });
    expect(reference.id).toMatch(/^[a-f0-9]{32}$/u);
    (await import("../localApplicationDatabase"))
      .closeLocalApplicationDatabase();
    vi.resetModules();
    const reloadedStore = await import("../localDocumentStore");
    expect(await reloadedStore.listLocalLegalSources("local-user")).toEqual([
      expect.objectContaining({
        id: reference.id,
        provider: "a2aj",
        doc_type: "cases",
        citation: "2024 SCC 1",
        language: "en",
        dataset: "SCC",
      }),
    ]);
    expect(JSON.stringify(
      await reloadedStore.getLocalLegalSource("local-user", reference.id),
    )).not.toMatch(
      /(?:text|title|structure|metadata)/u,
    );
  });

  it("removes matter pointers whenever a Library document is deleted", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const graphModule = await import("../legalKnowledgeGraphStore");
    const graph = graphModule.legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      const document = await store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "record.xlsx",
        bytes: Buffer.from("record"),
      });
      graph.attachMatterDocument("local-user", matter.id, document.id);

      expect(await store.deleteLocalDocument("local-user", document.id)).toBe(
        true,
      );
      expect(graph.matterDocumentIdsAmong(
        "local-user", matter.id, [document.id])).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("pages matter documents through the attached Library database", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const graphModule = await import("../legalKnowledgeGraphStore");
    const graph = graphModule.legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      const documents = [];
      for (const filename of ["Zulu record.pdf", "Alpha lease.pdf", "Beta brief.pdf"]) {
        const document = await store.createLocalDocument({
          userId: "local-user",
          kind: "file",
          filename,
          bytes: Buffer.from("%PDF"),
        });
        documents.push(document);
        graph.attachMatterDocument("local-user", matter.id, document.id);
      }

      const first = graph.pageMatterDocuments("local-user", matter.id, {
        q: "",
        limit: 1,
        after: null,
      });
      expect(first.ids).toEqual([documents[1].id]);
      expect(first.nextAfter).not.toBeNull();
      expect(graph.pageMatterDocuments("local-user", matter.id, {
        q: "",
        limit: 2,
        after: first.nextAfter,
      }).ids).toEqual([documents[2].id, documents[0].id]);
      expect(graph.pageMatterDocuments("local-user", matter.id, {
        q: "LEASE",
        limit: 10,
        after: null,
      }).ids).toEqual([documents[1].id]);
    } finally {
      graph.close();
    }
  });

  it("removes every matter pointer when a Library folder tree is deleted", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const graphModule = await import("../legalKnowledgeGraphStore");
    const graph = graphModule.legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      const parent = await store.createLocalFolder(
        "local-user",
        "file",
        "Record",
        null,
      );
      const child = await store.createLocalFolder(
        "local-user",
        "file",
        "Authorities",
        parent!.id,
      );
      const parentDocument = await store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "record.xlsx",
        bytes: Buffer.from("record"),
      });
      const childDocument = await store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "authorities.xlsx",
        bytes: Buffer.from("authorities"),
      });
      await store.moveLocalDocument(
        "local-user",
        "file",
        parentDocument.id,
        parent!.id,
      );
      await store.moveLocalDocument(
        "local-user",
        "file",
        childDocument.id,
        child!.id,
      );
      graph.attachMatterDocument("local-user", matter.id, parentDocument.id);
      graph.attachMatterDocument("local-user", matter.id, childDocument.id);

      expect(
        await store.deleteLocalFolder("local-user", "file", parent!.id),
      ).toBe(true);
      expect(graph.matterDocumentIdsAmong("local-user", matter.id,
        [parentDocument.id, childDocument.id])).toEqual([]);
      expect((await store.pageLocalDocuments("local-user", ["file"], {
        q: "", limit: 50, after: null,
      })).items).toEqual([]);
    } finally {
      graph.close();
    }
  });
});
