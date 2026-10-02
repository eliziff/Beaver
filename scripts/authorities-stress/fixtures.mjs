// Invented inputs for the stress suite, written fresh on each run: a long brief with many
// authorities (PDF and Word), a Word brief built with the parts real Word briefs carry (numbered
// paragraphs, styles, a table, tracked changes, a hyperlink, runs split mid-word, a footer page
// field), invented judgments as text PDFs and as scans, and the A2AJ records the stub answers
// with. Every party, court file, statute and article is made up; the few public SCC citations
// are served with placeholder text, never the judgments.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { A2AJ_CASES, a2ajRecord } from "../authorities-html-e2e/fixtures.mjs";
import { caseRecord, lawRecord, paragraphProse } from "./network.mjs";

const require = createRequire(path.resolve(import.meta.dirname, "../../frontend/package.json"));
const JSZip = require("jszip"), { PDFDocument } = require("pdf-lib");
const FIXED = new Date("2030-01-01T00:00:00Z");

const PLACES = ["Northbay", "Cedar Flats", "Willow Bend", "Granite Point", "Ashcombe", "Lynx Creek", "Saltmarsh",
  "Ferngrove", "Kestrel Ridge", "Otter Lake", "Brightwater", "Highcliff", "Elmstead", "Copper Hollow"];
const BODIES = ["Rowing Club", "Paddlers Co-operative", "Boat Works Ltd", "Marina Society", "Anglers Association",
  "Ferry Company", "Sailing School Inc", "Canoe Guild"];
const RESPONDENTS = ["Harbour Board", "Waterfront Commission", "Port Authority", "Municipal District", "Licensing Tribunal",
  "Conservation Authority", "Basin Council"];
const COURTS = ["ABKB", "ABCA", "ONCA", "ONSC", "BCCA", "BCSC", "FCA", "FC", "SKCA", "MBCA", "NSCA", "QCCA"];
const JOURNALS = [["Invented L Rev", 61], ["Riverbend LJ", 14], ["Journal of Harbour Law", 9], ["Prairie Admin L Q", 33]];
const SURNAMES = ["Okafor", "Lindqvist", "Tremaine", "Bellweather", "Ostrander", "Haldane", "Pemberton", "Quayle"];

/** The authorities of an invented long brief: decisions, enactments and articles, each with its
 *  A2AJ record where A2AJ would have one. Deterministic in `count`. */
export function longAuthorities(count) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const kind = index % 9 === 4 ? "law" : index % 9 === 7 ? "article" : "case";
    if (kind === "case") {
      const name = `${PLACES[index % PLACES.length]} ${BODIES[(index * 3) % BODIES.length]} v ${PLACES[(index * 5 + 2) % PLACES.length]} ${RESPONDENTS[(index * 7) % RESPONDENTS.length]}`;
      const citation = `${2031 + (index % 8)} ${COURTS[index % COURTS.length]} ${101 + index}`;
      items.push({ kind, name, citation, cite: `${name}, ${citation}`, short: name.split(" v ")[0],
        record: caseRecord({ citation, name: name.replace(" v ", " v. "), paragraphs: 24 + (index % 5) * 6 }) });
    } else if (kind === "law") {
      const name = `${PLACES[index % PLACES.length].replace(/\s/gu, "")} Waterways Act`;
      const citation = `SA ${2031 + (index % 5)}, c W-${10 + index}`;
      const sections = Array.from({ length: 14 }, (_, at) => [at + 1, at % 4 === 0 ? `Part ${at / 4 + 1} heading ${at + 1}` : null,
        `The board shall consider the ${["notice", "licence", "hearing", "reply"][at % 4]} described in section ${at + 1} before it decides an application.`]);
      items.push({ kind, name, citation, cite: `${name}, ${citation}`, short: name, record: lawRecord({ citation, name, sections }) });
    } else {
      const [journal, volume] = JOURNALS[index % JOURNALS.length];
      const author = `${["A", "B", "C", "D", "E"][index % 5]} ${SURNAMES[index % SURNAMES.length]}`;
      const title = `The ${["Duty to Give Notice", "Reasonable Licensing", "Delay and Fairness", "Boards and Basins"][index % 4]} Revisited ${index}`;
      const year = 2031 + (index % 6);
      items.push({ kind, name: title, citation: `(${year}) ${volume} ${journal} ${11 + index}`,
        cite: `${author}, “${title}” (${year}) ${volume} ${journal} ${11 + index}`, short: author.split(" ")[1] });
    }
  }
  return items;
}
const pinpointOf = (item, index) => item.kind === "case" ? `at para ${(index % 20) + 2}`
  : item.kind === "law" ? `s ${(index % 12) + 1}` : `at ${20 + (index % 9)}`;
