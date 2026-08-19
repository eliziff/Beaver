import { describe, expect, it, vi } from "vitest";

const runLegalPdf = vi.hoisted(() => vi.fn());
const runLegalPdfContract = vi.hoisted(() => vi.fn());

vi.mock("../legalPdfProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../legalPdfProcess")>()),
  runLegalPdf,
  runLegalPdfContract,
}));

import { lookupSourceDoc } from "../sourceDoc";
import {
  parseLegalPdfSourceDoc,
  readLegalPdfSourceDoc,
} from "../legalPdfSourceDoc";

describe("legal PDF SourceDoc adapter", () => {
  it("reads the engine's provider-neutral SourceDoc contract", async () => {
    runLegalPdfContract.mockResolvedValueOnce({
      schema_version: "legalpdf.source-doc.v1",
      source_doc: {
        provider: "local-pdf",
        id: "pdf-1",
        url: null,
        text: "[page 101]\nThe rule.\n\n[footnote 1]\nThe note.",
        blocks: [
          { kind: "page", label: "page101", start: 0, end: 20,
            origin: "heuristic", anchor: "page=1", aliases: ["1", "101"] },
          { kind: "section", label: "sec7", start: 11, end: 20,
            origin: "heuristic", anchor: "section-7", aliases: ["7"] },
          { kind: "footnote", label: "fn1", start: 35, end: 44,
            origin: "heuristic", anchor: "pair-1", aliases: ["1"] },
        ],
      },
    });

    const doc = await readLegalPdfSourceDoc("C:\\artifacts", { id: "pdf-1" });

    expect(runLegalPdfContract).toHaveBeenCalledWith(
      "C:\\artifacts",
      "source_doc",
      { id: "pdf-1", url: undefined },
      { maxBuffer: 64 * 1024 * 1024 },
    );
    expect(lookupSourceDoc(doc, "section", "7")).toMatchObject({
      status: "found",
      block: { anchor: "section-7", text: "The rule." },
    });
    expect(lookupSourceDoc(doc, "footnote", "1")).toMatchObject({
      status: "found",
      block: { anchor: "pair-1", text: "The note." },
    });
  });

  it("rejects an invalid engine contract", async () => {
    runLegalPdfContract.mockResolvedValueOnce({
      schema_version: "legalpdf.source-doc.v0",
      source_doc: {},
    });
    await expect(readLegalPdfSourceDoc("C:\\artifacts"))
      .rejects.toThrow("invalid SourceDoc");
  });

  it("requests geometry-free pages for transient text extraction", async () => {
    runLegalPdf.mockRejectedValueOnce(new Error("stop after argv"));

    await expect(parseLegalPdfSourceDoc(Buffer.from("pdf"))).rejects.toThrow(
      "stop after argv",
    );
    expect(runLegalPdf.mock.calls[0]?.[0]).toContain("--compact-pages");
  });
});
