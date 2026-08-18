import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let localData: string | null = null;

async function service() {
  localData = await mkdtemp(path.join(os.tmpdir(), "document-projection-"));
  process.env.MIKE_LOCAL_DATA_DIR = localData;
  vi.resetModules();
  return (await import("../documentProjectionService")).documentProjectionService;
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (localData) await rm(localData, { recursive: true, force: true });
  localData = null;
});

describe("DocumentProjectionService", () => {
  it("returns the same immutable SourceDoc cold and from the persistent cache", async () => {
    const projections = await service();
    const input = {
      documentId: "document-a",
      versionId: "version-1",
      fileType: "txt",
      bytes: Buffer.from("Parsed é—🦫 text\r\nwith\tstable bytes"),
    } as const;
    const cold = await projections.read(input);
    await projections.clear({ documentId: input.documentId, versionId: input.versionId });
    const hit = await projections.read(input);

    expect(hit).toEqual(cold);
    expect(hit.kind).toBe("source-doc");
    expect("sourceDoc" in hit && hit.sourceDoc.id).toBe("document-a:version-1");
    const root = path.join(localData!, "projections", "v1", "read");
    const files = await readdir(root,
      { recursive: true });
    expect(files.filter((name) => path.basename(name) === "projection.json")).toHaveLength(1);
    const cache = path.join(root, files.find((name) => path.basename(name) === "projection.json")!);
    const poisoned = JSON.parse(await readFile(cache, "utf8"));
    poisoned.projection.sourceDoc.text = "poisoned cache";
    await writeFile(cache, JSON.stringify(poisoned));
    await projections.clear({ documentId: input.documentId, versionId: input.versionId });
    expect(await projections.read(input)).toEqual(cold);
  });

  it("binds document, version, source SHA-256, compiler, and material options", async () => {
    const projections = await service();
    const bytes = Buffer.from("same source");
    const base = { documentId: "document-a", versionId: "version-1",
      fileType: "txt", bytes } as const;
    await projections.read(base);
    await projections.read({ ...base, versionId: "version-2" });
    await projections.read({ ...base, documentId: "document-b" });
    await projections.read({ ...base, bytes: Buffer.from("changed source") });
    await projections.read(base, { material: { view: "quoted" } });

    const files = await readdir(path.join(localData!, "projections", "v1", "read"),
      { recursive: true });
    expect(files.filter((name) => path.basename(name) === "projection.json")).toHaveLength(5);
  });

  it("rejects unsafe paths, source mismatches, and aborted work", async () => {
    const projections = await service();
    const base = { documentId: "document-a", versionId: "version-1",
      fileType: "txt", bytes: Buffer.from("source") } as const;
    await expect(projections.read({ ...base, localPath: path.join(os.tmpdir(), "outside.txt") }))
      .rejects.toThrow(/outside local data/u);
    await expect(projections.read({ ...base, sourceSha256: "0".repeat(64) }))
      .rejects.toThrow(/no longer match/u);
    const controller = new AbortController();
    controller.abort();
    await expect(projections.read(base, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
