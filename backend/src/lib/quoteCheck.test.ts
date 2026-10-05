import { expect, it } from "vitest";
import { Document, Packer, Paragraph, FootnoteReferenceRun, TextRun } from "docx";
import { importStandaloneAuthoritiesFile } from "./authoritiesImport";
import { checkQuotes, decodeQuoteLinks, splitQuoteChecks } from "./quoteCheck";
import { structureNative } from "./structureNative";
import type { legalSourceOperations } from "./legalSourceApplication";
import { splitQuoteCitationUnits } from "./quoteCitationSplit";

it("checks a quotation against each source its note cites, or the first only, or the one linked", async () => {
  const text = 'The court wrote “The deadline is seven business days.” 2020 SCC 1 at para 7; 2021 SCC 2 at para 8.';
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));
  const draft = await importStandaloneAuthoritiesFile({ filename: "submission.docx", fileType: "docx", bytes, modified: 0 });
  const units = await splitQuoteCitationUnits(draft.units.map(({ text }) => text));
  const [split] = splitQuoteChecks(draft, [], units);
  expect(split.candidates).toHaveLength(2);
  expect(split.occurrenceId).toBeNull();
  let wording = "The deadline is seven business days.";
  const source = { provider: "a2aj", id: "2020-scc-1", kind: "case" as const, citation: "2020 SCC 1" };
  const sources = { async resolve() { return { status: "found" as const, value: source }; },
    async readPassage() { return { status: "found" as const, values: [{ source,
      locator: { requested: null, label: "7" }, role: "selected" as const, text: wording,
      documentArtifact: await structureNative().deriveDocumentStructure({ kind: "provider_text", input: {
        provider: "a2aj", citation: "2020 SCC 1", source_kind: "cases", dataset: "SCC", text: `[7] ${wording}` } }) }] }; },
  } as typeof legalSourceOperations;
  const each = (await checkQuotes(draft, [], undefined, undefined, sources)).quotes[0].checks;
  expect(each.map(({ candidateId, status }) => [candidateId, status]))
    .toEqual(split.candidates.map(({ id }) => [id, "verified"]));
  const first = (await checkQuotes(draft, [], undefined, undefined, sources, undefined, undefined,
    { firstCitationOnly: true })).quotes[0].checks;
  expect(first.map(({ candidateId }) => candidateId)).toEqual([split.candidates[0].id]);
  const links = [{ quoteId: split.id, occurrenceId: split.candidates[1].id }];
  const verified = await checkQuotes(draft, links, undefined, undefined, sources);
  expect(verified.quotes[0]).toMatchObject({ linkMethod: "explicit", checks: [{ candidateId: split.candidates[1].id,
    status: "verified", receipt: { text: expect.stringContaining(wording), passageSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }] });
  wording = "The deadline is eight business days.";
  expect((await checkQuotes(draft, links, undefined, undefined, sources)).quotes[0].checks[0].status).toBe("mismatch");
  expect(() => decodeQuoteLinks([...links, ...links])).toThrow();
  expect(() => splitQuoteChecks(draft, [{ quoteId: "unknown", occurrenceId: links[0].occurrenceId }], units)).toThrow();
});

it("uses ALR's next footnote anchor across paragraphs, and keeps lossless commentary parts unresolved", async () => {
  const bytes = await Packer.toBuffer(new Document({ footnotes: { 1: {
    children: [new Paragraph("2020 SCC 1 at para 7; commentary without a citation")],
  } }, sections: [{ children: [new Paragraph('The court wrote “The deadline is seven business days.”'),
    new Paragraph({ children: [new TextRun("See also "), new FootnoteReferenceRun(1)] })] }] }));
  const draft = await importStandaloneAuthoritiesFile({ filename: "notes.docx", fileType: "docx", bytes, modified: 0 });
  const units = await splitQuoteCitationUnits(draft.units.map(({ text }) => text));
  const [quote] = splitQuoteChecks(draft, [], units);
  expect(quote.candidates).toHaveLength(2);
  expect(quote.candidates[1].text).toContain("commentary without a citation");
  expect(quote.occurrenceId).toBeNull();
});
