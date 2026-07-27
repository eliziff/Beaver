import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../localPdfIngestion", () => ({
  queueLocalPdfParse: vi.fn(async () => ({
    status: "queued",
    flat_text_fallback_available: true,
  })),
  removeLocalPdfParseArtifacts: vi.fn(async () => undefined),
}));

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local document store", () => {
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
    const collection = await store.listLocalLibrary("local-user", "file");
    const file = await store.getLocalVersionFile("local-user", document.id);

    expect(collection.documents).toHaveLength(1);
    expect(collection.documents[0]).toMatchObject({
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
    const persisted = JSON.parse(
      await readFile(path.join(temporaryDirectory, "library.json"), "utf8"),
    );
    expect(persisted.documents[0].versions[0]).not.toHaveProperty("provenance");

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

  it("reads the version-1 index and persists only legal source pointers", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-local-store-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    await writeFile(
      path.join(temporaryDirectory, "library.json"),
      JSON.stringify({ version: 1, documents: [], folders: [] }),
      "utf8",
    );
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
    const persisted = JSON.parse(
      await readFile(path.join(temporaryDirectory, "library.json"), "utf8"),
    );

    expect(reference.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(persisted.version).toBe(1);
    expect(persisted.legalSources).toEqual([
      {
        id: reference.id,
        userId: "local-user",
        provider: "a2aj",
        docType: "cases",
        citation: "2024 SCC 1",
        language: "en",
        dataset: "SCC",
      },
    ]);
    expect(JSON.stringify(persisted.legalSources)).not.toMatch(
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
      expect(graph.listMatterDocumentIds("local-user", matter.id)).toEqual([]);
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
      expect(graph.listMatterDocumentIds("local-user", matter.id)).toEqual([]);
      expect((await store.listLocalLibrary("local-user", "file")).documents).toEqual(
        [],
      );
    } finally {
      graph.close();
    }
  });
});
