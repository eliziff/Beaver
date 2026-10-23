#!/usr/bin/env node
// Paragraph and section ("passage") seeds over various parts of cached publisher documents, for the passage forms of a
// link (plan_targets' providerPassageTarget and canliiPassageTarget): a citation's pinpoint linked on the publisher's
// page and on CanLII, with no quotation.
//
// 1. Documents (default step): A2AJ documents whose publisher page is cached (results/page-html-manifest.jsonl, HTML
//    only: the cache tier paints no PDF; no challenged, error-status or tiny page; never LégisQuébec), each host's share of the sample as
//    its share of those documents (at least 2 per host), spread evenly over the host's documents by store id. A document
//    already in doctext.jsonl is left out (the other seed sets cover it), as is one with under 2,000 characters. Each
//    chosen document's A2AJ text is appended to doctext.jsonl as the store holds it (the raw A2AJ text the brief-derived
//    documents were read from; the engine derives the structure itself), and its store_documents request is written to
//    passage-requests.jsonl (keyed as tf-round requests.mjs keys them). Run store_documents on them next.
// 2. --assemble <stored dir>: the seeds, from each document's stored structure, as plan_targets resolves a locator
//    (range_fragment_plan): a decision's paragraphs are its nodes labelled parN with a printed number (marker_range), a
//    law's provisions its nodes labelled secN, secN(2), secN(2)(b); a label the structure holds more than once is left
//    out (the planner abstains on it). Per document:
//    - by position: the first, early (15%), middle, late (85%) and last paragraph or top-level section;
//    - by structure, one of each the document has: a decision's paragraph holding a block quotation (a later line that
//      opens or closes with a quotation mark, or "[Emphasis added]"), a list (two lines opening "(a)", "1.", "(i)", "•"),
//      a note reference glued to a word ("interests.[1]") and citations (a neutral citation, "S.C.R.", "at para");
//      a law's subsection (s 5(2)), paragraph (s 5(2)(b), s 5(a)), subparagraph (s 5(2)(b)(i)), definition ("x" means)
//      and the sections either side of its first schedule heading.
//    Each seed is in seeds.jsonl's shape: blockText the unit's own text in the structure, anchor its label (par12,
//    sec5(2)(b)), no quotations, shape "structure-part", provenance {parts, index, of, page}; labels
//    `<dataset>_<doc>_<p12|sec5(2)(b)>_part-<hash>`. Written to passage-seeds.jsonl.
// Then: plan_targets passage-seeds.jsonl doctext.jsonl <requests> <stored dir> targets.jsonl, and cache-tier-seeds.mjs.
//
// Usage: node experiments/text-fragment-fidelity/passage-seeds.mjs [--documents 320]
//        node experiments/text-fragment-fidelity/passage-seeds.mjs --assemble <stored dir>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const results = path.join(import.meta.dirname, "results");
const file = (name) => path.join(results, name);
const argument = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const lines = (name) => fs.existsSync(name)
  ? fs.readFileSync(name, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
const docKey = (citation) => citation.replace(/[^\w.-]+/gu, "_");
const laws = (dataset) => /^(?:LEGISLATION|REGULATIONS)-/u.test(dataset);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourcesPath = file("passage-sources.jsonl");

if (process.argv.includes("--assemble")) assemble(argument("--assemble"));
else await choose(Number(argument("--documents") ?? 320));

// The product's sourceUrl address rewrites (the engine's statute_page): the page a statute's A2AJ address opens.
function pageOf(address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (/(^|\.)bclaws\.gov\.bc\.ca$/iu.test(url.hostname) && url.pathname.endsWith("/xml")) url.pathname = url.pathname.slice(0, -4);
  const justice = url.hostname === "laws-lois.justice.gc.ca" && url.pathname.match(/^\/(eng|fra)\/XML\/([^/]+)\.xml$/iu);
  if (justice) {
    const language = justice[1].toLowerCase(), id = decodeURIComponent(justice[2]);
    const regulation = /^(?:SOR|SI|C\.?R\.?C\.?|DORS|TR)\b/iu.test(id);
    url.pathname = `/${language}/${language === "fra" ? regulation ? "reglements" : "lois" : regulation ? "regulations" : "acts"}/${justice[2]}/FullText.html`;
  }
  const elaws = /^(www\.)?ontario\.ca$/iu.test(url.hostname)
    && url.pathname.match(/^\/laws\/api\/v2\/legislation\/en\/doc-search\/(statute|regulation)\/([^/]+)$/iu);
  if (elaws) { url.hostname = "www.ontario.ca"; url.pathname = `/laws/${elaws[1].toLowerCase()}/${elaws[2]}`; }
  // A Decisia decision opens with its text inline (source_url's iframe and mobile flags).
  if (/\/item\/\d+\/index\.do$/iu.test(url.pathname) && /^(decisions?\.[\w-]+\.(gc\.)?ca|decisia\.lexum\.com|coadecisions\.ontariocourts\.ca)$/iu.test(url.hostname)) {
    url.searchParams.delete("iframe"); url.searchParams.delete("site_preference");
    url.searchParams.append("iframe", "true"); url.searchParams.append("site_preference", "mobile");
  }
  url.hash = "";
  return url.href;
}

async function choose(total) {
  const pages = new Map();
  for (const row of lines(file("page-html-manifest.jsonl"))) {
    if (row.challenged || (row.httpStatus ?? 200) !== 200 || !(row.bytes > 2000) || !row.file) continue;
    if (/pdf/iu.test(row.contentType ?? "") || /\.pdf$/iu.test(row.file) || /canlii\.org|legisquebec/u.test(row.url)) continue;
    pages.set(row.url, row);
  }
  const have = new Set(lines(file("doctext.jsonl")).map((row) => row.key));
  const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA, "OpenLegalData/providers/a2aj/a2aj.sqlite"), { readOnly: true });
  const byHost = new Map();
  for (const row of db.prepare("SELECT id, doc_type, dataset, citation_en, url_en FROM document WHERE url_en IS NOT NULL").iterate()) {
    const page = pageOf(row.url_en);
    const found = page && pages.has(page) ? page : pages.has(row.url_en) ? row.url_en : null;
    if (!found) continue;
    const host = new URL(found).hostname;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push({ ...row, page: found });
  }
  const all = [...byHost.values()].reduce((sum, list) => sum + list.length, 0);
  const text = db.prepare("SELECT unofficial_text_en AS text, name_en AS name, document_date_en AS date FROM document WHERE id = ?");
  const chosen = [];
  for (const [host, list] of byHost) {
    const share = Math.max(2, Math.round(total * list.length / all));
    const candidates = list.filter((row) => !have.has(docKey(row.citation_en))).sort((a, b) => a.id - b.id);
    const step = Math.max(1, candidates.length / (share * 2));
    let taken = 0;
    // Evenly spread; a document with too little text gives way to the next.
    for (let at = 0; at < candidates.length && taken < share; at += 1) {
      const row = candidates[Math.floor(at * step) % candidates.length];
      if (chosen.some((item) => item.id === row.id) || have.has(docKey(row.citation_en))) continue;
      const { text: body, name, date } = text.get(row.id) ?? {};
      if (!body || body.length < 2000) continue;
      chosen.push({ ...row, host, text: body.trim(), name, date });
      have.add(docKey(row.citation_en));
      taken += 1;
    }
    console.log(JSON.stringify({ host, cachedDocuments: list.length, share, taken }));
  }
  const doctext = fs.createWriteStream(file("doctext.jsonl"), { flags: "a" });
  const requests = [], sources = [];
  for (const row of chosen) {
    const docType = laws(row.dataset) ? "laws" : "cases";
    doctext.write(JSON.stringify({ citation: row.citation_en, dataset: row.dataset, docType, name: row.name,
      date: row.date, url: row.url_en, text: row.text, key: docKey(row.citation_en) }) + "\n");
    const input = { provider: "a2aj", citation: row.citation_en, source_kind: docType, text: row.text,
      dataset: row.dataset, require_report_start: row.dataset.toUpperCase() === "SCC", url: row.url_en };
    const key = sha(JSON.stringify(input)).slice(0, 32);
    requests.push(JSON.stringify({ key, input }));
    sources.push(JSON.stringify({ id: row.id, dataset: row.dataset, docType, citation: row.citation_en, url: row.url_en,
      page: row.page, host: row.host, stored: key }));
  }
  await new Promise((resolve) => doctext.end(resolve));
  fs.writeFileSync(file("passage-requests.jsonl"), requests.join("\n") + "\n");
  fs.writeFileSync(sourcesPath, sources.join("\n") + "\n");
  console.log(JSON.stringify({ documents: chosen.length, hosts: byHost.size, cachedDocuments: all }));
}

