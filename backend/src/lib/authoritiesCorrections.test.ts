import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { importStandaloneAuthoritiesFile } from "./authoritiesImport";
import { pinpointCorrection } from "./authoritiesDiscrepancy";
import { prepareAuthoritiesCorrection } from "./authoritiesPreparation";

// Independently invented brief and citation; no source document or user wording.
const citation = "2035 ONCA 271", name = "Mistral v Summit";
async function brief() {
  const note = `${name}, ${citation} at paras 84-86.`;
  const bytes = await Packer.toBuffer(new Document({
    footnotes: { 1: { children: [new Paragraph(note)] }, 2: { children: [new Paragraph(note)] } },
    sections: [{ children: [new Paragraph({ children: [new TextRun("The permit renews when the record is filed."),
      new FootnoteReferenceRun(1), new TextRun(" The next permit has the same condition."), new FootnoteReferenceRun(2)] })] }],
  }));
  return { bytes, state: await importStandaloneAuthoritiesFile({ filename: "Review.docx", fileType: "docx", bytes, modified: 0 }) };
}
const visible = (xml: string) => [...xml.replace(/<w:del\b[\s\S]*?<\/w:del>/gu, "")
  .matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu)].map(([, text]) => text).join("");

it("replaces a pinpoint range as a whole and only extends it to an adjacent paragraph", async () => {
  const { state } = await brief(), occurrence = Object.values(state.occurrences)[0];
  const replacement = pinpointCorrection(occurrence, "87")!;
  expect(replacement).toMatchObject({ expected: "at paras 84-86", replacement: "at para 87" });
  const unit = state.units.find(unit => unit.id === occurrence.unitId)!;
  expect(unit.text.slice(replacement.start, replacement.end)).toBe(replacement.expected);
  expect(pinpointCorrection(occurrence, "87", true)?.replacement).toMatch(/^at paras 84[-–]87$/u);
  expect(pinpointCorrection(occurrence, "83", true)?.replacement).toMatch(/^at paras 83[-–]86$/u);
  expect(pinpointCorrection(occurrence, "90", true)).toBeNull();
  const manual = { ...occurrence }; delete manual.pinpointPhrase;
  expect(pinpointCorrection(manual, "87")?.replacement).toBe("87");
  expect(pinpointCorrection(manual, "87", true)?.replacement).toBe("84-87");
});

it("corrects every full case name in Word with tracked changes, preserving the citation, and can undo it", async () => {
  const { bytes, state } = await brief(), authority = state.authorities[state.authorityOrder[0]];
  const id = "f".repeat(64), correctedName = "Estuary v Ridge";
  authority.citedCase = { id, citation, name: correctedName, named: null };
  const result = await prepareAuthoritiesCorrection(state, { id, action: "use_cited_name" }, async () => ({ bytes }));
  expect(result.kind).toBe("corrected");
  if (result.kind !== "corrected") throw new Error("Expected a corrected Word document");
  const xml = await (await JSZip.loadAsync(result.bytes)).file("word/footnotes.xml")!.async("string");
  const text = visible(xml);
  expect(text.split(`${correctedName}, ${citation}`).length - 1).toBe(2);
  expect(text).not.toContain(name);
  expect(xml).toContain("<w:ins ");
  expect(xml).toContain("<w:del ");
  expect(result.draft.authorities[authority.id]).toMatchObject({ name: correctedName, citation });
  expect(state.authorities[authority.id].name).toBe(name);
  const undone = await prepareAuthoritiesCorrection(result.draft, { id, action: "reopen" }, async () => ({ bytes: result.bytes }));
  expect(undone.kind).toBe("corrected");
  if (undone.kind !== "corrected") throw new Error("Expected the tracked change to be undone");
  const original = visible(await (await JSZip.loadAsync(undone.bytes)).file("word/footnotes.xml")!.async("string"));
  expect(original.split(`${name}, ${citation}`).length - 1).toBe(2);
  expect(original).not.toContain(correctedName);
});

it("does not offer a document name correction as a draft-only change for a PDF brief", async () => {
  const { state } = await brief(), id = "e".repeat(64);
  state.import = { ...state.import as Extract<typeof state.import, { kind: "document" }>, fileType: "pdf" };
  state.authorities[state.authorityOrder[0]].citedCase = { id, citation, name: "Estuary v Ridge", named: null };
  await expect(prepareAuthoritiesCorrection(state, { id, action: "use_cited_name" }, async () => {
    throw new Error("Must not read source bytes");
  })).rejects.toMatchObject({ status: 409 });
});
