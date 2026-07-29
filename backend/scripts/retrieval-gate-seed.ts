/**
 * Derive the v1 retrieval-gate seed set from the local A2AJ laws corpus
 * (docs/pinpoint-retrieval-and-vector-embeddings.md, "Vector boundary and
 * benchmark gate"). Writes benchmarks/retrieval_gate/{set-v1.json,
 * slice-v1.json, set.schema.json, slice.schema.json}.
 *
 *   npx tsx scripts/retrieval-gate-seed.ts [--corpus <a2aj_corpus/laws dir>]
 *
 * PROVENANCE. The corpus is A2AJ's bulk snapshot as installed by the ALR
 * Quote Verifier (read-only reference implementation; never runtime-imported
 * here). This script reads only corpus DATA: laws/manifest.json (revision +
 * per-file sha256) and the manifest-listed train.parquet files, via an
 * embedded python+duckdb probe (duckdb is the local parquet reader; no
 * network). Document identity is Beaver's citationLookupKey — a port of the
 * reference normalizer whose equivalence is proven by
 * scripts/retrieval-gate-oracle-probe.py plus the differential test in
 * src/lib/__tests__/retrievalGate.test.ts. Structural handles come from the
 * corpus's own unofficial_sections_en map (provider-native structure, no
 * parsing) and speak the shared `sec<label>` dialect of
 * a2aj_structure.single_section_blocks / sourceDocA2AJ / legalTextSkeleton.
 *
 * HONEST LIMITATION — EASY TIER ONLY. Every query here is a mechanical
 * rephrasing of a section heading / marginal note, so lexical overlap with
 * the gold section is built in and a lexical retriever is structurally
 * favoured. This tier can detect a BROKEN retriever; it cannot bless or damn
 * a vector index. Hand-authored adversarial items — paraphrased propositions,
 * ambiguous legal terms, cross-reference asks, and negatives with no
 * supporting source — must be added (as set-v2) before the asymmetric gate's
 * verdict means anything. The same note ships inside set-v1.json's `notes`.
 *
 * Derivation is fully deterministic — no LLM, no network, no randomness:
 *
 * 1. EXTRACT: for each dataset (FED, ON, BC, AB legislation), select rows
 *    with citation, name, text, and a section map of 20-120 sections; order
 *    by citation; stride-pick 12 candidate documents at indices
 *    floor(i*n/12). Sections are emitted as ordered [label, text] pairs
 *    (JS objects would reorder integer-like keys).
 * 2. HEADINGS: no structure regexes. Each section's position is found by
 *    verbatim prefix search of its provider-supplied text inside the
 *    document markdown; the heading is the nearest preceding non-blank line
 *    when that line is markdown presentation for a heading (##/###/#### or a
 *    whole-line **bold** marginal note). Headings that are numeric,
 *    "Repealed", Part/Division/Schedule banners, shorter than 4 or longer
 *    than 120 chars, or duplicated within the document are rejected.
 * 3. GOLD: per dataset take the first 4 candidate documents with >= 3
 *    eligible sections; per document stride-pick 3 eligible sections. The
 *    remaining candidates contribute no gold but ALL their sections join the
 *    slice as distractors. Gold locator = `sec` + provider section label.
 *    Gold quote = the section's first sentence (leading "(1)" enumerator
 *    skipped; sentence ends at the first period preceded by [a-z0-9)] and
 *    followed by a capital — so "R.S.O." and "s. 114" don't cut early — or
 *    at the first ";" or blank line), kept only when its whitespace-
 *    normalized length is 40-300 chars.
 * 4. QUERIES: four fixed templates cycled by item index, filled with the act
 *    name and the heading folded to lowercase (words whose second character
 *    is uppercase or a digit — acronyms — keep their case).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  RETRIEVAL_GATE_DIR,
  checkRetrievalSetAgainstSlice,
  citationLookupKey,
  loadRetrievalSet,
  loadRetrievalSlice,
  retrievalGateJsonSchemas,
  type RetrievalItem,
  type RetrievalSliceDoc,
} from "../src/lib/retrievalGate";

const SET_ID = "retrieval-gate-set-v1";
const CANDIDATE_DOCS_PER_DATASET = 12;
const DOCS_PER_DATASET = 4;
const SECTIONS_PER_DOC = 3;
const DATASETS: Array<{ dataset: string; jurisdiction: string }> = [
  { dataset: "LEGISLATION-FED", jurisdiction: "CA" },
  { dataset: "LEGISLATION-ON", jurisdiction: "CA-ON" },
  { dataset: "LEGISLATION-BC", jurisdiction: "CA-BC" },
  { dataset: "LEGISLATION-AB", jurisdiction: "CA-AB" },
];

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const corpusDir = argument(
  "corpus",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "ALR Quote Verifier",
    "a2aj_corpus",
    "laws",
  ),
);

// ---------------------------------------------------------------------------
// Extraction probe: python + duckdb over corpus data files only.
// ---------------------------------------------------------------------------

const PY_EXTRACT = `
import json, os, re, sys
import duckdb

out_path, base = sys.argv[1], sys.argv[2]
datasets = json.loads(sys.argv[3])
per_dataset = int(sys.argv[4])
LABEL_RE = re.compile(r"^[0-9][0-9.()a-z]*$")

with open(os.path.join(base, "manifest.json"), encoding="utf-8") as fh:
    manifest = json.load(fh)
files = {item["path"]: item for item in manifest.get("files") or ()}

result = {"revision": str(manifest.get("revision") or "unknown"), "datasets": {}}
with duckdb.connect() as connection:
    connection.execute("PRAGMA disable_progress_bar")
    for ds in datasets:
        relative = ds + "/train.parquet"
        if relative not in files:
            raise SystemExit("dataset not in corpus manifest: " + ds)
        p = os.path.join(base, ds, "train.parquet")
        rows = connection.execute(
            "SELECT citation_en, name_en, unofficial_text_en, unofficial_sections_en "
            "FROM read_parquet(?) "
            "WHERE citation_en IS NOT NULL AND name_en IS NOT NULL "
            "AND unofficial_text_en IS NOT NULL AND unofficial_sections_en IS NOT NULL "
            "AND num_sections_en BETWEEN 20 AND 120 ORDER BY citation_en",
            [p],
        ).fetchall()
        n = len(rows)
        take = min(per_dataset, n)
        picked = sorted({(i * n) // take for i in range(take)})
        candidates = []
        for i in picked:
            citation, name, text, sections_json = rows[i]
            raw = json.loads(sections_json)
            sections = [
                [k, v]
                for k, v in raw.items()
                if isinstance(v, str) and v.strip() and LABEL_RE.match(k)
            ]
            if sections:
                candidates.append({
                    "citation": citation,
                    "name": name,
                    "text": text,
                    "sections": sections,
                })
        result["datasets"][ds] = {
            "sha256": files[relative].get("sha256"),
            "filtered_docs": n,
            "candidates": candidates,
        }
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, ensure_ascii=False)
`;

interface ExtractedDoc {
  citation: string;
  name: string;
  text: string;
  /** [provider label, section text] in document order. */
  sections: Array<[string, string]>;
}
interface Extraction {
  revision: string;
  datasets: Record<
    string,
    { sha256: string | null; filtered_docs: number; candidates: ExtractedDoc[] }
  >;
}

