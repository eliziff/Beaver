/** Real gateway/QuickJS/Writer tests. Missing runtime is a failure, never a skip. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { runLibreOffice } from "../../src/lib/libreOffice";
import { executeWordProgram } from "../../src/lib/libreOfficeConsole";

const signal = new AbortController().signal;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// The previous Python fixture's exact part payloads, built without a second runtime.
async function fixture() {
  const zip = new JSZip(), parts: Record<string, string> = {
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>UNO compound document</w:t></w:r></w:p>
<w:p><w:r><w:t>Opening paragraph stays unchanged.</w:t></w:r></w:p>
<w:p><w:r><w:t>Unicode 🦫 anchor and a source note.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>
<w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Fee</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t xml:space="preserve">Editorial history: </w:t></w:r><w:ins w:id="9" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:r><w:t>retained insertion</w:t></w:r></w:ins><w:del w:id="10" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>retained deletion</w:delText></w:r></w:del></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented passage stays.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:pPr></w:p>
<w:p><w:r><w:t>Second section stays.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
    "word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>Authority at paragraph 12.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>UNCHANGED HEADER</w:t></w:r></w:p></w:hdr>`,
    "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`,
    "word/comments.xml": `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>Do not remove my note.</w:t></w:r></w:p></w:comment></w:comments>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rNote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rComment" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`,
  };
  for (const [name, text] of Object.entries(parts))
    zip.file(name, text, { createFolders: false, date: new Date("2000-01-01T00:00:00Z") });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
const source = fixture();
async function preview(bytes: Buffer, program: string, mode: "tracked" | "direct" = "direct") {
  return runLibreOffice(bytes, { action: "preview", snapshot: hash(bytes), program, mode }, signal);
}
async function xml(bytes: Buffer, name: string) {
  const file = (await JSZip.loadAsync(bytes)).file(name); assert.ok(file, name);
  return file.async("string");
}

test("QuickJS programs are expressive, isolated, and promptly cancellable", async () => {
  assert.deepEqual(await executeWordProgram("let n=0; for(let i=0;i<100;i++) n+=i; return [n,typeof process,typeof require,typeof fetch];",
    async () => { throw new Error("No native call expected"); }, signal), [4950, "undefined", "undefined", "undefined"]);
  const controller = new AbortController(), start = Date.now();
  const task = executeWordProgram("while(true){}", async () => null, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(task, /cancelled/);
  assert.ok(Date.now() - start < 5000, "CPU loop must not block Stop on the host");
  await assert.rejects(executeWordProgram("return 'x'.repeat(100000);", async () => null, signal), /result exceeds/);
});

test("real console discovers native APIs and performs compound edits", async () => {
  const bytes = await source;
  const { report, candidate } = await preview(bytes, `
    const page=doc.get('Text').items(0,2,['String','CharHeight']);
    word.assert(page.items.length===2 && page.next_offset===2 && page.total===null);
    word.assert(page.items[1].properties.String.includes('unchanged') && page.items[1].properties.CharHeight>0);
    const props=word.inspect({family:'paragraph',limit:2,properties:['ParaStyleName'],include_text:false});
    word.assert(props.items.length===2 && !('text' in props.items[0]) && 'ParaStyleName' in props.items[0].properties);
    const tables=doc.get('TextTables').items();
    word.assert(tables.items[0].name==='Table1' && tables.next_offset===null);
    const [paragraph,unicode,t]=word.target(['paragraph:1','paragraph:2','table:Table1']);
    for (const String of ['x'.repeat(70000),'y'.repeat(70000),'Opening paragraph stays unchanged.']) paragraph.set({String});
    const paragraphStyles=doc.get('StyleFamilies').call('getByName','ParagraphStyles');
    paragraphStyles.call('insertByName','BeaverDerived',word.create('com.sun.star.style.ParagraphStyle'));
    const style=word.target('paragraph-style:BeaverDerived'); style.call('setParentStyle','Standard');
    style.set({CharHeight:13});
    paragraph.set({ParaStyleName:'BeaverDerived',CharHeight:18,CharWeight:150,CharUnderline:1});
    paragraph.reset(['CharHeight','CharUnderline']); style.set({CharHeight:14}); style.expect({ParentStyle:'Standard',CharHeight:14});
    word.assert(style.call('getParentStyle')==='Standard' && paragraph.get('CharHeight')===14);
    word.assert(paragraph.call('getPropertyStates',['CharWeight','CharHeight'])[1].value==='DEFAULT_VALUE');
    paragraph.expect({CharWeight:150});
    const selection=paragraph.find('unchanged');
    selection.set({CharColor:0x123456}); selection.expect({String:'unchanged',CharColor:0x123456});
    const format=paragraph.get(['CharWeight','CharHeight','CharFontName','String']);
    word.assert(format.CharWeight===150 && format.String.includes('unchanged'));
    word.assert(word.constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')===0);
    const styles=doc.get('StyleFamilies').call('getByName','NumberingStyles');
    styles.call('insertByName','BeaverOutline',word.create('com.sun.star.style.NumberingStyle'));
    const rules=styles.call('getByName','BeaverOutline').get('NumberingRules');
    const level=rules.call('getByIndex',0);
    rules.call('replaceByIndex',0,word.any('[]com.sun.star.beans.PropertyValue',level));
    word.assert(t.describe('Header').items.length>0);
    t.set({RepeatHeadline:true});
    t.get('Rows').call('insertByIndex',2,1);
    const cells=t.call('getCellRangeByName','A3:B3');
    cells.call('setDataArray', [['Additional item','$250']]);
    word.assert(cells.call('getDataArray')[0][1]==='$250');
    word.target('cell:Table1/B2').find('$100').set({String:'$125'});
    unicode.find('🦫 anchor').set({String:'🦫 exact selection'});
    word.assert(word.target('header:Standard').find('UNCHANGED HEADER').get('String')==='UNCHANGED HEADER');
    word.target('page-style:Standard').set({LeftMargin:1905});
    word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'});
    const text=doc.get('Text'), cursor=text.call('createTextCursor'); cursor.call('gotoStart',false);
    const bookmark=word.create('com.sun.star.text.Bookmark'); bookmark.set({Name:'beaver_anchor'});
    text.call('insertTextContent',cursor,bookmark,false);
    cursor.call('gotoStart',false); text.call('insertString',cursor,'Preamble.\\r',false);
    word.target('cell:Table1/A3').expect({String:'Additional item'});
    return {rows:t.get('Rows').get('Count'),footnotes:word.inspect({family:'footnote'}).total};
  `);
  assert.ok(candidate); assert.equal(report.reopened, true);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16000, "Receipts must not repeat large intermediate text values");
  assert.equal(report.revision_count, 2);
  assert.deepEqual(report.result, { rows: 3, footnotes: 1 });
  const body = await xml(candidate, "word/document.xml");
  for (const pattern of [/Additional item/, /Preamble\./, /w:color w:val="123456"/, /🦫 exact selection/, /\$125/, /tblHeader/, /beaver_anchor/])
    assert.match(body, pattern);
  assert.match(await xml(candidate, "word/footnotes.xml"), /paragraph 15/);
  assert.match(await xml(candidate, "word/comments.xml"), /Do not remove my note/);
  assert.match(await xml(candidate, "word/styles.xml"), /BeaverDerived/);
  if (process.env.UNO_EVIDENCE_DIR) {
    await mkdir(process.env.UNO_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.UNO_EVIDENCE_DIR, process.platform + "-candidate.docx"), candidate);
    await writeFile(path.join(process.env.UNO_EVIDENCE_DIR, process.platform + "-receipt.json"), JSON.stringify(report, null, 2));
  }
});

test("text and note edits are native revisions and can be rejected without erasing earlier reviews", async () => {
  const { candidate, report } = await preview(await source, `
    word.target('paragraph:1').find('unchanged').set({String:'revised'});
    word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'});
    return word.inspect({family:'revision',limit:100});
  `, "tracked");
  assert.ok(candidate); assert.equal(report.review_verified, true);
  assert.equal(report.mode, "tracked-candidate");
  assert.equal(report.new_revision_count, 4); assert.equal(report.revision_count, 6);
  assert.match(await xml(candidate, "word/document.xml"), /w:ins/);
  assert.match(await xml(candidate, "word/footnotes.xml"), /w:del/);
  const { candidate: rejected } = await preview(candidate, `
    const changes=word.inspect({family:'revision',limit:100}).items;
    word.review(changes.filter(r=>r.author===${JSON.stringify(report.author)}).map(r=>r.target),'reject');
    return word.inspect({family:'revision',limit:100});
  `, "tracked");
  assert.ok(rejected);
  assert.match(await xml(rejected, "word/footnotes.xml"), /paragraph 12/);
  assert.doesNotMatch(await xml(rejected, "word/footnotes.xml"), /paragraph 15/);
  assert.match(await xml(rejected, "word/document.xml"), /retained insertion[\s\S]*retained deletion/);
  const { report: read } = await runLibreOffice(candidate, { action: "inspect", family: "paragraph", limit: 6 }, signal);
  const rows = read.items as { text: string; tracked?: string }[];
  assert.deepEqual([rows[1].text, rows[1].tracked], ["Opening paragraph stays revised.", "Opening paragraph stays {+revised+}{-unchanged-}."]);
  assert.equal(rows[3].text, "Editorial history: retained insertion");
});

test("native UNO-shaped programs build tables, page layout and one list that Word keeps", async () => {
  const { candidate, report } = await preview(await source, `
    const table=doc.createInstance('com.sun.star.text.TextTable'); table.initialize(2,3);
    doc.getText().insertTextContent(word.target('paragraph:1').getEnd(), table, false);
    table.getCellRangeByName('A1:C2').setDataArray([['Milestone','Due','Amount'],['Kick-off','March','$10']]);
    table.getCellRangeByName('A1:C1').setPropertyValue('CharWeight', 150);
    const styles=word.inspect({family:'page-style',limit:100,include_text:false}).items.map(row=>row.target);
    for (const style of word.target(styles)) style.LeftMargin=word.mm(38.1);
    const [a,b,last]=word.target(['paragraph:1','paragraph:2','paragraph:6']);
    a.NumberingStyleName='Numbering 123'; b.NumberingStyleName='Numbering 123';
    last.PageDescName='Landscape';
    return [a.ListLabelString,b.ListLabelString];
  `);
  assert.ok(candidate); assert.deepEqual(report.result, ["1.", "2."]);
  assert.ok((report.unused_page_styles_not_saved as string[]).includes("page-style:First%20Page"));
  // The receipt reports the page setup Word will show, section by section.
  const sections = report.word_sections as { orientation: string; margins_in: { left: number } }[];
  assert.deepEqual(sections.map(s => [s.orientation, s.margins_in.left]), [["portrait", 1.5], ["landscape", 1.5]]);
  const body = await xml(candidate, "word/document.xml");
  assert.match(body, /Kick-off/); assert.match(body, /w:orient="landscape"/);
  const margins = [...body.matchAll(/<w:pgMar [^>]*w:left="(\d+)"/g)].map(m => m[1]);
  assert.ok(margins.length === 2 && margins.every(left => left === "2160"), String(margins));
  const lists = [...body.matchAll(/<w:numId w:val="(\d+)"/g)].map(m => m[1]);
  assert.equal(lists.length, 2); assert.equal(lists[0], lists[1]);
});

test("untrackable mixed changes fail rather than bypass Review mode", async () => {
  await assert.rejects(preview(await source, `
    word.target('paragraph:1').find('unchanged').set({String:'revised'});
    word.target('page-style:Standard').set({LeftMargin:1905});
  `, "tracked"), /reviewable|tracked/);
});

test("creation, readonly policy, unsafe native access, and failed programs use the same gateway", async () => {
  const bytes = await source;
  const made = await preview(bytes, `
    const text=doc.get('Text'),cursor=text.call('createTextCursor'); cursor.call('gotoStart',false);
    const note=word.create('com.sun.star.text.Footnote');text.call('insertTextContent',cursor,note,false);
    note.set({String:'New native note.'}); note.expect({String:'New native note.'});
    word.assert(word.inspect({family:'header-left'}).total===0);
    word.target('page-style:Standard').set({FirstIsShared:false,HeaderIsShared:false,FooterIsShared:false});
    for (const family of ['header-first','header-left','footer-first','footer-left']) {
      const story=word.target(family+':Standard'); story.set({String:family+' content'});
      story.find('content').set({String:'verified'}); story.expect({String:family+' verified'});
      word.assert(word.inspect({family}).items.some(row=>row.target===family+':Standard'));
    }
    return word.inspect({family:'footnote'}).total;
  `);
  assert.ok(made.candidate); assert.equal(made.report.result, 2);
  await assert.rejects(runLibreOffice(bytes, { action:'preview', snapshot:'0'.repeat(64), program:'return null;' }, signal), /[Ss]tale snapshot/);
  for (const text of ['not in source', 'a'])
    await assert.rejects(preview(bytes, `word.target('footnote:0').find('12').set({String:'15'}); word.target('paragraph:1').find(${JSON.stringify(text)});`), /missing or ambiguous/);
  const unsafe = await JSZip.loadAsync(bytes); unsafe.file('word/vbaProject.bin', 'never execute');
  await assert.rejects(preview(await unsafe.generateAsync({type:'nodebuffer'}), 'return null;'), /Macros and embedded/);
  await assert.rejects(runLibreOffice(bytes, {action:'inspect',snapshot:hash(bytes),program:"word.target('paragraph:1').set({String:'forbidden'});"}, signal), /read-only/);
  for (const program of ["doc.get(['Text','BasicLibraries']);", "doc.Parent;", "doc.createInstance('com.sun.star.frame.Desktop');", "doc.printPages([]);", "doc.call('getPropertyDefault','BasicLibraries');", "doc.get('TextTables').items(100000,1,['BasicLibraries']);"])
    await assert.rejects(preview(bytes, program), /document-(only|local)/);
  await assert.rejects(preview(bytes, "const p=word.target('paragraph:1');\np.frobnicate();"), /no native method frobnicate.*program line 2/);
  await assert.rejects(preview(bytes, "const x={};\n\nx.y.z;"), /program line 3/);
  await assert.rejects(preview(bytes, "const t=doc.createInstance('com.sun.star.text.TextTable'); t.initialize(2,2);\nt.getCellRangeByName('A1:B1');"),
    /getCellRangeByName: .*insertTextContent.*program line 2/);
  await assert.rejects(preview(bytes, "word.target('paragraph:1').set({HyperLinkURL:'file:///etc/passwd'});"), /HTTP|document/);
  await assert.rejects(preview(bytes, "word.target('paragraph:1').set({String:'temporary'}); throw new Error('discard me');"), /discard me/);
  await assert.rejects(runLibreOffice(bytes, {action:'inspect',program:"word.target('paragraph:1').reset(['CharWeight']);"}, signal), /read-only/);
  await assert.rejects(preview(bytes, "word.target(['paragraph:1','paragraph:99999']);"), /does not exist/);
  const inspected = await runLibreOffice(bytes, { action:'inspect', target:'paragraph:1' }, signal);
  assert.match(String(inspected.report.text), /stays unchanged/);
});
