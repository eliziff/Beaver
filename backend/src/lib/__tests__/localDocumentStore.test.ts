import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
