import { beforeEach, describe, expect, it, vi } from "vitest";

const runLegalPdfDocument = vi.hoisted(() => vi.fn());
vi.mock("../legalPdfProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../legalPdfProcess")>()),
  runLegalPdfDocument,
}));

import { lookupSourceDoc } from "../sourceDoc";
import {
  countLegalPdfPages,
  parseLegalPdfSourceDoc,
  readLegalPdfSourceDoc,
} from "../legalPdfSourceDoc";

const source = {
  sha256: "a".repeat(64),
  parser_version: "0.4.0",
  cache_key: "cache-key",
  cache_hit: false,
  page_count: 1,
};

function response(result: unknown, operation = "source_doc") {
  return {
    schema_version: "legalpdf.document-result.v1",
    operation,
    source,
    result,
  };
}

beforeEach(() => {
  runLegalPdfDocument.mockReset();
});

describe("legal PDF SourceDoc adapter", () => {
  it("reads the engine's provider-neutral SourceDoc contract", async () => {
    runLegalPdfDocument.mockResolvedValueOnce(response({
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
    }));

    const doc = await readLegalPdfSourceDoc("C:\\source.pdf", {
      cacheDir: "C:\\cache",
      id: "pdf-1",
    });

    expect(runLegalPdfDocument).toHaveBeenCalledWith(
      {
        operation: "source_doc",
        source_pdf: "C:\\source.pdf",
        cache_dir: "C:\\cache",
        id: "pdf-1",
      },
      { signal: undefined, maxBuffer: 64 * 1024 * 1024 },
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

  it("rejects malformed block boundaries", async () => {
    runLegalPdfDocument.mockResolvedValueOnce(response({
      schema_version: "legalpdf.source-doc.v1",
      source_doc: {
        provider: "local-pdf", id: "pdf", text: "short",
        blocks: [{ kind: "page", label: "page1", start: 0, end: 99, origin: "native" }],
      },
    }));
    await expect(readLegalPdfSourceDoc("C:\\source.pdf"))
      .rejects.toThrow("invalid SourceDoc");
  });

  it("uses inspect for page count and source_doc for transient extraction", async () => {
    runLegalPdfDocument
      .mockResolvedValueOnce(response({ page_count: 7 }, "inspect"))
      .mockResolvedValueOnce(response({
        schema_version: "legalpdf.source-doc.v1",
        source_doc: { provider: "local-pdf", id: "pdf", text: "page", blocks: [] },
      }));

    await expect(countLegalPdfPages(Buffer.from("pdf"))).resolves.toBe(7);
    await expect(parseLegalPdfSourceDoc(Buffer.from("pdf")))
      .resolves.toMatchObject({ provider: "local-pdf", text: "page" });
    expect(runLegalPdfDocument.mock.calls.map(([request]) => request.operation))
      .toEqual(["inspect", "source_doc"]);
  });
});