/** The brief's paragraphs with their notes: each authority cited in full once, then by ibid, supra
 *  or a short form, as a long factum does. */
export function longBrief(count) {
  const authorities = longAuthorities(count), paragraphs = [];
  let note = 0;
  const firstNote = new Map();
  authorities.forEach((item, index) => {
    note += 1; firstNote.set(item, note);
    const text = `${paragraphs.length + 1}. The ${["applicant", "respondent", "board", "tribunal"][index % 4]} relies on the ` +
      `${["principle", "rule", "approach", "test"][index % 4]} that a decision affecting a launch licence must be ${["reasoned", "fair", "timely", "transparent"][index % 4]}.`;
    paragraphs.push({ text, note: `${item.cite}${item.kind === "article" ? "" : ","} ${pinpointOf(item, index)}.` });
    if (index % 3 === 1) { note += 1; paragraphs.push({ text: `${paragraphs.length + 1}. The same holds where the record is incomplete.`,
      note: `Ibid${item.kind === "case" ? ` at para ${(index % 20) + 4}` : item.kind === "law" ? `, s ${(index % 12) + 2}` : ` at ${30 + (index % 9)}`}.` }); }
    if (index % 5 === 3 && index > 6) {
      const earlier = authorities[index - 5]; note += 1;
      paragraphs.push({ text: `${paragraphs.length + 1}. Earlier authority points the same way.`,
        note: `${earlier.short}, supra note ${firstNote.get(earlier)} ${pinpointOf(earlier, index + 1)}.` });
    }
  });
  return { title: "Memorandum of Argument of the Applicant (Long)", authorities, paragraphs, a2aj: new Map(authorities
    .filter(({ record }) => record).map(({ citation, record }) => [citation, record])) };
}