function assemble(stored) {
  const seeds = [];
  const tally = {};
  for (const source of lines(sourcesPath)) {
    const structurePath = path.join(stored, `${source.stored}.json`);
    if (!fs.existsSync(structurePath)) { tally.unstored = (tally.unstored ?? 0) + 1; continue; }
    const structure = JSON.parse(fs.readFileSync(structurePath, "utf8"));
    const statute = source.docType === "laws";
    const count = new Map();
    for (const node of structure.nodes) count.set(`${node.kind}\0${node.label}`, (count.get(`${node.kind}\0${node.label}`) ?? 0) + 1);
    const units = structure.nodes.filter((node) => count.get(`${node.kind}\0${node.label}`) === 1 && (statute
      ? node.kind === "section" && /^sec[\w.-]+(\([\w.]+\))*$/u.test(node.label ?? "")
      : node.kind === "paragraph" && /^par\d+$/u.test(node.label ?? "") && node.marker_range
        && node.marker_range.start < node.marker_range.end))
      .sort((a, b) => a.range.start - b.range.start)
      .map((node) => ({ label: node.label, top: !node.parent_id, depth: (node.label.match(/\(/gu) ?? []).length,
        start: node.range.start, text: structure.text.slice(node.range.start, node.range.end).trim() }))
      .filter((unit) => unit.text);
    const tops = statute ? units.filter((unit) => unit.depth === 0) : units;
    if (tops.length < 3) { tally.fewUnits = (tally.fewUnits ?? 0) + 1; continue; }
    const picked = new Map();
    const pick = (unit, part) => {
      if (!unit) return;
      const entry = picked.get(unit.label) ?? { unit, parts: [] };
      entry.parts.push(part);
      picked.set(unit.label, entry);
    };
    const at = (share) => tops[Math.round(share * (tops.length - 1))];
    pick(tops[0], "first"); pick(at(0.15), "early"); pick(at(0.5), "middle"); pick(at(0.85), "late"); pick(tops.at(-1), "last");
    // One of each kind, from a document-specific starting point so a kind is not always the earliest instance.
    const offset = parseInt(sha(source.citation).slice(0, 6), 16);
    const rotated = units.map((_, index) => units[(index + offset) % units.length]);
    const first = (part, test) => pick(rotated.find((unit) => !picked.has(unit.label) && test(unit)), part);
    const laterLines = (unit) => unit.text.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    if (statute) {
      first("subsection", (unit) => /^sec[\w.-]+\(\d+[\w.]*\)$/u.test(unit.label));
      first("paragraph", (unit) => /^sec[\w.-]+(\(\d+[\w.]*\))?\([a-z]{1,2}(\.\d+)?\)$/u.test(unit.label));
      first("subparagraph", (unit) => unit.depth >= 2 && /\((?:[ivx]+|[A-Z])\)$/u.test(unit.label));
      first("definition", (unit) => /^[*“"]{1,2}[^*”"\n]{1,80}[*”"]{1,2}\s+(means|includes)\b/u.test(unit.text.replace(/^\(\w+\)\s*/u, "")));
      const schedule = structure.text.search(/^(?:#{1,6}\s*)?\**(?:SCHEDULE|Schedule)\b/mu);
      if (schedule > 0) {
        pick(tops.filter((unit) => unit.start < schedule).at(-1), "before-schedule");
        pick(units.find((unit) => unit.start > schedule), "after-schedule");
      }
    } else {
      first("block-quote", (unit) => laterLines(unit).some((line) => /^[“"]|[”"]$|\[Emphasis/u.test(line)));
      first("list", (unit) => laterLines(unit).filter((line) => /^(\(?[a-z0-9ivx]{1,4}\)|[a-z0-9]{1,3}\.|[•\-–])\s/u.test(line)).length >= 2);
      first("note", (unit) => /[\p{L}.,;:)”"]\[\d{1,3}\]/u.test(unit.text));
      first("citations", (unit) => /\b(?:19|20)\d{2} [A-Z][A-Za-z]{1,7} \d+\b|S\.C\.R\.|\bat paras?\.? \d/u.test(unit.text));
    }
    for (const { unit, parts } of picked.values()) {
      const label = `${source.dataset}_${docKey(source.citation)}_${unit.label.startsWith("par") ? `p${unit.label.slice(3)}` : unit.label}_part-${sha(`${source.id}\0${unit.label}\0part`).slice(0, 10)}`;
      seeds.push({ providerClass: statute ? "a2aj-legislation" : "a2aj-case", dataset: source.dataset, url: source.url,
        anchor: unit.label, blockText: unit.text, label, shape: "structure-part", quotes: [],
        provenance: { parts, index: units.indexOf(unit), of: units.length,
          page: source.page, host: source.host } });
      for (const part of parts) tally[part] = (tally[part] ?? 0) + 1;
    }
  }
  fs.writeFileSync(file("passage-seeds.jsonl"), seeds.map((seed) => JSON.stringify(seed)).join("\n") + "\n");
  console.log(JSON.stringify({ seeds: seeds.length, ...tally }));
}
