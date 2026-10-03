import { describe, expect, it } from "vitest";
import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { importStandaloneAuthoritiesFile, nativeReferenceSpans } from "./authoritiesImport";
import { structureNative } from "./structureNative";

// Independently invented notes and prose; no private brief or reported case data.
async function scan(notes: string[]) {
  const bytes = await Packer.toBuffer(new Document({
    footnotes: Object.fromEntries(notes.map((text, index) =>
      [index + 1, { children: [new Paragraph(text)] }])),
    sections: [{ children: [new Paragraph({ children: notes.flatMap((_, index) =>
      [new TextRun(`The wetland board considered proposal ${index + 1}.`),
        new FootnoteReferenceRun(index + 1)]) })] }],
  }));
  return importStandaloneAuthoritiesFile({ filename: "Wetland submissions.docx",
    fileType: "docx", bytes, modified: 0 });
}

describe("Authorities consumes general citation identity", () => {
  it("preserves the written short name through the native span adapter", () => {
    const text = "Linn, supra note 6 at 72.";
    const [reference] = structureNative().authorityReferencesInText(text);
    const spans = nativeReferenceSpans(reference, text);
    expect(spans.authoritySpan.text).toBe("Linn, supra note 6");
    expect(spans.coreSpan.text).toBe("supra note 6");
    expect(spans.pinpointSpan?.text).toBe("72");
  });
  it("keeps a URL-free work, chained references, their short names and separate pinpoints", async () => {
    const draft = await scan([
      "Lena Tern, Shore Access (Reed Press, 2036).",
      "Tern, supra note 1 at 54.",
      "Tern, supra note 2 at 58.",
    ]);
    expect(draft.authorityOrder).toHaveLength(1);
    const authority = draft.authorities[draft.authorityOrder[0]];
    expect(authority.kind).toBe("commentary");
    expect(authority.source.kind).toBe("unresolved");
    const references = Object.values(draft.occurrences).filter(item => item.kind === "reference");
    expect(references).toHaveLength(2);
    expect(references.map(item => item.authorityId)).toEqual([authority.id, authority.id]);
    expect(references.map(item => item.authoritySpan.text))
      .toEqual(["Tern, supra note 1", "Tern, supra note 2"]);
    expect(references.map(item => item.pinpoints.map(({ kind, text }) => ({ kind, text })))).toEqual([
      [{ kind: "page", text: "54" }], [{ kind: "page", text: "58" }],
    ]);
    expect(references[0].text).toBe("Tern, supra note 1 at 54");
  });

  it("retains commercial and unreported cases for a Sources upload without a public URL", async () => {
    const draft = await scan([
      "Moor Council v Vale Office, 2035 WL 651882.",
      "Creek Union v Polder Office, [2035] AJ No 416 (QL).",
      "Polder Council v Mere Holdings (21 March 2036), Calgary 2601-08164 (Alta KB) [unreported].",
      "Mere Holdings, supra note 3 at para 16.",
    ]);
    const authorities = draft.authorityOrder.map(id => draft.authorities[id]);
    expect(authorities.map(item => [item.kind, item.citationFormat]))
      .toEqual([["case", "database"], ["case", "database"], ["case", "docket"]]);
    expect(authorities.every(item => item.source.kind === "unresolved" && !item.sourceUrl)).toBe(true);
    const reference = Object.values(draft.occurrences).find(item => item.kind === "reference")!;
    expect(reference.authorityId).toBe(authorities[2].id);
    expect(reference.authoritySpan.text).toBe("Mere Holdings, supra note 3");
  });

  it("keeps different works and a conflicting note unresolved", async () => {
    for (const notes of [
      ["Lena Tern, Shore Access (Reed Press, 2036); Lena Tern, Pond Access (Reed Press, 2037).",
        "Tern, supra note 1 at 54."],
      ["Lena Tern, Shore Access (Reed Press, 2036).", "Milo Gull, Reed Routes (Reed Press, 2037).",
        "Tern, supra note 2 at 54."],
    ]) {
      const draft = await scan(notes);
      const references = Object.values(draft.occurrences).filter(item => item.kind === "reference");
      expect(references).toHaveLength(1);
      expect(references[0].authorityId).toBeNull();
      expect(references[0].reference).toBeNull();
    }
  });
});
