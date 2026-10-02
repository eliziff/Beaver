import JSZip from "jszip";
import { ExternalHyperlink, FootnoteReferenceRun, Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";
import { docxBytes } from "./support/docxFixtures";
import {
  applyAuthorityDiscrepancyCorrection,
  applyTableOfAuthorities,
} from "../docxOperations";
/** What each TOA field shows before Word updates it: its result's lines, as Word stored them. */
function tableAsOpened(document: string) {
  const tables: string[][] = [];
  let code = "", state: "code" | "result" | null = null, line = "";
  for (const [token, kind, text] of document.matchAll(
    /<w:fldChar w:fldCharType="(begin|separate|end)"[^>]*>|<w:instrText[^>]*>([^<]*)<|<w:t(?:\s[^>]*)?>([^<]*)<|<\/w:p>/gu)) {
    if (kind === "begin") { state = "code"; code = ""; }
    else if (kind === "separate" && state === "code") { state = /^\s*TOA\b/u.test(code) ? "result" : null; if (state) tables.push([]); }
    else if (kind === "end") { if (state === "result" && line) tables.at(-1)!.push(line); state = null; line = ""; }
    else if (token.startsWith("<w:instrText") && state === "code") code += text ?? "";
    else if (token.startsWith("<w:t") && state === "result") line += (token.match(/>([^<]*)</u)?.[1] ?? "").replaceAll("&quot;", '"');
    else if (token === "</w:p>" && state === "result") { if (line) tables.at(-1)!.push(line); line = ""; }
  }
  return tables;
}

describe("native Word Table of Authorities output", () => {
  it("appends fixed tab text in body and footnote citations and preserves pinpoint text for final links", async () => {
    const body = "R v Grant, 2009 SCC 32 at para 12", note = "Ibid at para 13";
    const source = await docxBytes([new Paragraph({ children: [
      new TextRun({ text: body.slice(0, 12), bold: true }), new TextRun(body.slice(12)), new FootnoteReferenceRun(7),
    ] })], { footnotes: { 7: { children: [new Paragraph(note)] } } });
    const marked = await applyTableOfAuthorities(source, [{ id: "body:0", text: body }, { id: "footnote:7", text: note }], [
      { unitId: "body:0", offset: body.length, longName: "R v Grant", shortName: "Grant", category: 1,
        suffix: " [Book of authorities Tab 3]", pinpointLink: { start: body.indexOf("para 12"), end: body.length,
          url: "https://beaver-authorities.invalid/pinpoint/grant" } },
      { unitId: "footnote:7", offset: note.length, longName: "R v Grant", shortName: "Grant", category: 1,
        suffix: " [Tab 3]", tabUrl: "https://beaver-authorities.invalid/tab/ibid" },
    ], "native-marks");
    const zip = await JSZip.loadAsync(marked);
    const document = await zip.file("word/document.xml")!.async("string"), notes = await zip.file("word/footnotes.xml")!.async("string");
    expect(document).toContain("[Book of authorities Tab 3]");
    expect(notes).toContain("[Tab 3]");
    expect(document).toContain("para 12"); expect(document).toContain("w:b");
    expect(document).toContain('HYPERLINK &quot;https://beaver-authorities.invalid/pinpoint/grant&quot;');
    expect(notes).toContain('HYPERLINK &quot;https://beaver-authorities.invalid/tab/ibid&quot;');
    expect(document).not.toContain(" TOA ");
  });

  it("places marks after a field whose result ends a citation, not in the result Word replaces", async () => {
    const run = (inner: string) => `<w:r>${inner}</w:r>`;
    const complex = run('<w:fldChar w:fldCharType="begin"/>') + run('<w:instrText xml:space="preserve"> NOTEREF _Ref1 \\h </w:instrText>')
      + run('<w:fldChar w:fldCharType="separate"/>') + run("<w:t>3</w:t>") + run('<w:fldChar w:fldCharType="end"/>');
    const simple = '<w:fldSimple w:instr=" NOTEREF _Ref2 \\h ">' + run("<w:t>4</w:t>") + "</w:fldSimple>";
    const source = await docxBytes([new Paragraph("first"), new Paragraph("second")]);
    const zip = await JSZip.loadAsync(source);
    const xml = (await zip.file("word/document.xml")!.async("string"))
      .replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>first<\/w:t><\/w:r>/u, run("<w:t xml:space=\"preserve\">Alder v Birch, supra note </w:t>") + complex)
      .replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>second<\/w:t><\/w:r>/u, run("<w:t xml:space=\"preserve\">Cedar Act, supra note </w:t>") + simple);
    const bytes = await zip.file("word/document.xml", xml).generateAsync({ type: "nodebuffer" });
    const first = "Alder v Birch, supra note 3", second = "Cedar Act, supra note 4";
    const marked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: first }, { id: "body:1", text: second }], [
      { unitId: "body:0", offset: first.length, longName: "Alder v Birch", shortName: "Alder", category: 1, suffix: " [Tab 1]" },
      { unitId: "body:1", offset: second.length, longName: "Cedar Act", shortName: "Cedar Act", category: 2, suffix: " [Tab 2]" },
    ], "native-marks");
    const document = await (await JSZip.loadAsync(marked)).file("word/document.xml")!.async("string");
    const order = (...parts: string[]) => parts.map((part) => document.indexOf(part));
    const [result, fieldEnd, mark, tab] = order(">3<", 'w:fldCharType="end"', "TA \\l &quot;Alder v Birch", "[Tab 1]");
    expect(result).toBeLessThan(fieldEnd); expect(fieldEnd).toBeLessThan(mark); expect(mark).toBeLessThan(tab);
    const [simpleEnd, simpleMark, simpleTab] = order("</w:fldSimple>", "TA \\l &quot;Cedar Act", "[Tab 2]");
    expect(simpleEnd).toBeLessThan(simpleMark); expect(simpleMark).toBeLessThan(simpleTab);
  });

  it("leaves the author's web link on a citation as it was, with the tab reference after it", async () => {
    const cited = "Oak v Elm, 2031 ONCA 5 at para 9", body = `See ${cited}`;
    const source = await docxBytes([new Paragraph({ children: [new TextRun("See "),
      new ExternalHyperlink({ link: "https://example.test/oak-v-elm", children: [new TextRun(cited)] })] })]);
    const marked = await applyTableOfAuthorities(source, [{ id: "body:0", text: body }], [
      { unitId: "body:0", offset: body.length, longName: "Oak v Elm", shortName: "Oak", category: 1, suffix: " [Tab 2]",
        tabUrl: "https://beaver-authorities.invalid/tab/oak", pinpointLink: { start: body.indexOf("para 9"), end: body.length,
          url: "https://beaver-authorities.invalid/pinpoint/oak" } },
    ], "native-marks");
    const zip = await JSZip.loadAsync(marked), document = await zip.file("word/document.xml")!.async("string");
    const link = /<w:hyperlink [^>]*>(.*?)<\/w:hyperlink>/u.exec(document)!;
    expect([...link[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/gu)].map(([, text]) => text).join("")).toBe(cited);
    expect(link[1]).not.toContain("instrText");
    expect(document.indexOf("[Tab 2]")).toBeGreaterThan(document.indexOf("</w:hyperlink>"));
    expect(document).toContain(" TA \\l &quot;Oak v Elm");
    expect(document).not.toContain("pinpoint/oak");
    expect(await zip.file("word/_rels/document.xml.rels")!.async("string")).toContain("https://example.test/oak-v-elm");
  });

  it("keeps a citation's own TA mark and lists its category in the table", async () => {
    const run = (inner: string) => `<w:r>${inner}</w:r>`;
    const own = run('<w:fldChar w:fldCharType="begin"/>')
      + run('<w:instrText xml:space="preserve"> TA \\l "Fir v Gum (1990) 1 Imaginary R 1" \\s "Fir" \\c 3 </w:instrText>')
      + run('<w:fldChar w:fldCharType="end"/>');
    const source = await docxBytes([new Paragraph("first")]);
    const zip = await JSZip.loadAsync(source);
    const text = "Fir v Gum (1990) 1 Imaginary R 1";
    const xml = (await zip.file("word/document.xml")!.async("string"))
      .replace(/<w:r>(?:(?!<w:r>).)*?<w:t[^>]*>first<\/w:t><\/w:r>/u, run(`<w:t>${text}</w:t>`) + own + run("<w:t>.</w:t>"));
    const bytes = await zip.file("word/document.xml", xml).generateAsync({ type: "nodebuffer" });
    const marked = await applyTableOfAuthorities(bytes, [{ id: "body:0", text: `${text}.` }], [
      { unitId: "body:0", offset: text.length, longName: text, shortName: "Fir", category: 1, suffix: " [Tab 1]" },
    ], "native-append");
    const document = await (await JSZip.loadAsync(marked)).file("word/document.xml")!.async("string");
    expect(document.match(/ TA \\l/gu)).toHaveLength(1);
    // An insertion at the end of a run's text leaves no empty run behind.
    expect(document).not.toMatch(/<w:t(?: [^>]*)?(?:\/>|><\/w:t>)/u);
    expect(document).toContain("[Tab 1]");
    expect(document).toContain(' TOA \\h \\c &quot;3&quot; ');
    expect(tableAsOpened(document)).toEqual([["Other Authorities", text]]);
  });

  it("writes the table into the brief so it reads on opening, before Word updates a field", async () => {
    const body = "As held in Oak v Elm, 2031 ONCA 5 at para 9 and Larch Act, SA 2031, c L-2, s 4.";
    const notes = ["Birch v Ash, 2030 ABKB 1.", "Oak v Elm, supra note 1.", "Jo Pine, “Moss” (2030) 1 Imag LJ 2."];
    const source = await docxBytes([new Paragraph({ children: [new TextRun(body),
      ...notes.map((_, index) => new FootnoteReferenceRun(index + 1))] })],
    { footnotes: Object.fromEntries(notes.map((note, index) => [index + 1, { children: [new Paragraph(note)] }])) });
    const end = (text: string, cite: string) => text.indexOf(cite) + cite.length;
    const marked = await applyTableOfAuthorities(source, [{ id: "body:0", text: body },
      ...notes.map((text, index) => ({ id: `footnote:${index + 1}`, text }))], [
      { unitId: "body:0", offset: end(body, "2031 ONCA 5"), longName: "Oak v Elm, 2031 ONCA 5", shortName: "Oak", category: 1 },
      { unitId: "body:0", offset: end(body, "c L-2"), longName: "Larch Act, SA 2031, c L-2", shortName: "Larch Act", category: 2 },
      { unitId: "footnote:1", offset: end(notes[0], "2030 ABKB 1"), longName: "Birch v Ash, 2030 ABKB 1", shortName: "Birch", category: 1 },
      { unitId: "footnote:2", offset: end(notes[1], "supra note 1"), longName: "Oak v Elm, 2031 ONCA 5", shortName: "Oak", category: 1 },
      { unitId: "footnote:3", offset: end(notes[2], "Imag LJ 2"), longName: "Jo Pine, “Moss” (2030) 1 Imag LJ 2", shortName: "Pine", category: 5 },
    ], "native-append");
    const zip = await JSZip.loadAsync(marked), document = await zip.file("word/document.xml")!.async("string");
    // Each category's field already holds its heading and entries, sorted as Word sorts them.
    expect(tableAsOpened(document)).toEqual([["Cases", "Birch v Ash, 2030 ABKB 1", "Oak v Elm, 2031 ONCA 5"],
      ["Statutes", "Larch Act, SA 2031, c L-2"], ["Treatises", "Jo Pine, “Moss” (2030) 1 Imag LJ 2"]]);
    expect(document).not.toContain("w:dirty");
    // The table's heading takes the brief's heading look but none of its heading numbers.
    expect(document).toMatch(/<w:pStyle w:val="Heading1"><\/w:pStyle><w:numPr><w:ilvl w:val="0"><\/w:ilvl><w:numId w:val="0"><\/w:numId><\/w:numPr><w:ind w:left="0" w:right="0" w:firstLine="0"><\/w:ind><\/w:pPr><w:r><w:t>Table of Authorities</u);
    const styles = await zip.file("word/styles.xml")!.async("string");
    expect(styles).toContain('w:styleId="TOAHeading"'); expect(styles).toContain('w:styleId="TableofAuthorities"');
    expect(await zip.file("word/settings.xml")!.async("string")).toContain('<w:updateFields w:val="true"');
    // An authority is marked in full once, then by its short name.
    const codes = [...(document + await zip.file("word/footnotes.xml")!.async("string"))
      .matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/gu)].map(([, code]) => code.replaceAll("&quot;", '"'))
      .filter((code) => code.startsWith(" TA "));
    expect(codes.filter((code) => code.includes('"Oak"'))).toEqual([' TA \\l "Oak v Elm, 2031 ONCA 5" \\s "Oak" \\c 1 ', ' TA \\s "Oak" ']);
  });

  it("escapes the quotes that would end a field's argument, and gives entries sharing a short name their full name", async () => {
    const one = "Jo Pine, “The “Moss” Rule: A \"Draft\"” (2030) 1 Imag LJ 2", two = "R v Ash, 2030 ABKB 1", three = "R v Ash, 2031 ONCA 7";
    const body = `${one}; ${two}; ${three}.`;
    const source = await docxBytes([new Paragraph(body)]);
    const marked = await applyTableOfAuthorities(source, [{ id: "body:0", text: body }], [
      { unitId: "body:0", offset: one.length, longName: one, shortName: "Pine", category: 5 },
      { unitId: "body:0", offset: body.indexOf(two) + two.length, longName: two, shortName: "R v Ash", category: 1 },
      { unitId: "body:0", offset: body.indexOf(three) + three.length, longName: three, shortName: "R v Ash", category: 1 },
    ], "native-append");
    const document = (await (await JSZip.loadAsync(marked)).file("word/document.xml")!.async("string")).replaceAll("&quot;", '"');
    expect(document).toContain(' TA \\l "Jo Pine, \\“The \\“Moss\\” Rule: A \\"Draft\\"\\” (2030) 1 Imag LJ 2" \\s "Pine" \\c 5 ');
    expect(document).toContain(` TA \\l "${two}" \\s "${two}" \\c 1 `);
    expect(document).toContain(` TA \\l "${three}" \\s "${three}" \\c 1 `);
    expect(tableAsOpened(document).flat()).toContain(one);
  });

  it("replaces exact reviewed spans in body text and footnotes", async () => {
    const body = "The court wrote This and that.";
    const note = "Example v Example, 2020 SCC 1 at para 19.";
    const source = await docxBytes([new Paragraph({ children: [
      new TextRun(body), new FootnoteReferenceRun(7),
    ] })], {
      footnotes: { 7: { children: [new Paragraph(note)] } },
    });
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
    const bytes = await docxBytes([
      new Paragraph(body),
    ]);
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

  it("marks body and footnote citations and appends an updateable TOA per category before sectPr", async () => {
    const body = "R v Grant, 2009 SCC 32";
    const footnote = "Federal Courts Act, RSC 1985, c F-7";
    const bytes = await docxBytes([new Paragraph({ children: [
      new TextRun(body), new FootnoteReferenceRun(7),
    ] })], {
      footnotes: { 7: { children: [new Paragraph(footnote)] } },
    });
    const result = await applyTableOfAuthorities(bytes, [
      { id: "body:0", text: body }, { id: "footnote:7", text: footnote },
    ], [
      { unitId: "body:0", offset: body.length, longName: body,
        shortName: "R v Grant", category: 1 },
      { unitId: "footnote:7", offset: footnote.length, longName: footnote,
        shortName: "Federal Courts Act", category: 2 },
      { unitId: "body:0", offset: body.length, longName: "Ann Writer, “A Study” and \"Another\" (2001) 1 Imaginary LJ 1",
        shortName: "Writer", category: 5 },
    ], "native-append");

    const zip = await JSZip.loadAsync(result);
    const document = await zip.file("word/document.xml")!.async("string");
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    const settings = await zip.file("word/settings.xml")!.async("string");
    expect(document).toContain(' TA \\l &quot;R v Grant, 2009 SCC 32&quot; \\s &quot;R v Grant&quot; \\c 1 ');
    expect(notes).toContain(' TA \\l &quot;Federal Courts Act, RSC 1985, c F-7&quot;');
    // Word lists a TA mark only when it is not hidden text, and builds a table only for a category.
    expect(document).not.toContain("w:vanish");
    expect(document).toContain(' TOA \\h \\c &quot;1&quot; ');
    expect(document).toContain(' TOA \\h \\c &quot;2&quot; ');
    expect(document).toContain(' TOA \\h \\c &quot;5&quot; ');
    // Word ends a field argument at any double quote, straight or curly, unless it is escaped.
    expect(document).toContain('Ann Writer, \\“A Study\\” and \\&quot;Another\\&quot; (2001)');
    expect(document.indexOf("Table of Authorities")).toBeLessThan(document.indexOf("w:sectPr"));
    expect(settings).toMatch(/w:updateFields[^>]+w:val="true"/u);
    // Word reads settings in schema order: updateFields precedes the compatibility settings.
    if (settings.includes("<w:compat")) {
      expect(settings.indexOf("<w:updateFields")).toBeLessThan(settings.indexOf("<w:compat"));
    }
    expect(Object.keys(zip.files)).toEqual(Object.keys((await JSZip.loadAsync(bytes)).files));
    expect(await zip.file("[Content_Types].xml")!.async("string"))
      .toContain("wordprocessingml.document.main+xml");
  });
});
