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
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-local-store-"));
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

  it("reads the version-1 index and persists only legal source pointers", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-local-store-"));
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
});
