import { describe, expect, it, vi } from "vitest";
import { authorityPdfOcrText } from "./authorityPdfText";

describe("authority PDF text preparation", () => {
  it("returns text only for pages routed through the existing OCR runtime", async () => {
    const preparePdf = vi.fn(async () => ({ sourceSha256: "a".repeat(64),
      parserVersion: "legal-pdf", cacheKey: "b".repeat(64), pageCount: 3,
      projectionPageCount: 3, status: "ready" as const, pagesNeedingOcr: [],
      ocrRoutedPages: [0, 2], profile: { ocr: { provider: "kraken-lite" as const,
        settings: {} } } }));
    const lookupPdf = vi.fn(async () => ({ status: "found" as const,
      pages: [{ page_number: 1, text: "First scanned page" },
        { page_number: 2, text: "Native page" },
        { page_number: 3, text: "Third scanned page" }] }));
    const bytes = Buffer.from("source");

    await expect(authorityPdfOcrText({ bytes },
      { preparePdf, lookupPdf } as never)).resolves.toEqual([
      "First scanned page", "", "Third scanned page",
    ]);
    expect(preparePdf).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.stringMatching(/^standalone-authority:/u),
      versionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ocrProvider: "kraken-lite",
    }));
  });
});
