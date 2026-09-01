import { describe, expect, it, vi } from "vitest";
import { canliiPdfFilename, captureCanliiDownload, matchesCanliiDownload,
  type DownloadDirectory } from "./canliiCapture";

const url = "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf";
const pdf = (name: string, body: string, lastModified: number) =>
  new File([`%PDF-${body}`], name, { type: "application/pdf", lastModified });
function directory(scans: File[][], events: string[] = []) {
  let index = 0;
  return { async *values() {
    events.push(`scan-${index}`);
    for (const file of scans[Math.min(index++, scans.length - 1)])
      yield { kind: "file" as const, name: file.name, getFile: async () => file };
  } } satisfies DownloadDirectory;
}

describe("CanLII download capture", () => {
  it("accepts the canonical filename and browser duplicate suffix only", () => {
    expect(canliiPdfFilename(url)).toBe("2009scc32.pdf");
    expect(matchesCanliiDownload("2009scc32 (2).pdf", "2009scc32.pdf")).toBe(true);
    expect(matchesCanliiDownload("another.pdf", "2009scc32.pdf")).toBe(false);
  });

  it.each([
    ["new", [], pdf("2009scc32 (1).pdf", "new", 2)],
    ["changed", [pdf("2009scc32.pdf", "old", 1)], pdf("2009scc32.pdf", "changed", 2)],
  ])("returns a %s PDF only after snapshotting and handing off", async (_case, before, after) => {
    const events: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(captureCanliiDownload(directory([before, [after], [after]], events), url,
      { attempts: 2, pollMs: 0, handoff: () => events.push("handoff") })).resolves.toBe(after);
    expect(events).toEqual(["scan-0", "handoff", "scan-1", "scan-2"]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("never accepts a pre-existing unchanged PDF", async () => {
    const existing = pdf("2009scc32.pdf", "existing", Date.now());
    await expect(captureCanliiDownload(directory([[existing], [existing]]), url,
      { attempts: 1, pollMs: 0 })).resolves.toBeNull();
  });

  it("waits until a changed download stops growing", async () => {
    const partial = pdf("2009scc32.pdf", "partial", 2);
    const complete = pdf("2009scc32.pdf", "complete", 3);
    await expect(captureCanliiDownload(directory([[], [partial], [complete], [complete]]), url,
      { attempts: 3, pollMs: 0 })).resolves.toBe(complete);
  });
});
