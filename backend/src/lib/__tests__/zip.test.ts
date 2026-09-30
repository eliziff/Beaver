import { describe, expect, it } from "vitest";
import { assertBoundedZip, loadZip, readZipEntry, zipReadBudget } from "../zip";

describe("bounded ZIP reads", () => {
  it("reads exact bytes and shares the expansion budget across entries", async () => {
    const JSZip = (await import("jszip")).default;
    const encoded = await new JSZip().file("first", "one").file("second", "two")
      .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zip = await loadZip(encoded), budget = zipReadBudget(5);
    expect(await readZipEntry(zip.file("first")!, 3, budget)).toEqual(Buffer.from("one"));
    expect(budget.remaining).toBe(2);
    await expect(readZipEntry(zip.file("second")!, 3, budget)).rejects.toThrow("read limit");
  });

  it("enforces streamed bytes even when declared metadata is forged", async () => {
    const JSZip = (await import("jszip")).default;
    const encoded = await new JSZip().file("large.xml", "x".repeat(1_024))
      .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zip = await loadZip(encoded), entry = zip.file("large.xml")!;
    (entry as unknown as { _data: { uncompressedSize: number } })
      ._data.uncompressedSize = 1;
    expect(() => assertBoundedZip(zip, "Fixture", {
      maxEntries: 1, maxExpandedBytes: 32,
    })).not.toThrow();
    await expect(readZipEntry(entry, 32, zipReadBudget(32), "Fixture entry"))
      .rejects.toThrow("expands beyond the read limit");
  });
});
