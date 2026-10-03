import { Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";
import { structureNative } from "../structureNative";
import { docxBytes } from "./support/docxFixtures";

async function text(children: Paragraph[], titleId = "Title") {
  const bytes = await docxBytes([...children, new Paragraph("Protected table and ending 42.")], {
    styles: { paragraphStyles: [
      { id: titleId, name: "Title", basedOn: "Normal", run: { size: 32 } },
      { id: "Subtitle", name: "Subtitle", basedOn: "Normal", run: { italics: true } },
    ] },
  });
  const original = Buffer.from(bytes), native = structureNative();
  const value = native.documentText(await native.deriveDocxDocument(bytes, "title-read-test", true));
  expect(bytes).toEqual(original);
  expect(value).toContain("Protected table and ending 42.");
  return value;
}

describe("DOCX drafting title text", () => {
  it("includes a Title paragraph in readable text", async () => {
    expect(await text([new Paragraph({ text: "Inspection service agreement", style: "Title" })]))
      .toContain("Inspection service agreement");
  });

  it("includes a subtitle without dropping the title or body", async () => {
    const value = await text([
      new Paragraph({ text: "Supply agreement", style: "Title" }),
      new Paragraph({ text: "Local equipment terms", style: "Subtitle" }),
      new Paragraph("Return every crate in 10 days."),
    ]);
    expect(value).toContain("Supply agreement");
    expect(value.replaceAll("*", "")).toContain("Local equipment terms");
    expect(value).toContain("Return every crate in 10 days.");
  });

  it("recognizes the title by its style name with a custom style ID", async () => {
    expect(await text([new Paragraph({ text: "Custom service caption", style: "CaseCaption" })], "CaseCaption"))
      .toContain("Custom service caption");
  });

  it("retains independently formatted text fragments in a title", async () => {
    const value = await text([new Paragraph({ style: "Title", children: [
      new TextRun({ text: "Field", bold: true }),
      new TextRun({ text: " service agreement", italics: true }),
    ] })]);
    expect(value.replaceAll("*", "")).toContain("Field service agreement");
    expect(value).toContain("**Field**");
  });
});