function extract(): Extraction {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "retrieval-gate-"));
  const outPath = path.join(tempDir, "extract.json");
  try {
    const run = spawnSync(
      "python",
      [
        "-",
        outPath,
        corpusDir,
        JSON.stringify(DATASETS.map((entry) => entry.dataset)),
        String(CANDIDATE_DOCS_PER_DATASET),
      ],
      { input: PY_EXTRACT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (run.status !== 0)
      throw new Error(`python extraction failed: ${run.stderr || run.error}`);
    return JSON.parse(readFileSync(outPath, "utf8")) as Extraction;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Headings: provider-text prefix search + adjacent markdown heading line.
// ---------------------------------------------------------------------------

function headingText(line: string): string | null {
  const md = line.match(/^#{2,4}\s+(.+)$/u);
  const bold = md ? null : line.match(/^\*\*(.+)\*\*$/u);
  const raw = (md?.[1] ?? bold?.[1])?.trim();
  if (!raw || raw.includes("**")) return null;
  if (raw.length < 4 || raw.length > 120) return null;
  if (/^\d/u.test(raw)) return null;
  if (/repealed/iu.test(raw)) return null;
  if (/^(part|division|schedule|annex|appendix)\b/iu.test(raw)) return null;
  return raw;
}

/**
 * Nearest preceding heading/marginal-note line for each section, else null.
 * A section is located by verbatim prefix search of its provider-supplied
 * text (48 chars, falling back to 24) from a monotonically advancing cursor —
 * document order comes from the provider section map, not from re-parsing.
 */
function sectionHeadings(
  text: string,
  sections: Array<[string, string]>,
): Map<string, string | null> {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const headings = new Map<string, string | null>();
  let cursor = 0;
  for (const [label, sectionText] of sections) {
    let found = -1;
    for (const length of [48, 24]) {
      const prefix = sectionText.slice(0, length);
      found = text.indexOf(prefix, cursor);
      if (found >= 0) break;
    }
    if (found < 0) {
      headings.set(label, null);
      continue;
    }
    cursor = found + 1;
    let index = lineAt(found) - 1;
    while (index >= 0 && lines[index].trim() === "") index -= 1;
    headings.set(label, index >= 0 ? headingText(lines[index].trim()) : null);
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Gold quote: first sentence of the section text.
// ---------------------------------------------------------------------------

/** Period preceded by [a-z0-9)"'] and followed by a capital/paren or the end,
 * so citation abbreviations ("R.S.O.", "s. 114") do not end the sentence. */
const SENTENCE_END = /(?<=[a-z0-9)\]"'”’])\.(?=\s+["'“(A-Z]|\s*$)/u;
const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();

function firstSentence(sectionText: string): string | null {
  const skip = sectionText.match(/^\s*\(\d{1,3}(?:\.\d{1,3})?\)\s*/u);
  const body = sectionText.slice(skip ? skip[0].length : 0);
  const boundaries: number[] = [];
  const period = SENTENCE_END.exec(body);
  if (period) boundaries.push(period.index + 1);
  const semicolon = body.indexOf(";");
  if (semicolon >= 0) boundaries.push(semicolon);
  const paragraph = body.indexOf("\n\n");
  if (paragraph >= 0) boundaries.push(paragraph);
  const end = boundaries.length ? Math.min(...boundaries) : body.length;
  const quote = body.slice(0, end).trimEnd();
  const length = normalized(quote).length;
  return length >= 40 && length <= 300 ? quote : null;
}

// ---------------------------------------------------------------------------
// Queries: fixed templates, mechanically filled.
// ---------------------------------------------------------------------------

/** Fold Title-case words; keep acronyms (2nd char uppercase or digit). */
function foldHeading(heading: string): string {
  return heading
    .split(" ")
    .map((word) =>
      /^[A-Z][a-z]/u.test(word)
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word,
    )
    .join(" ");
}

const TEMPLATES: Array<(name: string, topic: string) => string> = [
  (name, topic) => `What does the ${name} say about ${topic}?`,
  (name, topic) => `Under the ${name}, what are the rules on ${topic}?`,
  (name, topic) => `Where does the ${name} deal with ${topic}?`,
  (name, topic) => `${name}: which provision addresses ${topic}?`,
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function main(): void {
  const extraction = extract();
  const items: RetrievalItem[] = [];
  const sliceDocs: RetrievalSliceDoc[] = [];
  const composition: string[] = [];
  let goldDocs = 0;

  for (const { dataset, jurisdiction } of DATASETS) {
    const pool = extraction.datasets[dataset];
    if (!pool) throw new Error(`extraction missing dataset ${dataset}`);
    let docsTaken = 0;
    for (const doc of pool.candidates) {
      const citationKey = citationLookupKey(doc.citation);
      const headings = sectionHeadings(doc.text, doc.sections);
      const headingCounts = new Map<string, number>();
      for (const heading of headings.values()) {
        if (!heading) continue;
        const key = heading.toLowerCase();
        headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
      }
      const eligible = doc.sections.flatMap(([label, text]) => {
        const heading = headings.get(label);
        if (!heading || headingCounts.get(heading.toLowerCase()) !== 1)
          return [];
        if (text.startsWith("[Repealed")) return [];
        const quote = firstSentence(text);
        return quote ? [{ label, heading, quote }] : [];
      });

      const takesGold =
        docsTaken < DOCS_PER_DATASET && eligible.length >= SECTIONS_PER_DOC;
      if (takesGold) {
        docsTaken += 1;
        goldDocs += 1;
        const picked = [
          ...new Set(
            Array.from({ length: SECTIONS_PER_DOC }, (_, i) =>
              Math.floor((i * eligible.length) / SECTIONS_PER_DOC),
            ),
          ),
        ].map((index) => eligible[index]);
        for (const section of picked) {
          const itemIndex = items.length;
          items.push({
            item_id: `RG-${String(itemIndex + 1).padStart(3, "0")}`,
            query: TEMPLATES[itemIndex % TEMPLATES.length](
              doc.name,
              foldHeading(section.heading),
            ),
            corpus_ref: {
              jurisdiction,
              dataset,
              citation: doc.citation,
              citation_key: citationKey,
            },
            gold_locators: [`sec${section.label}`],
            gold_quote: section.quote,
          });
        }
        composition.push(
          `${dataset} ${doc.citation} (${doc.name}): ${picked.length} items, ${doc.sections.length} pool sections`,
        );
      }
      // Every candidate document joins the pool — gold docs and distractors.
      sliceDocs.push({
        dataset,
        jurisdiction,
        citation: doc.citation,
        citation_key: citationKey,
        name: doc.name,
        sections: doc.sections.map(([label, text]) => ({
          label: `sec${label}`,
          heading: headings.get(label) ?? null,
          text,
        })),
      });
    }
    if (docsTaken < DOCS_PER_DATASET)
      throw new Error(
        `${dataset}: only ${docsTaken}/${DOCS_PER_DATASET} eligible documents among ${pool.candidates.length} candidates`,
      );
  }

  const created = new Date().toISOString().slice(0, 10);
  const corpus = {
    source: "a2aj-laws-parquet",
    revision: extraction.revision,
    files: DATASETS.flatMap(({ dataset }) => {
      const sha256 = extraction.datasets[dataset]?.sha256;
      return sha256 ? [{ path: `${dataset}/train.parquet`, sha256 }] : [];
    }),
  };
  const set = {
    schema_version: 1,
    set_id: SET_ID,
    created,
    notes: [
      "EASY TIER ONLY: queries are mechanical rephrasings of section headings/marginal notes, so lexical overlap with the gold section is built in. This tier can detect a broken retriever; it cannot bless or damn a vector index. Hand-authored adversarial items (paraphrased propositions, ambiguous legal terms, cross-reference asks, and negatives with no supporting source) must be added before the asymmetric gate's verdict means anything.",
      "Candidate pool = slice-v1.json: every section of the 48 sampled candidate documents (16 gold + 32 pure distractors), not the full corpus; absolute recall numbers are inflated accordingly.",
      "Gold quote = first sentence of the gold section; exactly one gold locator per item. Derivation: scripts/retrieval-gate-seed.ts (deterministic, no LLM). Identity: citation_key = citationLookupKey (Beaver port of the reference normalizer, oracle-diffed in retrievalGate.test.ts).",
    ],
    corpus,
    items,
  };
  const slice = {
    schema_version: 1,
    set_id: SET_ID,
    created,
    corpus,
    docs: sliceDocs,
  };

  mkdirSync(RETRIEVAL_GATE_DIR, { recursive: true });
  const setPath = path.join(RETRIEVAL_GATE_DIR, "set-v1.json");
  const slicePath = path.join(RETRIEVAL_GATE_DIR, "slice-v1.json");
  writeFileSync(setPath, `${JSON.stringify(set, null, 2)}\n`, "utf8");
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, "utf8");
  const schemas = retrievalGateJsonSchemas();
  writeFileSync(
    path.join(RETRIEVAL_GATE_DIR, "set.schema.json"),
    `${JSON.stringify(schemas.set, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(RETRIEVAL_GATE_DIR, "slice.schema.json"),
    `${JSON.stringify(schemas.slice, null, 2)}\n`,
    "utf8",
  );

  // Re-load through the strict loaders so the committed artifacts are proven
  // valid by the same code every consumer runs.
  const loadedSet = loadRetrievalSet(setPath);
  const loadedSlice = loadRetrievalSlice(slicePath);
  checkRetrievalSetAgainstSlice(loadedSet, loadedSlice);

  const poolSections = sliceDocs.reduce(
    (sum, doc) => sum + doc.sections.length,
    0,
  );
  console.log(`corpus revision: ${extraction.revision}`);
  for (const line of composition) console.log(`  ${line}`);
  console.log(
    `\nwrote ${loadedSet.items.length} items across ${goldDocs} gold docs / ${DATASETS.length} jurisdictions`,
  );
  console.log(
    `pool: ${sliceDocs.length} docs, ${poolSections} sections -> ${slicePath}`,
  );
  console.log(`set:  ${setPath} (validated against slice)`);
}

main();