const CSS = `@page{size:Letter;margin:0}body{margin:0;font:12pt/1.5 "Times New Roman",serif;color:#000}
.page{box-sizing:border-box;width:8.5in;height:11in;padding:1in;display:flex;flex-direction:column;page-break-after:always}
.body{flex:1}.notes{font-size:9pt;line-height:1.3}.notes hr{width:2in;margin:0 0 5pt;border:0;border-top:.6pt solid #000}
.notes p{margin:0 0 2pt}h1{font-size:14pt;text-align:center;text-transform:uppercase;margin:0 0 16pt}p{margin:0 0 9pt;text-align:justify}
sup{font-size:7pt;line-height:0}h2{font-size:12pt;margin:12pt 0 6pt}td{border:.6pt solid #000;padding:4pt;vertical-align:top}table{border-collapse:collapse;margin:0 0 9pt}`;
const esc = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
/** A brief as a paged PDF whose notes sit at the foot of the page that calls them. */
export function briefHtml({ title, paragraphs }, perPage = 4) {
  const pages = [];
  for (let start = 0, number = 0; start < paragraphs.length; start += perPage) {
    const notes = [];
    const body = (start ? "" : `<h1>${esc(title)}</h1>`) + paragraphs.slice(start, start + perPage).map(({ text, note }) => {
      if (!note) return `<p>${esc(text)}</p>`;
      number += 1; notes.push(`<p><sup>${number}</sup> ${esc(note)}</p>`);
      return `<p>${esc(text)}<sup>${number}</sup></p>`;
    }).join("");
    pages.push(`<section class="page"><div class="body">${body}</div>${notes.length ? `<div class="notes"><hr>${notes.join("")}</div>` : ""}</section>`);
  }
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${pages.join("")}`;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const run = (text, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const noteRef = (id) => `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const STYLES = xml(`<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="1440" w:right="1440"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`);
const NUMBERING = xml(`<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
const footnotesXml = (notes) => xml(`<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${
  notes.map(({ id, body }) => `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run(" ")}${body}</w:p></w:footnote>`).join("")}</w:footnotes>`);
/** A .docx package from a body and its parts, with a fixed date so its bytes repeat. */
async function docx({ body, notes = [], footer = null, links = [] }) {
  const zip = new JSZip();
  const overrides = [["/word/document.xml", "wordprocessingml.document.main+xml"], ["/word/styles.xml", "wordprocessingml.styles+xml"],
    ["/word/numbering.xml", "wordprocessingml.numbering+xml"], ["/word/footnotes.xml", "wordprocessingml.footnotes+xml"],
    ...footer ? [["/word/footer1.xml", "wordprocessingml.footer+xml"]] : []];
  zip.file("[Content_Types].xml", xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join("")}</Types>`));
  zip.file("_rels/.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  const rel = (id, type, target, external) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
  zip.file("word/_rels/document.xml.rels", xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[
    rel("rId1", "styles", "styles.xml"), rel("rId2", "numbering", "numbering.xml"), rel("rId3", "footnotes", "footnotes.xml"),
    ...footer ? [rel("rId4", "footer", "footer1.xml")] : [], ...links.map(([id, target]) => rel(id, "hyperlink", target, true))].join("")}</Relationships>`));
  zip.file("word/styles.xml", STYLES); zip.file("word/numbering.xml", NUMBERING); zip.file("word/footnotes.xml", footnotesXml(notes));
  if (footer) zip.file("word/footer1.xml", xml(`<w:ftr ${W}>${footer}</w:ftr>`));
  zip.file("word/document.xml", xml(`<w:document ${W}><w:body>${body}<w:sectPr>${footer ? '<w:footerReference w:type="default" r:id="rId4"/>' : ""}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/></w:sectPr></w:body></w:document>`));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", date: FIXED });
}
const paragraph = (content, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${content}</w:p>`;
/** The long brief as Word: numbered paragraphs and real footnotes. */
export function longBriefDocx({ title, paragraphs }) {
  const notes = [];
  const body = [paragraph(run(title), '<w:pStyle w:val="Heading1"/>'), ...paragraphs.map(({ text, note }) => {
    const id = note ? notes.push({ id: notes.length + 1, body: run(note) }) : 0;
    return paragraph(run(text.replace(/^\d+\.\s/u, "")) + (id ? noteRef(id) : ""), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  })].join("");
  return docx({ body, notes });
}

/** A Word brief written the ways real ones are: what each part tests is said beside it. */
export const VARIETY = {
  title: "Factum of the Respondent",
  // Expected outcomes, read back by the suite.
  cited: ["Jordan", "Vavilov", "Waterways Licensing Act", "Lakeshore Rowing Club"],
  struck: "R v Oakes, [1986] 1 SCR 103",
  webLink: "https://example.test/harbour-guidance",
};
export function varietyDocx() {
  const italic = "<w:i/>";
  const numbered = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  const notes = [
    { id: 1, body: run("Ibid at para 48.") },
    { id: 2, body: run("Jordan, supra note 1 at para 105; see also ") + run("Lakeshore Rowing Club v Marsh Harbour Board", italic) + run(", 2030 ABKB 417 at para 22.") },
    { id: 3, body: run("Waterways Licensing Act, SA 2031, c W-4, s 12(2).") },
  ];
  const body = [
    paragraph(run(VARIETY.title), '<w:pStyle w:val="Heading1"/>'),
    paragraph(run("Part I — Overview"), '<w:pStyle w:val="Heading2"/>'),
    // A style of cause in italics, its citation in a plain run after it, a pinpoint, and a note.
    paragraph(run("Delay in deciding a renewal is measured against the ceiling in ") + run("R v Jordan", italic) +
      run(", 2016 SCC 27 at para 46.") + noteRef(1), numbered),
    // Non-breaking spaces inside the citation, and a run split mid-word as Word's edits leave it.
    paragraph(run("Reasonableness review asks whether the decision bears the hallmarks of justification: ") +
      run("Canada (Minister of Citizenship and Immigration) v Vav", italic) + run("ilov", italic) +
      run(", 2019 SCC 65 at para 99.") + noteRef(2), numbered),
    // A citation struck out with tracked changes reads as deleted, and one inserted reads as written.
    paragraph(run("The weighing of objective and effect ") + `<w:del w:id="91" w:author="Reviewer" w:date="2031-02-01T10:00:00Z"><w:r><w:delText xml:space="preserve">described in ${VARIETY.struck} </w:delText></w:r></w:del>` +
      `<w:ins w:id="92" w:author="Reviewer" w:date="2031-02-01T10:00:00Z">${run("applies to licensing boards as well")}</w:ins>` + run("."), numbered),
    // A soft line break and a tab inside a paragraph.
    paragraph(run("The board's own guidance said so:") + "<w:r><w:br/></w:r>" + run("Guidance Note 7") + "<w:r><w:tab/></w:r>" +
      run("(published 2029)."), numbered),
    // A block quotation in its own style.
    paragraph(run("“A board that departs from its own published guidance must explain why it has done so.”"), '<w:pStyle w:val="Quote"/>'),
    // A citation inside a hyperlink to a web page of the author's own.
    paragraph(run("The guidance is published at ") + `<w:hyperlink r:id="rId20" w:history="1">${run("the board's site", '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>` +
      run(", and the statute requires notice.") + noteRef(3), numbered),
    // A table that cites an authority in a cell.
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>${
      [["Issue", "Authority"], ["Notice before refusal", "Waterways Licensing Act, SA 2031, c W-4, s 12"], ["Delay", "R v Jordan, 2016 SCC 27 at paras 46-48"]]
        .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${cell === cells[0] ? 3000 : 6000}" w:type="dxa"/></w:tcPr>${paragraph(run(cell))}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`,
    paragraph(run("Part II — Order sought"), '<w:pStyle w:val="Heading2"/>'),
    paragraph(run("The respondent asks that the appeal be dismissed, with costs."), numbered),
  ].join("");
  const footer = paragraph(`<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>`, '<w:jc w:val="center"/>');
  return docx({ body, notes, footer, links: [["rId20", VARIETY.webLink]] });
}
/** The same brief as the PDF a reader saves from Word, for the final PDF. */
export const varietyHtml = () => `<!doctype html><meta charset="utf-8"><style>${CSS}.q{margin:0 1in 9pt;font-size:11pt}</style>
<section class="page"><div class="body"><h1>${VARIETY.title}</h1><h2>Part I — Overview</h2>
<p>1. Delay in deciding a renewal is measured against the ceiling in <i>R v Jordan</i>, 2016 SCC 27 at para 46.<sup>1</sup></p>
<p>2. Reasonableness review asks whether the decision bears the hallmarks of justification: <i>Canada (Minister of Citizenship and Immigration) v Vavilov</i>, 2019 SCC 65 at para 99.<sup>2</sup></p>
<p>3. The weighing of objective and effect applies to licensing boards as well.</p>
<p>4. The board's own guidance said so:<br>Guidance Note 7 (published 2029).</p>
<p class="q">“A board that departs from its own published guidance must explain why it has done so.”</p>
<p>5. The guidance is published at <a href="${VARIETY.webLink}">the board's site</a>, and the statute requires notice.<sup>3</sup></p>
<table><tr><td>Issue</td><td>Authority</td></tr><tr><td>Notice before refusal</td><td>Waterways Licensing Act, SA 2031, c W-4, s 12</td></tr><tr><td>Delay</td><td>R v Jordan, 2016 SCC 27 at paras 46-48</td></tr></table>
<h2>Part II — Order sought</h2><p>6. The respondent asks that the appeal be dismissed, with costs.</p></div>
<div class="notes"><hr><p><sup>1</sup> Ibid at para 48.</p><p><sup>2</sup> Jordan, supra note 1 at para 105; see also <i>Lakeshore Rowing Club v Marsh Harbour Board</i>, 2030 ABKB 417 at para 22.</p>
<p><sup>3</sup> Waterways Licensing Act, SA 2031, c W-4, s 12(2).</p></div></section>`;

/** An invented judgment's pages as HTML, for a text PDF or a scan. */
const judgmentHtml = (title, citation, paragraphs, perPage) => {
  const pages = [];
  for (let start = 0; start < paragraphs.length; start += perPage) pages.push(`<section class="sheet">${start ? "" :
    `<h1>${esc(title)}</h1><p class="c">${esc(citation)}</p>`}${paragraphs.slice(start, start + perPage).map((text, index) =>
    `<p>[${start + index + 1}] ${esc(text)}</p>`).join("")}</section>`);
  return pages;
};
const SHEET = `body{margin:0;background:#fff}.sheet{width:850px;height:1100px;padding:90px 100px;box-sizing:border-box;font:20px/1.55 "Times New Roman",serif;color:#111;page-break-after:always}
h1{font-size:22px;text-align:center;margin:0 0 6px}p{margin:0 0 16px;text-align:justify}.c{text-align:center}`;
/** Invented decisions: their names, citations and paragraphs, for manual books and scans. */
export function inventedDecisions(count, paragraphs = 14) {
  return Array.from({ length: count }, (_, index) => {
    const name = `${PLACES[(index * 2 + 5) % PLACES.length]} ${BODIES[(index + 2) % BODIES.length]} v ${PLACES[(index * 3 + 1) % PLACES.length]} ${RESPONDENTS[(index + 4) % RESPONDENTS.length]}`;
    const citation = `${2032 + index} ${COURTS[(index + 3) % COURTS.length]} ${300 + index * 7}`;
    return { name, citation, paragraphs: Array.from({ length: paragraphs }, (_, at) => paragraphProse(name, at)) };
  });
}

/** Writes every input into `directory` with the browser that runs the suite. */
export async function writeStressFixtures(browser, directory, { longCount = 120 } = {}) {
  await mkdir(directory, { recursive: true });
  const page = await browser.newPage();
  const file = (name) => path.join(directory, name);
  const pdf = async (html, name) => { await page.setContent(html); await writeFile(file(name), await page.pdf({ preferCSSPageSize: true, printBackground: true })); return file(name); };
  try {
    const long = longBrief(longCount);
    const files = { long, longPdf: await pdf(briefHtml(long), "long-memorandum.pdf") };
    await writeFile(files.longDocx = file("long-memorandum.docx"), await longBriefDocx(long));
    await writeFile(files.varietyDocx = file("harbour-factum.docx"), await varietyDocx());
    files.varietyPdf = await pdf(varietyHtml(), "harbour-factum.pdf");
    // Decisions to build a book from by hand, as text PDFs, and scans of others.
    files.decisions = inventedDecisions(6);
    files.decisionPdfs = [];
    for (const [index, item] of files.decisions.slice(0, 4).entries())
      files.decisionPdfs.push(await pdf(`<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:0}${SHEET}</style>${
        judgmentHtml(item.name, item.citation, item.paragraphs, 6).join("")}`, `decision-${index + 1}.pdf`));
    files.scans = [];
    await page.setViewportSize({ width: 850, height: 1100 });
    for (const [index, item] of files.decisions.slice(4).concat(inventedDecisions(8).slice(6)).entries()) {
      const scan = await PDFDocument.create(); scan.setCreationDate(FIXED); scan.setModificationDate(FIXED);
      for (const sheet of judgmentHtml(item.name, item.citation, item.paragraphs.slice(0, 8), 4)) {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>${SHEET}</style>${sheet}`);
        const image = await scan.embedPng(await page.screenshot({ type: "png" }));
        scan.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
      }
      await writeFile(file(`scan-${index + 1}.pdf`), await scan.save());
      files.scans.push({ ...item, file: file(`scan-${index + 1}.pdf`) });
    }
    return files;
  } finally { await page.close(); }
}

/** The stub's records for the e2e fixture's public SCC citations and its invented statute. */
export const fixtureA2aj = () => new Map(A2AJ_CASES.flatMap((item) => [[item.citation, a2ajRecord(item)], [item.alternate, a2ajRecord(item)]]));
