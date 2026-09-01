import { describe, expect, it, vi } from "vitest";
import { authorityPdfText } from "./authorityPdfText";

describe("authority PDF text preparation", () => {
  it("keeps every page's projection text and identifies only OCR-routed text", async () => {
    const preparePdf = vi.fn(async () => ({ sourceSha256: "a".repeat(64),
      parserVersion: "legal-pdf", cacheKey: "b".repeat(64), pageCount: 3,
      projectionPageCount: 3, status: "ready" as const, pagesNeedingOcr: [],
      ocrRoutedPages: [0, 2], profile: { ocr: { provider: "kraken-lite" as const,
        settings: {} } } }));
    const pageText = ["First scanned page", "Native page", "Third scanned page"];
    const lookupPdf = vi.fn(async (_read, input: { locator: string }) => {
      const page = Number(input.locator);
      return page > 0 && page <= pageText.length ? { status: "found" as const,
        pages: [{ page_number: page, text: pageText[page - 1] }] }
        : { status: "not_found" as const, pages: [] };
    });
    const bytes = Buffer.from("source");

    await expect(authorityPdfText({ bytes },
      { preparePdf, lookupPdf } as never)).resolves.toEqual({
      pageTextByPage: ["First scanned page", "Native page", "Third scanned page"],
      ocrTextByPage: ["First scanned page", "", "Third scanned page"],
    });
    expect(preparePdf).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.stringMatching(/^standalone-authority:/u),
      versionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ocrProvider: "kraken-lite",
    }));
  });

  it("keeps a degraded PDF when a page has no exact structural text", async () => {
    const preparePdf = vi.fn(async () => ({ sourceSha256: "a".repeat(64),
      parserVersion: "legal-pdf", cacheKey: "b".repeat(64), pageCount: 2,
      projectionPageCount: 2, status: "degraded" as const, pagesNeedingOcr: [],
      ocrRoutedPages: [], profile: {} }));
    const lookupPdf = vi.fn(async (_read, input: { locator: string }) =>
      input.locator === "1" ? { status: "found" as const,
        pages: [{ page_number: 1, text: "Exact text" }] }
        : { status: "unavailable" as const, pages: [] });

    await expect(authorityPdfText({ bytes: Buffer.from("source") },
      { preparePdf, lookupPdf } as never)).resolves.toMatchObject({
      pageTextByPage: ["Exact text", ""], ocrTextByPage: ["", ""],
    });
  });
});
