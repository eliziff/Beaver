import { resolvePdfPagination } from "./pdfPagination";
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

    await expect(authorityPdfText({ bytes, scannedPdfPolicy: "full" },
      { preparePdf, lookupPdf } as never)).resolves.toEqual({
      pageTextByPage: ["First scanned page", "Native page", "Third scanned page"],
      ocrTextByPage: ["First scanned page", "", "Third scanned page"],
    });
    await expect(authorityPdfText({ bytes, maxPages: 1 },
      { preparePdf, lookupPdf } as never)).resolves.toEqual({
      pageTextByPage: ["First scanned page"], ocrTextByPage: [""],
    });
    expect(preparePdf).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.stringMatching(/^standalone-authority:/u),
      versionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ocrProvider: null,
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
  it("finishes a retained partial OCR profile when all scanned pages are requested", async () => {
    const partial = { cacheKey: "partial", status: "ready", profile: { ocr: { provider: "kraken-lite" } } };
    let complete = false;
    const preparePdf = vi.fn(async (request) => {
      complete = request.ocrProvider === "kraken-lite";
      return { ...partial, pageCount: 2, pagesNeedingOcr: complete ? [] : [1],
        ocrRoutedPages: complete ? [0, 1] : [0] };
    });
    const lookupPdf = async (_read, input) => ({ status: "found", pages: [
      { page_number: Number(input.locator), text: input.locator === "1" ? "Retained" : complete ? "Recognized" : "" },
    ] });
    const result = await authorityPdfText({ bytes: Buffer.from("source"), scannedPdfPolicy: "full",
      pdfProfile: partial as never }, { preparePdf, lookupPdf } as never);
    expect(result.ocrTextByPage).toEqual(["Retained", "Recognized"]);
  });
  it.each(["page-margin", "cited-pages"] as const)("does not perform unrequested OCR for %s", async (policy) => {
    const preparePdf = vi.fn(async () => ({ pageCount: 1, profile: {}, pagesNeedingOcr: [0], ocrRoutedPages: [] }));
    const lookupPdf = vi.fn(async () => ({ status: "unavailable", pages: [] }));
    await authorityPdfText({ bytes: Buffer.from("source"), scannedPdfPolicy: policy },
      { preparePdf, lookupPdf } as never);
    expect(preparePdf).toHaveBeenCalledWith(expect.objectContaining({ ocrProvider: null }));
    expect(preparePdf).toHaveBeenCalledTimes(1);
  });

  it("OCRs resolved cited physical pages only and keeps all pages for the viewer", async () => {
    const preparePdf = vi.fn().mockResolvedValueOnce({ pageCount: 3, profile: {}, pagesNeedingOcr: [2], ocrRoutedPages: [] })
      .mockResolvedValueOnce({ pageCount: 3, profile: { ocr: { provider: "kraken-lite" } }, pagesNeedingOcr: [], ocrRoutedPages: [2] });
    const lookupPdf = vi.fn(async (_read, input) => ({ status: "found", pages: [
      { page_number: Number(input.locator), text: `page ${input.locator}` },
    ] }));
    const pdfPassageGeometry = vi.fn(async () => ({ targets: [{ status: "found", pages: [{ pageNumber: 3 }] }] }));
    const result = await authorityPdfText({ bytes: Buffer.from("source"), scannedPdfPolicy: "cited-pages",
      ocrTargets: [{ id: "p", locatorKind: "page", locator: "42" }] },
      { preparePdf, lookupPdf, pdfPassageGeometry, pdfPagination: async () => resolvePdfPagination(["40", "41", "42"], []) } as never);
    // The engine numbers requested pages from one; cited page 3 must be requested as 3.
    expect(preparePdf.mock.calls[1][0]).toMatchObject({ ocrProvider: "kraken-lite", pages: [3] });
    expect(result.pageTextByPage).toEqual(["page 1", "page 2", "page 3"]);
    expect(result.ocrTextByPage).toEqual(["", "", "page 3"]);
  });

  it("retains the reporter anchor alongside cited pages in a partial OCR result", async () => {
    const preparePdf = vi.fn(async (request) => ({ pageCount: 8, profile: {},
      pagesNeedingOcr: Array.from({ length: 8 }, (_, i) => i).filter(i => !request.pages?.includes(i + 1)),
      ocrRoutedPages: (request.pages ?? []).map((page: number) => page - 1) }));
    const lookupPdf = vi.fn(async (_read, input) => ({ status: "found", pages: [
      { page_number: Number(input.locator), text: `page ${input.locator}` },
    ] }));
    const pdfPassageGeometry = vi.fn().mockResolvedValueOnce({ targets: [{ status: "not_found", pages: [] }] })
      .mockResolvedValue({ targets: [{ status: "found", pages: [{ pageNumber: 6 }] }] });
    const result = await authorityPdfText({ bytes: Buffer.from("source"), scannedPdfPolicy: "cited-pages",
      citations: ["[1986] 1 SCR 145"], reporterOriginal: true,
      ocrTargets: [{ id: "p", locatorKind: "page", locator: "150" }] },
      { preparePdf, lookupPdf, pdfPassageGeometry, pdfPagination: vi.fn()
        .mockResolvedValueOnce(resolvePdfPagination(Array(8).fill(null), []))
        .mockResolvedValue(resolvePdfPagination(["145", "146", "147", "148", "149", "150", "151", "152"], [])) } as never);
    expect(result.ocrTextByPage).toEqual(["page 1", "", "", "", "", "page 6", "", ""]);
  });
});
