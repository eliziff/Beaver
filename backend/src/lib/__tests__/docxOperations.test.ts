import JSZip from "jszip";
import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";
import {
  applyAuthorityDiscrepancyCorrection,
  applyTableOfAuthorities,
} from "../docxOperations";
describe("native Word Table of Authorities output", () => {
  it("replaces exact reviewed spans in body text and footnotes", async () => {
    const body = "The court wrote This and that.";
    const note = "Example v Example, 2020 SCC 1 at para 19.";
    const source = await Packer.toBuffer(new Document({
      footnotes: { 7: { children: [new Paragraph({ children: [new TextRun(note)] })] } },
      sections: [{ children: [new Paragraph({ children: [
        new TextRun(body), new FootnoteReferenceRun(7),
      ] })] }],
    }));
    const bodyStart = body.indexOf("This and that");
    const first = await applyAuthorityDiscrepancyCorrection(source, [
      { id: "body:0", text: body }, { id: "footnote:7", text: note },
    ], { unitId: "body:0", start: bodyStart, end: bodyStart + 13,
      expected: "This and that", replacement: "This long passage" });
    const revisedBody = body.replace("This and that", "This long passage");
    const noteStart = note.indexOf("19");
    const second = await applyAuthorityDiscrepancyCorrection(first, [
      { id: "body:0", text: revisedBody }, { id: "footnote:7", text: note },
    ], { unitId: "footnote:7", start: noteStart, end: noteStart + 2,
      expected: "19", replacement: "20" });
    const zip = await JSZip.loadAsync(second);
    expect(await zip.file("word/document.xml")!.async("string")).toContain("This long passage");
    expect(await zip.file("word/footnotes.xml")!.async("string")).toContain("at para 20");
    await expect(applyAuthorityDiscrepancyCorrection(source,
      [{ id: "body:0", text: `${body} changed` }], {
        unitId: "body:0", start: bodyStart, end: bodyStart + 13,
        expected: "This and that", replacement: "tampered",
      })).rejects.toThrow("Reviewed text no longer matches");
  });

  it("supports mark-only and static linked append without conflating their structures",
    async () => {
    const body = "R v Grant, 2009 SCC 32";
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph({ children: [new TextRun(body)] }),
    ] }] }));
    const mark = { unitId: "body:0", offset: body.length, longName: body,
      shortName: "R v Grant", category: 1 as const };
    const marked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: body }],
      [mark], "native-marks");
    const markedXml = await (await JSZip.loadAsync(marked))
      .file("word/document.xml")!.async("string");
    expect(markedXml).toContain(" TA \\l");
    expect(markedXml).not.toContain(" TOA \\h");
    expect(markedXml).not.toContain("Table of Authorities");

    const linked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: body }],
      [mark], "linked-append", [
        { label: body, url: "https://decisions.example.test/grant?a=1&b=2" },
        { label: "Unlinked authority", url: null },
      ]);
    const linkedXml = await (await JSZip.loadAsync(linked))
      .file("word/document.xml")!.async("string");
    expect(linkedXml).not.toContain(" TA \\l");
    expect(linkedXml).toContain("TABLE OF AUTHORITIES");
    expect(linkedXml).toContain("R v Grant, 2009 SCC 32");
    expect(linkedXml).toContain("HYPERLINK &quot;https://decisions.example.test/grant?a=1&amp;b=2&quot;");
    expect(linkedXml).toContain("Unlinked authority");
    expect(linkedXml).not.toContain("copy required");
    expect(linkedXml.indexOf("TABLE OF AUTHORITIES")).toBeLessThan(
      linkedXml.indexOf("w:sectPr"));
  });

  it("marks body and footnote citations and appends one updateable TOA before sectPr", async () => {
    const body = "R v Grant, 2009 SCC 32";
    const footnote = "Federal Courts Act, RSC 1985, c F-7";
    const bytes = await Packer.toBuffer(new Document({
      footnotes: { 7: { children: [new Paragraph({ children: [new TextRun(footnote)] })] } },
      sections: [{ children: [new Paragraph({ children: [
        new TextRun(body), new FootnoteReferenceRun(7),
      ] })] }],
    }));
    const result = await applyTableOfAuthorities(bytes, [
      { id: "body:0", text: body }, { id: "footnote:7", text: footnote },
    ], [
      { unitId: "body:0", offset: body.length, longName: body,
        shortName: "R v Grant", category: 1 },
      { unitId: "footnote:7", offset: footnote.length, longName: footnote,
        shortName: "Federal Courts Act", category: 2 },
    ], "native-append");

    const zip = await JSZip.loadAsync(result);
    const document = await zip.file("word/document.xml")!.async("string");
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    const settings = await zip.file("word/settings.xml")!.async("string");
    expect(document).toContain(' TA \\l &quot;R v Grant, 2009 SCC 32&quot; \\s &quot;R v Grant&quot; \\c 1 ');
    expect(notes).toContain(' TA \\l &quot;Federal Courts Act, RSC 1985, c F-7&quot;');
    expect(document).toContain(' TOA \\h \\e &quot;\\t&quot; ');
    expect(document).toContain("w:vanish");
    expect(document.indexOf("Table of Authorities")).toBeLessThan(document.indexOf("w:sectPr"));
    expect(settings).toMatch(/w:updateFields[^>]+w:val="true"/u);
    expect(await zip.file("[Content_Types].xml")!.async("string"))
      .toContain("wordprocessingml.document.main+xml");
  });
});
