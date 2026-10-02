// Invented inputs for the standalone Authorities end-to-end test: a brief (PDF and Word) with
// footnotes, ibid, supra, pinpoints and a starred note; a statute-like PDF with sections; a
// scanned judgment page; and the A2AJ records the stubbed service answers with. The parties,
// facts, statute and the 2030 ABKB judgment are made up. The three SCC citations are public
// reporter citations; the text served for them is placeholder prose, not the judgments.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(path.resolve(import.meta.dirname, "../../frontend/package.json"));
const JSZip = require("jszip"), { PDFDocument } = require("pdf-lib");

/** The brief as paragraphs with numbered notes; "*" is the author's own note mark. */
export const BRIEF = {
  title: "Memorandum of Argument of the Applicant",
  titleNote: "The applicant thanks the Riverbend student clinic for its research assistance.",
  webLink: "https://example.test/riverbend-clinic",
  pages: [[
    { text: "1. The applicant, a small paddling cooperative, asks the Court to set aside the refusal to renew its launch licence at the north basin." },
    { text: "2. Reasonableness is the presumptive standard of review: Canada (Minister of Citizenship and Immigration) v Vavilov, 2019 SCC 65 at para 10. A reasonable decision is internally coherent and justified in light of the legal and factual constraints.", note: "Ibid at paras 99-101." },
    { text: "3. Where a limit on a protected interest is in issue, the decision maker must weigh the objective of the limit against its effects.", note: "R v Oakes, [1986] 1 SCR 103 at 138-139." },
    { text: "4. The same weighing governs the renewal refused here.", note: "Ibid at 140." },
  ], [
    { text: "5. The licensing scheme required written notice before any refusal, and none was given.", note: "Waterways Licensing Act, SA 2031, c W-4, s 12." },
    { text: "6. Delay in deciding the renewal compounded the unfairness.", note: "R v Jordan, 2016 SCC 27 at paras 46-48; Oakes, supra note 2 at 135." },
    { text: "7. A board that departs from its own Launch Guidance Note 7 without explanation acts unreasonably.", note: "Lakeshore Rowing Club v Marsh Harbour Board, 2030 ABKB 417 at para 22." },
  ]],
};
export const NOTES = BRIEF.pages.flat().filter(({ note }) => note).map(({ note }) => note);

/** What the stubbed A2AJ answers for each case it knows; anything else is not found. */
export const A2AJ_CASES = [
  { citation: "2019 SCC 65", alternate: "[2019] 4 SCR 653", name: "Canada (Minister of Citizenship and Immigration) v. Vavilov", date: "2019-12-19", paragraphs: 110 },
  { citation: "1986 CanLII 46 (SCC)", alternate: "[1986] 1 SCR 103", name: "R. v. Oakes", date: "1986-02-28", paragraphs: 80 },
  { citation: "2016 SCC 27", alternate: "[2016] 1 SCR 631", name: "R. v. Jordan", date: "2016-07-08", paragraphs: 60 },
];
const PLACEHOLDER = ["This placeholder paragraph stands in for the reasons of the court",
  "and exists only so that the test can locate numbered paragraphs.",
  "It repeats ordinary words such as review, licence, notice and delay",
  "so that each page carries several lines of selectable text."].join(" ");
export function a2ajRecord(item) {
  const text = [`${item.name}`, `${item.alternate}`, "",
    ...Array.from({ length: item.paragraphs }, (_, index) => `[${index + 1}] ${PLACEHOLDER} Paragraph ${index + 1}.`)].join("\n\n");
  return { dataset: "SCC", citation_en: item.citation, citation2_en: item.alternate, name_en: item.name,
    document_date_en: item.date, unofficial_text_en: text, upstream_license: "Synthetic test record" };
}

const page = (body, notes) => `<section class="page"><div class="body">${body}</div>${notes ? `<div class="notes"><hr>${notes}</div>` : ""}</section>`;
const css = `@page{size:Letter;margin:0}body{margin:0;font:12pt/1.55 "Times New Roman",serif;color:#000}
.page{box-sizing:border-box;width:8.5in;height:11in;padding:1in;display:flex;flex-direction:column;page-break-after:always}
.body{flex:1}.notes{font-size:9.5pt;line-height:1.35}.notes hr{width:2in;margin:0 0 6pt;border:0;border-top:.6pt solid #000;text-align:left}
.notes p{margin:0 0 3pt}h1{font-size:14pt;text-align:center;text-transform:uppercase;margin:0 0 18pt}p{margin:0 0 10pt;text-align:justify}
sup{font-size:7pt;line-height:0}a{color:inherit;text-decoration:none}h2{font-size:12pt;margin:14pt 0 6pt}.sec{margin:0 0 8pt}.sub{margin:0 0 6pt 24pt}`;

/** The brief as a two-page PDF whose notes sit at the foot of the page that calls them. */
function briefHtml() {
  let number = 0;
  const pages = BRIEF.pages.map((items, index) => {
    const notes = [];
    // The clinic is a web link of the author's own, which the final PDF keeps.
    if (index === 0) notes.push(`<p>* ${BRIEF.titleNote.replace("Riverbend student clinic",
      `<a href="${BRIEF.webLink}">Riverbend student clinic</a>`)}</p>`);
    const body = (index === 0 ? `<h1>${BRIEF.title}<sup>*</sup></h1>` : "") + items.map(({ text, note }) => {
      if (!note) return `<p>${text}</p>`;
      number += 1; notes.push(`<p><sup>${number}</sup> ${note}</p>`);
      return `<p>${text}<sup>${number}</sup></p>`;
    }).join("");
    return page(body, notes.join(""));
  });
  return `<!doctype html><meta charset="utf-8"><style>${css}</style>${pages.join("")}`;
}

