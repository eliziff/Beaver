import { expect, it } from "vitest";
import { modelQuoteCheckReport } from "./assistantTools";
import { researchSourceFromResource } from "../researchFile";

it("keeps quote findings, attribution choices and source identity in the compact report", () => {
  const fields = { status: "ok", corrected: "", kind: "case", link_candidate: "",
    pinpoint_fragments: ["para 2"], page_pinpoints: [], bare_citation: "2024 SCC 1",
    citation_with_style: "", short_form: "", reasons: [] },
    unit = { unitId: "unit-1", status: "ok", reasons: [],
      parts: [{ start: 20, end: 40, text: "2024 SCC 1 at para 2", anchors: ["internal"], fields }],
      delimiters: [[40, 41, ";"] as [number, number, string]] },
    candidate = { id: "occurrence-1", citation: "2024 SCC 1", kind: "case" as const,
      pinpoints: ["par2"], text: "2024 SCC 1 at para 2", unitId: "unit-1", start: 20, end: 40 },
    quote = { id: "quote-1", unitId: "unit-1", start: 0, end: 17,
      quote: "The appeal fails.", context: "The appeal fails. 2024 SCC 1 at para 2",
      pageNumbers: [3], candidates: [candidate], occurrenceId: "occurrence-1",
      linkMethod: "explicit" as const, status: "mismatch", detail: "Compared with the cited passage.",
      receipt: { source: { provider: "courtlistener", id: "42", part: "43", kind: "case" as const,
        language: "fr" as const, citation: "2024 SCC 1", title: "Example", date: "2024-01-01" },
        sourceSha256: "a".repeat(64), passageSha256: "b".repeat(64),
        locator: { kind: "paragraph" as const, value: "2" }, text: "The appeal succeeds.",
        errors: ["Quotation does not match"], comparison: { matches: [],
          candidate: "The appeal succeeds.", candidateOnly: true, editorial: "The appeal [succeeds].",
          changes: [{ kind: "replace", authored: "fails", source: "succeeds" }] } } },
    ambiguous = { ...quote, id: "quote-2", occurrenceId: null, status: "ambiguous",
      candidates: [candidate, { ...candidate, id: "occurrence-2" }], receipt: null },
    report = { mode: "assisted", total: 12, counts: { mismatch: 1, ambiguous: 1 },
      quotes: [quote, ambiguous], citationUnits: [unit] };
  const result = modelQuoteCheckReport(report, 0);
  expect(result.next_offset).toBe(10);
  expect(result.quotes[0]).toMatchObject({ id: quote.id, candidates: quote.candidates,
    receipt: { errors: quote.receipt.errors, comparison: quote.receipt.comparison,
      text: quote.receipt.text, locator: quote.receipt.locator, date: "2024-01-01" } });
  expect(result.quotes[1]).toMatchObject({ status: "ambiguous", receipt: null,
    candidates: ambiguous.candidates });
  expect(researchSourceFromResource(result.quotes[0].receipt!.resource)).toMatchObject({
    provider: "courtlistener", id: "42", part: "43", language: "fr" });
  expect(result.citationUnits[0].parts[0].fields).toMatchObject({
    status: "ok", pinpoint_fragments: ["para 2"], bare_citation: "2024 SCC 1" });
  expect(quote.receipt.sourceSha256).toHaveLength(64);
  expect(JSON.stringify(result)).not.toContain("Sha256");
});
