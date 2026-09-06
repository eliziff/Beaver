import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { quoteCheckWorkbook } from "./quoteCheckWorkbook";
import type { QuoteResult } from "./quoteCheck";
it("exports complete receipts and separate semantic analysis with wrapped frozen columns", async () => {
  const quote: QuoteResult = { id: "quote-1", unitId: "unit-1", start: 0, end: 5,
    quote: "=not a formula", context: "=not a formula", pageNumbers: [3], candidates: [],
    occurrenceId: null, linkMethod: "mechanical", status: "mismatch", detail: "Words changed",
    receipt: { source: { provider: "canlii", kind: "case", id: "case-1", title: "Baker v Canada", citation: "1999 CanLII 699", url: "https://example.test/case?x=1&y=2" }, locator: { kind: "paragraph", value: "7", endValue: "9" }, sourceSha256: "a", passageSha256: "b",
      text: "Source 😃".repeat(6000), errors: ["Not exact"], comparison: { matches: [],
        candidate: "Source words", candidateOnly: true, editorial: null,
        changes: [{ kind: "replace", authored: "draft", source: "Source" }] } } };
  const result = { mode: "mechanical", total: 1, citationUnits: [], counts: { mismatch: 1 }, quotes: [quote] };
  const bytes = await quoteCheckWorkbook("Draft.pdf", result, { "quote-1": "The proposition overstates the holding." });
  const book = XLSX.read(bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets["Quote check"], { header: 1 });
  expect(rows[0]).toContain("AI analysis");
  expect(rows[1]).toContain("The proposition overstates the holding.");
  expect(book.Sheets["Quote check"].C2).toMatchObject({ t: "s", v: "=not a formula" });
  expect(book.Sheets["Quote check"].C2.f).toBeUndefined();
  expect(book.Sheets["Quote check"].D2.v).toBe("Baker v Canada\n1999 CanLII 699\nParagraph 7–9");
  expect(book.Sheets["Quote check"].D2.l?.Target).toBe("https://example.test/case?x=1&y=2");

  expect(rows[0]).not.toContain("Quote ID");
  const evidence = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Evidence, { header: 1 });
  expect(evidence.length).toBeGreaterThan(2);
  const decoded = JSON.parse(evidence.slice(1).map((row) => row[3]).join(""));
  expect(JSON.stringify(decoded) === JSON.stringify(quote)).toBe(true);
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file("xl/styles.xml")!.async("string")).toContain('wrapText="1"');
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  expect(xml).toContain('state="frozen"');
  expect(xml).toContain('customWidth="1"');
  expect(xml).toContain('<autoFilter ref="A1:G2"');
  expect(xml).toContain('<strike/>');
  expect(xml).toContain('FF1F603D');
  expect(book.Workbook?.Sheets?.find(({ name }) => name === "Evidence")?.Hidden).toBe(1);
  await expect(quoteCheckWorkbook("Draft.pdf", result, { missing: "Unbound" })).rejects.toMatchObject({ status: 400 });
});

it("labels partial coverage even when a caller supplies the normal mode", async () => {
  const book = XLSX.read(await quoteCheckWorkbook("Draft.pdf", { mode: "mechanical", total: 3,
    quotes: [], citationUnits: [], counts: {} }), { type: "buffer" });
  expect(book.Sheets["Quote check"].E1.v).toContain("incomplete");
  expect(XLSX.utils.sheet_to_json(book.Sheets.Summary, { header: 1 })).toContainEqual(["Mode", "Mechanical quotation check — incomplete"]);
});