/** A statute-like PDF: parts, headed sections and numbered subsections. */
function statuteHtml() {
  const sections = [
    ["Part 1", "Interpretation", [[1, "Definitions", ["In this Act, “basin” means a body of water designated by the board.", "“licence” means a launch licence issued under Part 2."]], [2, "Application", ["This Act applies to every launch on a designated basin."]]]],
    ["Part 2", "Launch Licences", [[10, "Issue", ["The board may issue a launch licence to a club or cooperative.", "A licence expires one year after it is issued."]],
      [11, "Renewal", ["A licence holder may apply to renew a licence before it expires."]],
      [12, "Notice before refusal", ["The board shall not refuse to renew a licence without first giving the holder written notice of the proposed refusal.", "The notice must state the reasons for the proposed refusal and allow at least 30 days for a reply."]],
      [13, "Decision", ["The board shall decide an application to renew within 60 days after the reply period ends."]]]],
    ["Part 3", "General", [[14, "Regulations", ["The Minister may make regulations respecting the form of a notice under section 12."]]]],
  ];
  const body = `<h1>Waterways Licensing Act</h1><p style="text-align:center">Statutes of Alberta, 2031, Chapter W-4</p>` +
    sections.map(([part, heading, items]) => `<h2>${part} — ${heading}</h2>` + items.map(([number, title, subs]) =>
      `<p class="sec"><b>${title}</b></p>` + subs.map((text, index) => `<p class="${subs.length > 1 ? "sub" : "sec"}">${
        subs.length > 1 ? `${index === 0 ? `<b>${number}</b>` : ""}(${index + 1}) ` : `<b>${number}</b> `}${text}</p>`).join("")).join("")).join("");
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><section class="page"><div class="body">${body}</div></section>`;
}

/** A judgment page as an image only, so its text has to be recognized. */
const scanHtml = () => `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff}
.sheet{width:850px;height:1100px;padding:90px 100px;box-sizing:border-box;font:21px/1.55 "Times New Roman",serif;color:#111}
h1{font-size:23px;text-align:center;margin:0 0 6px}p{margin:0 0 18px;text-align:justify}.c{text-align:center}</style>
<div class="sheet"><h1>Court of King's Bench of Alberta</h1><p class="c">Lakeshore Rowing Club v Marsh Harbour Board, 2030 ABKB 417</p>
<p>[21] The board published guidance in 2029 that promised every club a hearing before a refusal.</p>
<p>[22] A board that departs from its own published guidance must explain why it has done so. Without that explanation the decision cannot be understood and is not reasonable.</p>
<p>[23] The application is allowed and the matter is returned to the board.</p></div>`;

/** The brief as Word: one paragraph per item, real footnotes, and the title's custom "*" mark. */
async function briefDocx() {
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const escape = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
  const run = (text) => `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
  const reference = (id, mark) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>${mark
    ? `<w:footnoteReference w:customMarkFollows="1" w:id="${id}"/></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${mark}</w:t>`
    : `<w:footnoteReference w:id="${id}"/>`}</w:r>`;
  const notes = [{ id: 1, mark: "*", text: BRIEF.titleNote }];
  let id = 1;
  const paragraphs = [`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${escape(BRIEF.title)}</w:t></w:r>${reference(1, "*")}</w:p>`];
  for (const items of BRIEF.pages) for (const { text, note } of items) {
    if (note) { id += 1; notes.push({ id, text: note }); }
    paragraphs.push(`<w:p>${run(text)}${note ? reference(id) : ""}</w:p>`);
  }
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${w}><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  zip.file("word/footnotes.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${w}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${
    notes.map(({ id, mark, text }) => `<w:footnote w:id="${id}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>${mark ? `<w:t>${mark}</w:t>` : "<w:footnoteRef/>"}</w:r>${run(` ${text}`)}</w:p></w:footnote>`).join("")}</w:footnotes>`);
  // A fixed date keeps the archive, and so its hash, the same on every run.
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", date: new Date("2030-01-01T00:00:00Z") });
}

/** Writes every input into `directory` with the browser that runs the test. */
export async function writeFixtures(browser, directory) {
  await mkdir(directory, { recursive: true });
  const page = await browser.newPage();
  try {
    const pdf = async (html) => { await page.setContent(html); return page.pdf({ preferCSSPageSize: true, printBackground: true }); };
    const files = {
      briefPdf: path.join(directory, "harbourside-brief.pdf"),
      briefDocx: path.join(directory, "harbourside-brief.docx"),
      statute: path.join(directory, "waterways-licensing-act.pdf"),
      scan: path.join(directory, "lakeshore-2030-abkb-417-scan.pdf"),
    };
    await writeFile(files.briefPdf, await pdf(briefHtml()));
    await writeFile(files.statute, await pdf(statuteHtml()));
    await writeFile(files.briefDocx, await briefDocx());
    await page.setViewportSize({ width: 850, height: 1100 });
    await page.setContent(scanHtml());
    const image = await page.screenshot({ type: "png" });
    const scan = await PDFDocument.create();
    scan.setCreationDate(new Date("2030-01-01T00:00:00Z")); scan.setModificationDate(new Date("2030-01-01T00:00:00Z"));
    const embedded = await scan.embedPng(image), sheet = scan.addPage([612, 792]);
    sheet.drawImage(embedded, { x: 0, y: 0, width: 612, height: 792 });
    await writeFile(files.scan, await scan.save());
    return files;
  } finally { await page.close(); }
}
