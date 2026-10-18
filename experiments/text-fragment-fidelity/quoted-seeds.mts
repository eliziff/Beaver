#!/usr/bin/env node
// Text-fragment seeds from real quotations: passages of cached sources (documents with a cached publisher or CanLII
// page) that other decisions in the local A2AJ store quote. Each citing decision is read as Authorities reads a
// brief (importStandaloneAuthoritiesFile over the decision's paragraphs, the engine's own paragraph structure), its
// quotations tied to the citations that follow them by the quotation check's own association (splitQuoteChecks), and
// each quotation that cites a cached source is located in that source as the quotation check locates it (checkQuotes'
// steps without the links it plans: citedSourceReader, quoteScopes of the citation's pinpoints, the engine's
// quoteLocateDocument over the source's A2AJ text). Citations are the engine's (the importer's extract/resolve) and
// are matched to a cached source by citationLookupKey, so parallel citations and resolved short forms count. A
// quotation found in the source (location not "unmatched") becomes a seed: the block holding it (blockText) at its
// paragraph or section (anchor), the quoted words as the check found them (quotes: its fragment), and where it came
// from (provenance: the citing decision, its passage, the check's status and `flags` — "differs" where the check is a
// mismatch, "inexact" where the match is not perfect, "not-at-cited-pinpoint" where it was found elsewhere). The same
// words of the same block quoted by several decisions are one seed (`alsoQuotedBy`). Quotations under three words and
// blocks with no par/sec label are left out. Lookups stay on this computer (keepLookupsLocal; fetch is disabled).
// Citing decisions are shortlisted (A2AJ's cases-citing list for a case, the store's full-text index for a statute's
// citation), `--citers` per source spread over the list, under a `--budget` of decisions shared among datasets as
// their cached sources are. Journal articles are not read yet.
//
// Usage (repo root; the 2026-10-18 set: --budget 4000 --citers 8, two shards):
//   npx tsx --tsconfig backend/tsconfig.dev.json experiments/text-fragment-fidelity/quoted-seeds.mts \
//     [--cached FILE] [--budget N] [--citers N] [--sources N] [--select-only] [--shard i/n] [--assemble]
// Writes, under results/: quoted-sources.jsonl (the cached sources and their citing decisions), quoted-found-<shard>
// and quoted-progress-<shard>.jsonl (each located quotation; each citing decision done, so a rerun resumes); with
// --assemble, quoted-seeds.jsonl (seeds in seeds.jsonl's shape plus `provenance`, shape "real-quote", labels
// `<dataset>_<doc>_<p12|sec4>_quoted-<hash>`) and quoted-requests.jsonl (the store_documents requests of their cited
// documents, as tf-round requests.mjs derives them), and appends each cited document's text missing from
// doctext.jsonl, as harvest-doctext.mjs writes it. The seeds then run through plan_targets and cache-tier-seeds.mjs
// unchanged.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

globalThis.fetch = (async () => { throw new Error("network lookups are disabled in this harness"); }) as typeof fetch;
const lib = new URL("../../backend/src/lib/", import.meta.url).href;
const { structureNative } = await import(lib + "structureNative.ts");
const { keepLookupsLocal } = await import(lib + "legalSources/index.ts");
const { a2ajLegalSourceProvider } = await import(lib + "legalSources/a2aj.ts");
const { legalSourceOperations } = await import(lib + "legalSourceApplication.ts");
const { importStandaloneAuthoritiesFile } = await import(lib + "authoritiesImport.ts");
const { splitQuoteChecks, citedSourceReader, quoteScopes } = await import(lib + "quoteCheck.ts");
const { splitQuoteCitationUnits } = await import(lib + "quoteCitationSplit.ts");
const { sourceUrl } = await import(new URL("./builder-candidate.ts", import.meta.url).href);
keepLookupsLocal(true);

const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const SOURCES = Number(argument("--sources") ?? Infinity);
const CITERS = Number(argument("--citers") ?? 8);
const [shard, shards] = (argument("--shard") ?? "0/1").split("/").map(Number);
const MIN_WORDS = 3;

const results = path.join(import.meta.dirname, "results");
const file = (name: string) => path.join(results, name);
const lines = (name: string) => fs.existsSync(name)
  ? fs.readFileSync(name, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
const native = structureNative();
const key = (text: string) => { try { return native.citationLookupKey(text); } catch { return ""; } };
const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA!, "OpenLegalData/providers/a2aj/a2aj.sqlite"), { readOnly: true });
const byKey = db.prepare(`SELECT d.id, d.doc_type, d.dataset, d.citation_en, d.citation2_en, d.name_en, d.url_en
  FROM citation_lookup c JOIN document d ON d.id = c.document_id WHERE c.citation_key = ?`);
