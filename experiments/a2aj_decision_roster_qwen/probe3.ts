#!/usr/bin/env node

/**
 * Opinion-boundary format probe (deterministic, no model calls).
 *
 * Measures the real heading/paragraph-start vocabulary that delimits
 * majority/minority/concurring/separate opinions and judge names in the
 * local A2AJ case corpus, so the shared opinion-boundary machinery can be
 * built from measurements instead of guesses.
 *
 * Stages (each idempotent, checkpointed to disk, resumable):
 *   1. sample    - deterministic candidate draw -> <seed>-s<size>.candidates.json
 *   2. analyze   - per-doc records appended to <seed>-s<size>.results.jsonl;
 *                  completed document ids are skipped on re-run
 *   3. summarize - aggregates the results JSONL into <seed>-s<size>.json
 *                  (atomic temp+rename write)
 *
 * Run all three by default. Interrupt any time and re-run the same command
 * to continue. Use --stage=sample|analyze|summarize to run one stage, and
 * --max-docs=N to cap how many NEW documents one invocation analyzes.
 *
 * Output streams to the shell as it happens (progress every 100 docs).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentById,
} from "../../backend/src/lib/a2ajLocalBulk";
import { a2ajLegalSourceProvider } from "../../backend/src/lib/legalSources/a2aj";
import { withReadonlySqlite } from "../../backend/src/lib/legalDataPath";
import { documentAnchorsNative, type NativeDocumentBlock } from "../../backend/src/lib/structureNative";

const HERE = __dirname;
const RUN_DIR = path.join(HERE, "runs");

// ---------------------------------------------------------------------------
// Vocabulary under measurement (candidate constants for the shared module)
// ---------------------------------------------------------------------------

const SUFFIX_VOCAB = [
  "C.J.C.",
  "C.J.",
  "J.A.",
  "J.J.A.",
  "J.C.Q.",
  "J.C.S.",
  "J.C.",
  "J.S.C.",
  "J.T.C.J.",
  "J.F.C.",
  "J.J.",
  "J.",
].sort((a, b) => b.length - a.length);

const SUFFIX_RE = new RegExp(
  `\\b([\\p{Lu}][\\p{L}\\p{M}'’\\-]+(?:\\s+[\\p{Lu}][\\p{L}\\p{M}'’\\-]+){0,3})\\s+` +
    `(?:${SUFFIX_VOCAB.map((s) => s.replace(/\./gu, "\\.")).join("|")})\\b`,
  "gu",
);

const ROLE_WORDS = {
  majority: /\bmajority\b/iu,
  minority: /\b(?:minority|dissent(?:ing)?)\b/iu,
  concurring: /\bconcur(?:ring|rence|red)?\b/iu,
  separate: /\bseparate\b/iu,
  additional: /\badditional\b/iu,
  reasons: /\breasons?\b/iu,
  judgment: /\b(?:judg(?:e)?ment|decision|opinion|order|disposition)\b/iu,
} as const;

/** Full-line role heading patterns (standalone heading lines). */
const ROLE_HEADING_LINE_RES: Array<{ name: string; re: RegExp }> = [
  { name: "reasons_for_judgment", re: /\breasons?\s+for\s+(?:judg(?:e)?ment|decision|order)\b/iu },
  { name: "oral_reasons", re: /\boral\s+reasons?\b/iu },
  { name: "statement_of_reasons", re: /\bstatement\s+of\s+reasons?\b/iu },
  { name: "dissenting_reasons", re: /\bdissent(?:ing)?\s+reasons?\b/iu },
  { name: "reasons_for_dissent", re: /\breasons?\s+for\s+dissent\b/iu },
  { name: "dissenting_opinion", re: /\bdissent(?:ing)?\s+opinion\b/iu },
  { name: "minority_reasons", re: /\bminority\s+(?:reasons?|opinion)\b/iu },
  { name: "concurring_reasons", re: /\bconcur(?:ring|rence)?\s+reasons?\b/iu },
  { name: "reasons_concurring", re: /\breasons?\s+(?:concurring|concurrence)\b/iu },
  { name: "concurring_opinion", re: /\bconcur(?:ring|rence)?\s+opinion\b/iu },
  { name: "separate_reasons", re: /\bseparate\s+(?:reasons?|opinion)\b/iu },
  { name: "additional_reasons", re: /\badditional\s+(?:reasons?|opinion)\b/iu },
  { name: "majority_reasons", re: /\bmajority\s+(?:reasons?|opinion)\b/iu },
  { name: "reasons_of_majority", re: /\breasons?\s+of\s+the\s+majority\b/iu },
  { name: "reasons_for_judgment_plain", re: /^(?:reasons?\s*:?|judgment|decision|opinion|order|disposition)\s*:?$/iu },
];

const COURT_LINE_RES: Array<{ name: string; re: RegExp }> = [
  { name: "the_court", re: /^the\s+court\s*:?\s*$/iu },
  { name: "per_curiam", re: /^per\s+curiam\s*:?\s*$/iu },
  { name: "by_the_court", re: /^by\s+the\s+court\s*:?\s*$/iu },
];

const DELIVERED_BY_RE =
  /(?:delivered|rendered|pronounced|given|presented|written|filed)\s+by\b|reasons?\s+of\b|reasons?\s+by\b|judgment\s+of\b/iu;

const PANEL_LINE_RE =
  /^(?:coram|panel|members?\s*:?|judges?\s*:?|justices?\s*:?|president\s*:?|chief\s+justice\s*:?|presiding\s+members?\s*:?|chair(?:man|woman|person)?\s*:?|composition\s*:?)\b/iu;

const FRENCH_WORDS =
  /\b(?:le|la|les|des|du|et|est|pour|une|que|qui|dans|par|aux|ce|cette|plus|sur|au|avec|sont|pas|mais|tout|leur|faire|doit)\b/iu;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Args = Record<string, string | number | boolean | undefined>;

function flag(args: Args, name: string, fallback: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function intFlag(args: Args, name: string, fallback: number) {
  const value = Number(args[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function now() {
  return new Date().toISOString();
}

function isEnglishish(text: string) {
  const sample = text.slice(0, 8_000);
  const words = sample.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? [];
  if (words.length < 40) return true;
  const french = words.filter((word) => FRENCH_WORDS.test(word)).length;
  return french / words.length < 0.08;
}

function compact(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

/** Atomic write: temp file + rename, so an interrupted run never leaves a torn file. */
async function atomicWrite(file: string, content: string) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

type Candidate = {
  documentId: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
};

/**
 * One pass over the corpus metadata (id is the rowid; the WHERE filters read
 * only record headers, so this is a ~30s scan once per seed+size, then the
 * deterministic draw happens in memory). `id` ordering matches the old
 * per-offset `ORDER BY id` sampling exactly, so the candidate list is
 * byte-identical for the same seed and size.
 */
function selectedCandidates(seed: number, size: number): Candidate[] {
  const rows = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const where =
      "doc_type = 'cases' AND unofficial_text_en IS NOT NULL AND length(unofficial_text_en) > 0 AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL";
    return database
      .prepare(
        `SELECT id, dataset,
           COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) AS citation,
           name_en, document_date_en
         FROM document WHERE ${where} ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
  });
  const all = (rows ?? []).map((row) => ({
    documentId: Number(row.id),
    dataset: String(row.dataset ?? ""),
    citation: String(row.citation ?? ""),
    name: row.name_en ? String(row.name_en) : null,
    date: row.document_date_en ? String(row.document_date_en) : null,
  } satisfies Candidate));
  const total = all.length;
  if (!total) throw new Error("no A2AJ cases found");
  const wanted = Math.min(Math.max(1, size), total);
  let state = (seed >>> 0) || 1;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const offsets = new Set<number>();
  while (offsets.size < wanted) offsets.add(Math.floor(next() * total));
  return [...offsets].sort((a, b) => a - b).map((offset) => all[offset]);
}

type FamilySample = { line: string; paragraph?: string };
type DocRecord = {
  kind: "doc";
  document_id: number;
  dataset: string;
  citation: string;
  status: "analyzed" | "skipped_non_english" | "no_spine";
  doc_has_judge: boolean;
  doc_has_role: boolean;
  doc_has_separate: boolean;
  family_hits: Record<string, number>;
  suffix_hits: Record<string, number>;
  samples: Record<string, FamilySample[]>;
};

// ---------------------------------------------------------------------------
// Stage 1: sample
// ---------------------------------------------------------------------------

function candidatesFile(seed: number, size: number) {
  return path.join(RUN_DIR, `opinion-format-probe-${seed}-s${size}.candidates.json`);
}

async function stageSample(args: Args, seed: number, size: number) {
  const candidates = selectedCandidates(seed, size);
  const file = candidatesFile(seed, size);
  await atomicWrite(file, `${JSON.stringify({ seed, sample_size: size, created_utc: now(), candidates }, null, 2)}\n`);
  console.log(`[sample] ${candidates.length} candidates -> ${file}`);
  return candidates;
}

// ---------------------------------------------------------------------------
// Stage 2: analyze
// ---------------------------------------------------------------------------

function resultsFile(seed: number, size: number) {
  return path.join(RUN_DIR, `opinion-format-probe-${seed}-s${size}.results.jsonl`);
}

async function completedIds(file: string): Promise<Set<number>> {
  const ids = new Set<number>();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return ids;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { document_id?: unknown };
      if (typeof record.document_id === "number") ids.add(record.document_id);
    } catch {
      // a torn trailing line from an interrupted run is discarded, never fatal
    }
  }
  return ids;
}

function analyzeDocument(
  text: string,
  paragraphs: NativeDocumentBlock[],
  candidate: Candidate,
): Omit<DocRecord, "status"> {
  const familyHits: Record<string, number> = {};
  const samples: Record<string, FamilySample[]> = {};
  const suffixHits: Record<string, number> = {};
  let docHasJudge = false;
  let docHasRole = false;
  let docHasSeparate = false;

  const note = (name: string, line: string, paragraph?: string) => {
    familyHits[name] = (familyHits[name] ?? 0) + 1;
    const bucket = (samples[name] ??= []);
    if (bucket.length < 2) {
      bucket.push({ line: line.slice(0, 160), ...(paragraph ? { paragraph } : {}) });
    }
  };
  const noteDoc = (name: string) => {
    note(name, "");
  };

  const headerEnd = paragraphs.length ? Math.min(paragraphs[0].start, 12_000) : Math.min(text.length, 12_000);
  const header = text.slice(0, headerEnd);

  const recordSuffixes = (value: string, family: string) => {
    for (const match of value.matchAll(SUFFIX_RE)) {
      const name = compact(match[1]);
      if (!name || name.length > 48) continue;
      const suffix = SUFFIX_VOCAB.find((candidateSuffix) => match[0].endsWith(candidateSuffix));
      suffixHits[suffix ?? match[0].trim()] = (suffixHits[suffix ?? match[0].trim()] ?? 0) + 1;
      note(family, value);
      docHasJudge = true;
    }
  };

  // Header lines: role headings, judge suffixes, court lines, delivered-by, panel rosters.
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 160) continue;
    let matched = false;
    for (const { name, re } of ROLE_HEADING_LINE_RES) {
      if (!re.test(trimmed)) continue;
      matched = true;
      note(`role_heading:${name}`, trimmed);
      docHasRole = true;
      if (name.includes("dissent") || name.includes("minority") || name.includes("concur") || name.includes("separate") || name.includes("additional")) {
        docHasSeparate = true;
      }
      break;
    }
    if (matched) continue;
    for (const { name, re } of COURT_LINE_RES) {
      if (!re.test(trimmed)) continue;
      matched = true;
      note(`court_line:${name}`, trimmed);
      docHasRole = true;
      break;
    }
    if (matched) continue;
    if (DELIVERED_BY_RE.test(trimmed)) {
      matched = true;
      note("delivered_by", trimmed);
      docHasRole = true;
    }
    if (matched) continue;
    if (PANEL_LINE_RE.test(trimmed)) {
      matched = true;
      note("panel_line", trimmed);
      docHasJudge = true;
    }
    if (matched) continue;
    recordSuffixes(trimmed, "judge_heading_line");
  }

  // Paragraph starts: judge markers, court markers, role words after the marker.
  for (const block of paragraphs) {
    const snippet = compact(text.slice(block.start, Math.min(block.end, block.start + 240)));
    const afterMarker = snippet.replace(/^\[?\d{1,4}[.)\]]?\s*/u, "");
    if (!afterMarker) continue;
    const judgeMarker = /^([\p{Lu}][\p{L}\p{M}'’\-]+(?:\s+[\p{Lu}][\p{L}\p{M}'’\-]+){0,3})\s+(?:C\.J\.C?|C\.J\.|J\.A\.|J\.J\.A\.?|J\.C\.Q\.|J\.C\.S\.|J\.C\.|J\.S\.C\.|J\.T\.C\.J\.|J\.F\.C\.|J\.J\.|J\.)[,.]?\s*(?:\([^)]*\))?\s*[:;—-]/u.exec(afterMarker);
    if (judgeMarker) {
      note("para_start_judge", snippet, block.label);
      docHasJudge = true;
      const afterSuffix = afterMarker.slice(judgeMarker[0].length, judgeMarker[0].length + 60);
      if (/\((?:dissenting|concurring|separate|additional|orally)\)/iu.test(afterSuffix)) {
        note("para_start_judge_role_parenthetical", snippet, block.label);
        docHasSeparate = true;
      }
      continue;
    }
    if (/^(?:the\s+court|per\s+curiam|by\s+the\s+court)\s*[:;—-]/iu.test(afterMarker)) {
      note("para_start_court", snippet, block.label);
      continue;
    }
    for (const [roleName, re] of Object.entries(ROLE_WORDS)) {
      if (!re.test(afterMarker.slice(0, 60))) continue;
      note(`para_start_role_word:${roleName}`, snippet, block.label);
      docHasRole = true;
      if (roleName === "minority" || roleName === "concurring" || roleName === "separate" || roleName === "additional") {
        docHasSeparate = true;
      }
      break;
    }
  }

  // Between-paragraph regions: short standalone lines that are not the next marker.
  for (let index = 0; index + 1 < paragraphs.length; index += 1) {
    const between = text.slice(paragraphs[index].end, paragraphs[index + 1].start);
    recordSuffixes(between, "between_judge_line");
    for (const line of between.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 160) continue;
      const headingLike =
        /^\p{Lu}/u.test(trimmed) &&
        trimmed.length <= 100 &&
        !/[.;:!?]$/u.test(trimmed) &&
        !/^\d{1,4}[.)\]]/u.test(trimmed);
      if (!headingLike) continue;
      for (const [roleName, re] of Object.entries(ROLE_WORDS)) {
        if (!re.test(trimmed)) continue;
        note(`between_role_word:${roleName}`, trimmed, paragraphs[index + 1].label);
        docHasRole = true;
        if (roleName === "minority" || roleName === "concurring" || roleName === "separate" || roleName === "additional") {
          docHasSeparate = true;
        }
        break;
      }
    }
  }

  return {
    document_id: candidate.documentId,
    dataset: candidate.dataset,
    citation: candidate.citation,
    doc_has_judge: docHasJudge,
    doc_has_role: docHasRole,
    doc_has_separate: docHasSeparate,
    family_hits: familyHits,
    suffix_hits: suffixHits,
    samples,
  };
}

async function stageAnalyze(args: Args, seed: number, size: number) {
  const candidatesPath = candidatesFile(seed, size);
  let candidates: Candidate[];
  try {
    candidates = (JSON.parse(await readFile(candidatesPath, "utf8")) as { candidates?: Candidate[] }).candidates ?? [];
  } catch {
    console.log(`[analyze] ${candidatesPath} missing; running sample stage first`);
    candidates = await stageSample(args, seed, size);
  }
  const resultsPath = resultsFile(seed, size);
  const done = await completedIds(resultsPath);
  const pending = candidates.filter((candidate) => !done.has(candidate.documentId));
  const maxNew = intFlag(args, "max-docs", Number.POSITIVE_INFINITY);
  const wanted = pending.slice(0, maxNew);
  const concurrency = Math.max(1, intFlag(args, "concurrency", 8));
  console.log(`[analyze] ${done.size} completed, ${wanted.length} to analyze (concurrency ${concurrency})`);

  await mkdir(RUN_DIR, { recursive: true });
  const started = Date.now();
  let analyzed = 0;
  let skippedNonEnglish = 0;
  let noSpine = 0;
  let processed = 0;
  const total = done.size + wanted.length;

  const skippedRecord = (candidate: Candidate, status: "skipped_non_english" | "no_spine"): DocRecord => ({
    kind: "doc",
    document_id: candidate.documentId,
    dataset: candidate.dataset,
    citation: candidate.citation,
    status,
    doc_has_judge: false,
    doc_has_role: false,
    doc_has_separate: false,
    family_hits: {},
    suffix_hits: {},
    samples: {},
  });

  const worker = async () => {
    for (;;) {
      const index = nextIndex();
      if (index >= wanted.length) return;
      const candidate = wanted[index];
      let record: DocRecord | null = null;
      try {
        const document = fetchLocalA2AJDocumentById({
          id: candidate.documentId,
          docType: "cases",
          language: "en",
          maxChars: Number.MAX_SAFE_INTEGER,
        });
        if (document) {
          if (!isEnglishish(document.text)) {
            skippedNonEnglish += 1;
            record = skippedRecord(candidate, "skipped_non_english");
          } else {
            const native = a2ajLegalSourceProvider.source(document);
            const paragraphs = (native ? documentAnchorsNative(native) : [])
              .filter((block) => block.kind === "paragraph");
            if (!paragraphs.length) {
              noSpine += 1;
              record = skippedRecord(candidate, "no_spine");
            } else {
              analyzed += 1;
              record = { ...analyzeDocument(document.text, paragraphs, candidate), kind: "doc", status: "analyzed" };
            }
          }
        }
      } catch (error) {
        console.error(`[analyze] error on ${candidate.citation} (id ${candidate.documentId}): ${error}`);
      }
      if (record) {
        await writeFile(resultsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
      }
      processed += 1;
      if (processed % 100 === 0 || processed === wanted.length) {
        const elapsed = Math.round((Date.now() - started) / 1000);
        const rate = Math.round((processed / Math.max(1, elapsed)) * 10) / 10;
        console.log(`[analyze] ${done.size + processed}/${total} done (${analyzed} analyzed, ${skippedNonEnglish} non-English, ${noSpine} no-spine) ${elapsed}s ${rate}/s`);
      }
    }
  };

  let cursor = 0;
  const nextIndex = () => cursor++;

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`[analyze] finished: ${analyzed} analyzed, ${skippedNonEnglish} non-English, ${noSpine} no-spine -> ${resultsPath}`);
  return resultsPath;
}

// ---------------------------------------------------------------------------
// Stage 3: summarize
// ---------------------------------------------------------------------------

const MAX_SAMPLES = 12;

function familyNames() {
  const names: string[] = [];
  for (const { name } of ROLE_HEADING_LINE_RES) names.push(`role_heading:${name}`);
  for (const { name } of COURT_LINE_RES) names.push(`court_line:${name}`);
  names.push("delivered_by", "panel_line", "judge_heading_line");
  names.push("para_start_judge", "para_start_judge_role_parenthetical", "para_start_court");
  for (const roleName of Object.keys(ROLE_WORDS)) {
    names.push(`para_start_role_word:${roleName}`);
    names.push(`between_role_word:${roleName}`);
  }
  names.push("between_judge_line");
  return names;
}

async function stageSummarize(seed: number, size: number) {
  const resultsPath = resultsFile(seed, size);
  const records: DocRecord[] = [];
  let raw: string;
  try {
    raw = await readFile(resultsPath, "utf8");
  } catch {
    throw new Error(`no results at ${resultsPath}; run analyze first`);
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as DocRecord);
    } catch {
      // torn trailing line from an interrupted run is discarded
    }
  }
  // Parallel analysis appends in nondeterministic order; sort by document id
  // so the summary is byte-identical for the same input records.
  records.sort((left, right) => left.document_id - right.document_id);

  const families: Record<string, { docs: number; hits: number; samples: Array<{ document_id: number; dataset: string; citation: string; line: string; paragraph?: string }> }> = {};
  for (const name of familyNames()) {
    families[name] = { docs: 0, hits: 0, samples: [] };
  }
  const suffixCounts: Record<string, number> = {};
  const docStats = { docsWithJudges: 0, docsWithRoleMarkers: 0, docsWithSeparateMarkers: 0 };
  const datasetStats = new Map<string, { docs: number; separate: number }>();

  for (const record of records) {
    for (const [name, hits] of Object.entries(record.family_hits)) {
      const family = families[name] ?? (families[name] = { docs: 0, hits: 0, samples: [] });
      family.docs += 1;
      family.hits += hits;
      for (const sample of record.samples[name] ?? []) {
        if (family.samples.length >= MAX_SAMPLES) break;
        family.samples.push({
          document_id: record.document_id,
          dataset: record.dataset,
          citation: record.citation,
          line: sample.line,
          ...(sample.paragraph ? { paragraph: sample.paragraph } : {}),
        });
      }
    }
    for (const [suffix, count] of Object.entries(record.suffix_hits)) {
      suffixCounts[suffix] = (suffixCounts[suffix] ?? 0) + count;
    }
    if (record.status !== "analyzed") continue;
    if (record.doc_has_judge) docStats.docsWithJudges += 1;
    if (record.doc_has_role) docStats.docsWithRoleMarkers += 1;
    if (record.doc_has_separate) {
      docStats.docsWithSeparateMarkers += 1;
      const dataset = datasetStats.get(record.dataset) ?? { docs: 0, separate: 0 };
      dataset.separate += 1;
      datasetStats.set(record.dataset, dataset);
    }
    const dataset = datasetStats.get(record.dataset) ?? { docs: 0, separate: 0 };
    dataset.docs += 1;
    datasetStats.set(record.dataset, dataset);
  }

  const analyzed = records.filter((record) => record.status === "analyzed").length;
  const summary = {
    seed,
    sample_size: size,
    records: records.length,
    analyzed,
    skipped_non_english: records.filter((record) => record.status === "skipped_non_english").length,
    without_paragraph_spine: records.filter((record) => record.status === "no_spine").length,
    docs_with_judge_markers: docStats.docsWithJudges,
    docs_with_role_markers: docStats.docsWithRoleMarkers,
    docs_with_separate_opinion_markers: docStats.docsWithSeparateMarkers,
    families,
    judge_suffix_vocabulary: Object.entries(suffixCounts).sort((a, b) => b[1] - a[1]),
    datasets: [...datasetStats.entries()]
      .map(([name, stats]) => ({ dataset: name, ...stats }))
      .sort((a, b) => b.docs - a.docs),
  };

  const output = path.join(RUN_DIR, `opinion-format-probe-${seed}-s${size}.json`);
  await atomicWrite(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[summarize] ${records.length} records -> ${output}`);

  console.log("---- summary ----");
  console.log(
    `analyzed ${analyzed} docs; ${docStats.docsWithJudges} with judge markers, ` +
      `${docStats.docsWithRoleMarkers} with role markers, ` +
      `${docStats.docsWithSeparateMarkers} with separate-opinion markers`,
  );
  const topFamilies = Object.entries(families)
    .map(([name, family]) => ({ name, hits: family.hits, docs: family.docs }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 24);
  for (const entry of topFamilies) {
    console.log(`  ${entry.name}: ${entry.hits} hits in ${entry.docs} docs`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(args: Args) {
  const seed = intFlag(args, "seed", 20260803);
  const size = intFlag(args, "sample-size", 2000);
  const stage = flag(args, "stage", "all");
  await mkdir(RUN_DIR, { recursive: true });
  if (stage === "sample") {
    await stageSample(args, seed, size);
  } else if (stage === "analyze") {
    await stageAnalyze(args, seed, size);
  } else if (stage === "summarize") {
    await stageSummarize(seed, size);
  } else if (stage === "all") {
    await stageAnalyze(args, seed, size);
    await stageSummarize(seed, size);
  } else {
    throw new Error("--stage must be sample|analyze|summarize|all");
  }
}

const args = process.argv.slice(2).reduce((acc, arg) => {
  const match = /^--([\w-]+)=(.*)$/u.exec(arg);
  if (match) acc[match[1]] = match[2];
  return acc;
}, {} as Args);

main(args).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