const docKey = (citation: string) => citation.replace(/[^\w.-]+/gu, "_");

// 1. The cached sources: A2AJ documents whose publisher page (builder-candidate's sourceUrl of the A2AJ address) is in
// the provider page cache, or whose CanLII page is in the Pinpointer corpus (by the citation its title opens with).
type Source = { id: number; docType: string; dataset: string; citation: string; citation2: string | null;
  name: string | null; url: string; pages: string[]; citing: number; citers: number[] };
const sourcesPath = file("quoted-sources.jsonl");
let sources: Source[] = lines(sourcesPath);
if (!sources.length) {
  const pages = new Set(lines(file("page-html-manifest.jsonl"))
    .filter((row) => !row.challenged && (row.httpStatus ?? 200) === 200 && row.bytes > 2000).map((row) => row.url));
  const found = new Map<number, Source>();
  const add = (row: any, page: string) => {
    const source = found.get(row.id) ?? { id: row.id, docType: row.doc_type, dataset: row.dataset,
      citation: row.citation_en, citation2: row.citation2_en, name: row.name_en, url: row.url_en, pages: [],
      citing: row.citing_cases_count ?? 0, citers: [] };
    if (!source.pages.includes(page)) source.pages.push(page);
    found.set(row.id, source);
  };
  // `--cached FILE`: the documents an earlier scan found (rows with `id` and `page`), so the store is not read whole again.
  const cached = argument("--cached");
  const byId = db.prepare(`SELECT id, doc_type, dataset, citation_en, citation2_en, name_en, url_en, citing_cases_count
    FROM document WHERE id = ?`);
  if (cached) for (const hit of lines(cached)) if (hit.provider !== "canlii") add(byId.get(hit.id), hit.page);
  if (!cached) for (const row of db.prepare(`SELECT id, doc_type, dataset, citation_en, citation2_en, name_en, url_en,
      citing_cases_count FROM document WHERE url_en IS NOT NULL`).iterate() as Iterable<any>) {
    let page: string | null = null;
    try { page = sourceUrl(row.url_en); } catch { /* not a page address */ }
    if (page && pages.has(page)) add(row, page); else if (pages.has(row.url_en)) add(row, row.url_en);
  }
  for (const entry of lines(path.join(process.env.LOCALAPPDATA!, "OpenLegalData/pinpointer-corpus/index.jsonl"))) {
    if (entry.provider !== "canlii" || !entry.title) continue;
    const rows = byKey.all(key(String(entry.title).split(" | ")[0].replace(/\s*\(CanLII\)\s*$/u, ""))) as any[];
    if (rows.length === 1) add({ ...rows[0], citing_cases_count: null }, entry.url);
  }
  sources = [...found.values()].map((source) => ({ ...source, citers: null as unknown as number[] }));
  fs.writeFileSync(sourcesPath, sources.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
// 2. A source's citing decisions, found when the source is chosen: A2AJ's list of the cases citing a case (evenly
// spread over it, since it runs by date, so the citers span years and courts); for legislation, decisions whose text
// holds its citation (the store's full-text index). These only shortlist; the engine reads every citation.
const citingOf = db.prepare("SELECT cases_citing_en AS citing, citing_cases_count AS count FROM document WHERE id = ?");
const fts = db.prepare(`SELECT rowid AS id FROM document_search WHERE document_search MATCH ? LIMIT 200`);
const kindOf = db.prepare("SELECT doc_type FROM document WHERE id = ?");
function spread<T>(items: T[], count: number) {
  const step = Math.max(1, items.length / count);
  return [...new Set(Array.from({ length: Math.min(count, items.length) }, (_, at) => items[Math.floor(at * step)]))];
}
function citersOf(source: Source) {
  if (source.citers) return source.citers;
  const ids: number[] = [];
  if (source.docType === "cases") {
    let list: string[] = [];
    try { list = JSON.parse((citingOf.get(source.id) as any)?.citing ?? "[]"); } catch { list = []; }
    for (const citation of spread(list, CITERS * 2)) {
      const hit = (byKey.all(key(citation)) as any[]).find((item) => item.doc_type === "cases");
      if (hit && hit.id !== source.id) ids.push(hit.id);
    }
  } else {
    const words = source.citation.match(/[\p{L}\p{N}]+/gu) ?? [];
    // As written ("RSA 2000, c L-8") and dotted ("R.S.A. 2000, c. L-8"), whose series the index reads letter by letter.
    const dotted = words.flatMap((word, at) => at === 0 && /^[A-Z]{2,5}$/u.test(word) ? [...word] : [word]);
    try {
      for (const row of fts.all(`unofficial_text_en : ("${words.join(" ")}" OR "${dotted.join(" ")}")`) as any[])
        if ((kindOf.get(row.id) as any)?.doc_type === "cases") ids.push(row.id);
    } catch { /* a citation the index cannot phrase */ }
  }
  return source.citers = spread(ids, CITERS);
}
console.log(JSON.stringify({ sources: sources.length }));

if (process.argv.includes("--assemble")) { await assemble(); process.exit(0); }

// 3. Each citing decision once, with the cached sources it cites.
// `--budget N` citing decisions, shared among the datasets as their cached sources are; in each, the most cited
// sources first, taken in turn.
const BUDGET = Number(argument("--budget") ?? Infinity);
const byDataset = new Map<string, Source[]>();
for (const source of sources) byDataset.set(source.dataset, [...byDataset.get(source.dataset) ?? [], source]);
const targetsOf = new Map<number, Set<number>>();
const chosen: Source[] = [];
for (const [, members] of byDataset) {
  const share = Math.max(CITERS, Math.round(BUDGET * members.length / sources.length));
  let used = 0;
  for (const source of [...members].sort((a, b) => (b.citing ?? 0) - (a.citing ?? 0))) {
    if (used >= share || chosen.length >= SOURCES) break;
    if (!citersOf(source).length) continue;
    chosen.push(source);
    for (const citer of source.citers) {
      if (!targetsOf.has(citer)) { targetsOf.set(citer, new Set()); used += 1; }
      targetsOf.get(citer)!.add(source.id);
    }
  }
}
fs.writeFileSync(sourcesPath, sources.map((row) => JSON.stringify(row)).join("\n") + "\n");
if (process.argv.includes("--select-only")) {
  console.log(JSON.stringify({ chosenSources: chosen.length, citingDecisions: targetsOf.size }));
  process.exit(0);
}
const sourceById = new Map(sources.map((source) => [source.id, source]));
const sourceKeys = new Map<string, number>();
for (const source of sources) for (const citation of [source.citation, source.citation2]) {
  const value = citation ? key(citation) : "";
  if (value) sourceKeys.set(value, source.id);
}
// Each shard writes its own files; every shard's progress counts as done.
const shardFiles = (prefix: string) => fs.readdirSync(results).filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
  .map((name) => file(name));
const progressPath = file(`quoted-progress-${shard}.jsonl`);
const done = new Set(shardFiles("quoted-progress-").flatMap(lines).map((row) => row.citer));
const citers = [...targetsOf.keys()].filter((id, index) => index % shards === shard && !done.has(id));
console.log(JSON.stringify({ chosenSources: chosen.length, citingDecisions: targetsOf.size, pending: citers.length }));
const document = db.prepare("SELECT id, dataset, citation_en, name_en FROM document WHERE id = ?");
const progress = fs.createWriteStream(progressPath, { flags: "a" });
const foundOut = fs.createWriteStream(file(`quoted-found-${shard}.jsonl`), { flags: "a" });

for (const [at, citer] of citers.entries()) {
  const started = Date.now();
  const row = document.get(citer) as any, rowOf = row;
  const counts = { quotes: 0, cited: 0, located: 0 };
  try {
    const citing = await a2ajLegalSourceProvider.document({ citation: row.citation_en, docType: "cases",
      language: "en", dataset: row.dataset, discoverPdf: false });
    if (!citing) throw new Error("citing decision not in the store");
    const text = native.documentText(citing.native);
    // The decision's paragraphs, as the engine's structure of it places them; front matter is the first unit.
    const cuts = [...new Set([0, ...native.documentAnchors(citing.native)
      .filter((anchor: any) => anchor.kind === "paragraph").map((anchor: any) => anchor.start)])].sort((a, b) => a - b);
    const units = cuts.map((start, index) => ({ key: `u${index}`, kind: "body" as const, ordinal: index,
      footnote_id: null, page_numbers: [], footnote_refs: [], text: text.slice(start, cuts[index + 1] ?? text.length).trimEnd() }))
      .filter((unit) => unit.text.trim());
    const draft = await importStandaloneAuthoritiesFile({ filename: `${docKey(row.citation_en)}.docx`, fileType: "docx",
      bytes: Buffer.from(text), modified: 0 }, undefined,
    { docxAuthorityTextUnits: async () => units, pdfAuthorityTextUnits: () => [] } as never);
    const wanted = targetsOf.get(citer)!;
    // The quotation check's own steps (checkQuotes without the links it plans): each quotation with the citations
    // after it (splitQuoteChecks), each cited source read (citedSourceReader), and each located in its source by the
    // engine (quoteLocateDocument) within the paragraphs or provisions its pinpoints name (quoteScopes). Only the
    // cached sources this decision was shortlisted for are looked up; every other citation finds no source.
    const split = await splitQuoteCitationUnits(draft.units.map(({ text }: { text: string }) => text));
    const rows = splitQuoteChecks(draft, [], split);
    counts.quotes = rows.length;
    const read = citedSourceReader({ ...legalSourceOperations, async resolve(request: any) {
      const id = sourceKeys.get(key(request.text));
      if (id === undefined || !wanted.has(id)) return { status: "not_found" };
      return legalSourceOperations.resolve({ ...request, providers: ["a2aj"], discoverPdf: false });
    } } as never);
    const bySource = new Map<unknown, Array<{ row: any; pinpoints: any[]; source: any; id: number }>>();
    for (const row of rows) for (const candidate of row.candidates) {
      if ((row.quote.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < MIN_WORDS) continue;
      const occurrence = draft.occurrences[candidate.id];
      const authority = occurrence?.authorityId ? draft.authorities[occurrence.authorityId] : candidate;
      if (!authority) continue;
      const found = await read(authority, candidate.text);
      if (found.missing) continue;
      const id = sourceKeys.get(key(found.source.citation ?? ""));
      if (id === undefined || !wanted.has(id) || sourceById.get(id)!.dataset !== found.source.collection) continue;
      counts.cited += 1;
      const list = bySource.get(found.document) ?? [];
      list.push({ row, pinpoints: occurrence?.pinpoints ?? candidate.pinpoints ?? [], source: found.source, id });
      bySource.set(found.document, list);
    }
    for (const [sourceDocument, items] of bySource) {
      const located = await native.quoteLocateDocument(sourceDocument as never, "text",
        items.map(({ row, pinpoints }) => ({ quote: row.quote, scopes: quoteScopes(pinpoints), id: row.id })), true);
      items.forEach(({ row, pinpoints, source, id }, index) => {
        const { match, comparison, errors } = located[index];
        if (match.location === "unmatched") return;
        counts.located += 1;
        // As checkQuotes: verified where the source holds it as written, else a mismatch (differences or elsewhere).
        const verified = comparison !== null && errors !== undefined && errors.length === 0;
        foundOut.write(JSON.stringify({ citer, source: id, sourceCitation: source.citation,
          citingCitation: rowOf.citation_en, citingDataset: rowOf.dataset, citingName: rowOf.name_en,
          quote: row.quote, context: row.context, quoteStart: row.start, quoteEnd: row.end,
          pinpoints: pinpoints.map((pinpoint: any) => pinpoint.text), status: verified ? "verified" : "mismatch",
          location: match.location, perfect: match.perfect, labels: match.labels, pinpoint: match.pinpoint,
          fragment: match.fragment, block: match.text, errors: errors ?? [], changes: comparison?.changes ?? [] }) + "\n");
      });
    }
    progress.write(JSON.stringify({ citer, citing: row.citation_en, ...counts, ms: Date.now() - started }) + "\n");
  } catch (error) {
    progress.write(JSON.stringify({ citer, citing: row?.citation_en, error: String(error), ms: Date.now() - started }) + "\n");
  }
  if (at % 10 === 0) console.log(JSON.stringify({ at, of: citers.length, citing: row?.citation_en, ...counts, ms: Date.now() - started }));
}
await new Promise((resolve) => progress.end(resolve));
await new Promise((resolve) => foundOut.end(resolve));

// 4. The seeds: each located quotation once per passage of its source (the same words of the same block, however many
// decisions quote them, the others kept as `alsoQuotedBy`), with its source's text in doctext.jsonl and its stored
// structure's request.
async function assemble() {
  const sourceOf = new Map(sources.map((source) => [source.id, source]));
  const doctext = new Map<string, { dataset: string }>();
  for (const line of fs.readFileSync(file("doctext.jsonl"), "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const { key: name, dataset } = JSON.parse(line);
    doctext.set(name, { dataset });
  }
  const words = (value: string) => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
  const seeds = new Map<string, any>();
  const sourceIdOf = new Map<string, number>();
  const tally = { found: 0, kept: 0, flagged: 0, duplicates: 0, unanchored: 0, keyClash: 0 };
  for (const hit of fs.readdirSync(results).filter((name) => /^quoted-found-\d+\.jsonl$/u.test(name)).flatMap((name) => lines(file(name)))) {
    tally.found += 1;
    const source = sourceOf.get(hit.source);
    if (!source) continue;
    const label = String(hit.labels?.[0] ?? "");
    const paragraph = label.match(/^par(\d+)$/u), section = label.match(/^sec([^\s_]+)$/u);
    if (!paragraph && !section) { tally.unanchored += 1; continue; }
    const name = docKey(source.citation);
    if (doctext.has(name) && doctext.get(name)!.dataset !== source.dataset) { tally.keyClash += 1; continue; }
    const quote = hit.fragment || hit.quote;
    const identity = `${source.id}\0${label}\0${words(quote)}`;
    const citing = { citation: hit.citingCitation, dataset: hit.citingDataset, name: hit.citingName };
    if (seeds.has(identity)) {
      tally.duplicates += 1;
      const kept = seeds.get(identity);
      if (!kept.provenance.alsoQuotedBy.some((item: any) => item.citation === citing.citation))
        kept.provenance.alsoQuotedBy.push(citing);
      continue;
    }
    const flags = [
      ...hit.status !== "verified" ? ["differs"] : [],
      ...!hit.perfect ? ["inexact"] : [],
      ...String(hit.location).startsWith("alternate") ? ["not-at-cited-pinpoint"] : [],
    ];
    // The citing passage: the quotation with the words around it in the citing decision's paragraph.
    const excerpt = String(hit.context).slice(Math.max(0, hit.quoteStart - 300), hit.quoteEnd + 300).replace(/\s+/gu, " ").trim();
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 10);
    sourceIdOf.set(`${source.dataset}_${name}_${paragraph ? `p${paragraph[1]}` : label}_quoted-${hash}`, source.id);
    seeds.set(identity, {
      providerClass: source.docType === "laws" ? "a2aj-legislation" : "a2aj-case", dataset: source.dataset,
      url: source.url, anchor: label, blockText: hit.block,
      label: `${source.dataset}_${name}_${paragraph ? `p${paragraph[1]}` : label}_quoted-${hash}`,
      shape: "real-quote", quotes: [quote],
      provenance: { citing, citedAs: hit.pinpoints, quoteAsWritten: hit.quote, passage: excerpt, status: hit.status,
        location: hit.location, perfect: hit.perfect, flags, changes: hit.changes, errors: hit.errors,
        cachedPages: source.pages, alsoQuotedBy: [] },
    });
  }
  const rows = [...seeds.values()];
  tally.kept = rows.length;
  tally.flagged = rows.filter((row) => row.provenance.flags.length).length;
  fs.writeFileSync(file("quoted-seeds.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  // The cited documents' texts, as harvest-doctext.mjs writes them, and their structures' requests (tf-round
  // requests.mjs): the planner reads a document by its doctext key and its request by citation and dataset.
  const cited = [...new Set(rows.map((row) => sourceIdOf.get(row.label)!))];
  const appended: string[] = [];
  const requests: string[] = [];
  const doctextOut = fs.createWriteStream(file("doctext.jsonl"), { flags: "a" });
  for (const id of cited) {
    const source = sourceOf.get(id)!;
    const name = docKey(source.citation);
    const docType = source.docType === "laws" ? "laws" : "cases";
    const compiled = await a2ajLegalSourceProvider.document({ citation: source.citation, docType, language: "en",
      dataset: source.dataset, sourceUrl: source.url, discoverPdf: false });
    const text = compiled?.native ? native.documentText(compiled.native) : "";
    if (!text) continue;
    if (!doctext.has(name)) {
      doctextOut.write(JSON.stringify({ citation: source.citation, dataset: source.dataset, docType,
        name: compiled.name, date: compiled.date, url: source.url, text, key: name }) + "\n");
      doctext.set(name, { dataset: source.dataset });
      appended.push(name);
    }
    const input = { provider: "a2aj", citation: source.citation, source_kind: docType, text, dataset: source.dataset,
      require_report_start: source.dataset.toUpperCase() === "SCC", url: source.url };
    requests.push(JSON.stringify({ key: createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32), input }));
  }
  await new Promise((resolve) => doctextOut.end(resolve));
  fs.writeFileSync(file("quoted-requests.jsonl"), requests.join("\n") + "\n");
  console.log(JSON.stringify({ ...tally, documents: cited.length, doctextAppended: appended.length }));
}
