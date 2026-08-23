import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { groundedProseIntegrityErrors } from "../../backend/src/lib/chat/quoteRepair";
import { tokenizeTextNative } from "../../backend/src/lib/structureNative";

type Source = {
  evidenceId: string;
  text: string;
  labels?: string[];
  kind: "case" | "journal" | "trace";
};

type ReviewedMatch = {
  id: string;
  classification: "true-positive" | "false-rejection";
  copied: string;
  normalizedCharacters: number;
  tokens: number;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const rawDirectory = path.join(here, "raw");
const outputPath = path.join(rawDirectory, "latest.json");
const traceDirectory = path.join(root, "backend/.tmp-live-appserver-traces");
mkdirSync(rawDirectory, { recursive: true });

const result = {
  generatedAt: new Date().toISOString(),
  thresholds: { seedCharacters: 25, lexicalTokens: 8, normalizedCharacters: 40 },
  databases: { a2aj: "unavailable", journal: "unavailable" },
  sources: { case: 0, journal: 0, trace: 0 },
  boundary: {
    positiveSamples: 0,
    positiveDetected: 0,
    sevenTokenControls: 0,
    sevenTokenRejected: 0,
    shortEightTokenControls: 0,
    shortEightTokenRejected: 0,
  },
  beaverOutputs: { traces: 0, submissions: 0, claims: 0, flagged: [] as object[] },
  factualVacuum: {
    sourceWitnessInTraces: false,
    unmarkedSubmittedClaimObserved: false,
    regressionDetected: false,
  },
  boundarySweep: {
    reviewedTruePositives: 0,
    reviewedFalseRejections: 0,
    candidates: [] as object[],
  },
  warnings: [] as string[],
};
const reviewedMatches: ReviewedMatch[] = [];

function checkpoint(label: string) {
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.error(`[copy-gate] ${label}`);
}

function strings(...values: unknown[]) {
  return values.filter((value): value is string => typeof value === "string" && !!value.trim());
}

function paragraphs(text: string) {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/gu)
    .map((value) => value.replace(/^\s{0,3}(?:#{1,6}|>+)\s*/gmu, "").trim())
    .filter((value) => tokenizeTextNative(value).length >= 8);
}

function boundaryWindows(source: Source) {
  for (const paragraph of paragraphs(source.text)) {
    const tokens = tokenizeTextNative(paragraph);
    for (let index = 0; index <= tokens.length - 8; index += 1) {
      const eight = tokens.slice(index, index + 8);
      const text = paragraph.slice(eight[0].start, eight[7].end);
      const normalizedCharacters = eight.map(({ word }) => word).join(" ").length;
      const excluded = /"|\u201c|\u201d|\u00ab|\u00bb|\u2018[^\u2019]+\u2019|\[[^\]]+\]|https?:\/\//u.test(text) ||
        (source.labels ?? []).some((label) => text.toLocaleLowerCase().includes(label.toLocaleLowerCase()));
      if (normalizedCharacters >= 40 && !excluded) {
        return { positive: text, seven: paragraph.slice(eight[0].start, eight[6].end) };
      }
    }
  }
  return null;
}

function shortEightTokenWindow(source: Source) {
  for (const paragraph of paragraphs(source.text)) {
    const tokens = tokenizeTextNative(paragraph);
    for (let index = 0; index <= tokens.length - 8; index += 1) {
      const window = tokens.slice(index, index + 8);
      if (window.map(({ word }) => word).join(" ").length >= 40) continue;
      const text = paragraph.slice(window[0].start, window[7].end);
      if (/"|\u201c|\u201d|\u00ab|\u00bb|\u2018[^\u2019]+\u2019|\[[^\]]+\]|https?:\/\//u.test(text)) continue;
      return text;
    }
  }
  return null;
}

function unmarkedRejected(text: string, sources: Source[]) {
  return groundedProseIntegrityErrors(text, [], sources).some((error) =>
    error.includes("unmarked copied passage"),
  );
}

function evaluateBoundarySweep() {
  const factualVacuum = "Charter decisions should not and must not be made in a factual vacuum.";
  const factualTokens = tokenizeTextNative(factualVacuum);
  const factualCharacters = factualTokens.map(({ word }) => word).join(" ").length;
  const candidates = [
    { lexicalTokens: 8, normalizedCharacters: 40 },
    { lexicalTokens: 8, normalizedCharacters: 50 },
    { lexicalTokens: 8, normalizedCharacters: 51 },
    { lexicalTokens: 9, normalizedCharacters: 50 },
    { lexicalTokens: 9, normalizedCharacters: 51 },
    { lexicalTokens: 10, normalizedCharacters: 40 },
    { lexicalTokens: 10, normalizedCharacters: 51 },
  ];
  result.boundarySweep.reviewedTruePositives = reviewedMatches.filter(({ classification }) =>
    classification === "true-positive").length;
  result.boundarySweep.reviewedFalseRejections = reviewedMatches.filter(({ classification }) =>
    classification === "false-rejection").length;
  result.boundarySweep.candidates = candidates.map((candidate) => {
    const rejected = reviewedMatches.filter(({ tokens, normalizedCharacters }) =>
      tokens >= candidate.lexicalTokens && normalizedCharacters >= candidate.normalizedCharacters);
    return {
      ...candidate,
      factualVacuumDetected:
        factualTokens.length >= candidate.lexicalTokens && factualCharacters >= candidate.normalizedCharacters,
      truePositivesRemaining: rejected.filter(({ classification }) => classification === "true-positive"),
      falseRejections: rejected.filter(({ classification }) => classification === "false-rejection"),
    };
  });
}

function evaluateSources(sources: Source[]) {
  for (const [index, source] of sources.entries()) {
    const windows = boundaryWindows(source);
    if (windows) {
      result.boundary.positiveSamples += 1;
      if (unmarkedRejected(windows.positive, [source])) result.boundary.positiveDetected += 1;
      result.boundary.sevenTokenControls += 1;
      if (unmarkedRejected(windows.seven, [source])) result.boundary.sevenTokenRejected += 1;
    }
    const short = shortEightTokenWindow(source);
    if (short) {
      result.boundary.shortEightTokenControls += 1;
      if (unmarkedRejected(short, [source])) result.boundary.shortEightTokenRejected += 1;
    }
    if ((index + 1) % 25 === 0) checkpoint(`evaluated ${index + 1}/${sources.length} source passages`);
  }
}

function sampleDatabase(
  filename: string,
  query: string,
  kind: Source["kind"],
  prefix: string,
) {
  if (!existsSync(filename)) return [];
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = database.prepare(query).all() as Array<Record<string, unknown>>;
    return rows.flatMap((row, rowIndex) =>
      paragraphs(String(row.text ?? ""))
        .slice(0, 3)
        .map((text, paragraphIndex) => ({
          evidenceId: `${prefix}:${String(row.id ?? rowIndex)}:${paragraphIndex}`,
          text,
          labels: strings(row.name),
          kind,
        })),
    );
  } finally {
    database.close();
  }
}

function localSources() {
  const providers = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
    "OpenLegalProducts/LegalData/providers",
  );
  const a2aj = path.join(providers, "a2aj/a2aj.sqlite");
  let cases: Source[] = [];
  try {
    cases = sampleDatabase(
      a2aj,
      `SELECT id, COALESCE(NULLIF(name_en, ''), name_fr, '') AS name,
              substr(COALESCE(NULLIF(unofficial_text_en, ''), unofficial_text_fr, ''), 1, 50000) AS text
       FROM document WHERE doc_type='cases' ORDER BY id LIMIT 40`,
      "case",
      "case",
    );
    result.databases.a2aj = cases.length ? a2aj : "empty";
  } catch (error) {
    result.warnings.push(`A2AJ sample unavailable: ${String(error)}`);
  }

  let journals: Source[] = [];
  const index = path.join(providers, "journals/public_endpoint-search.sqlite");
  try {
    if (existsSync(index)) {
      const database = new DatabaseSync(index, { readOnly: true });
      const row = database.prepare("SELECT value FROM meta WHERE key='source_path'").get() as
        | { value?: unknown }
        | undefined;
      database.close();
      const source = typeof row?.value === "string" ? row.value : "";
      if (source && existsSync(source)) {
        journals = sampleDatabase(
          source,
          `SELECT article_id AS id, COALESCE(name_en, '') AS name,
                  substr(text, 1, 50000) AS text
           FROM articles WHERE text IS NOT NULL AND length(text) > 200
           ORDER BY article_id LIMIT 40`,
          "journal",
          "journal",
        );
        result.databases.journal = journals.length ? source : "empty";
      } else {
        result.warnings.push(`Journal FTS source database is not present: ${source || "unspecified"}`);
      }
    }
  } catch (error) {
    result.warnings.push(`Journal sample unavailable: ${String(error)}`);
  }
  return { cases, journals };
}

function parseToolText(item: Record<string, any>) {
  const text = item.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
}

function traceEvaluation() {
  if (!existsSync(traceDirectory)) return [];
  const traceSources: Source[] = [];
  for (const filename of readdirSync(traceDirectory).filter((name) => name.endsWith(".json"))) {
    const raw = readFileSync(path.join(traceDirectory, filename), "utf8");
    result.factualVacuum.sourceWitnessInTraces ||= raw.toLocaleLowerCase().includes("factual vacuum");
    let trace: Record<string, any>;
    try {
      trace = JSON.parse(raw);
    } catch {
      result.warnings.push(`Unreadable trace: ${filename}`);
      continue;
    }
    result.beaverOutputs.traces += 1;
    const visible: Source[] = [];
    const completed = new Set<string>();
    for (const entry of trace.entries ?? []) {
      const item = entry?.payload?.item as Record<string, any> | undefined;
      if (!item || item.type !== "mcpToolCall" || item.status !== "completed" || completed.has(item.id)) continue;
      completed.add(item.id);
      const payload = parseToolText(item);
      if (item.tool === "a2aj_fetch" && payload?.ok && typeof payload.text === "string") {
        visible.push({
          evidenceId: String(payload.evidence_id ?? item.id),
          text: payload.text,
          labels: strings(payload.name, payload.citation, payload.alternateCitation),
          kind: "trace",
        });
      }
      if (item.tool === "a2aj_lookup" && payload?.ok && payload.block?.text) {
        visible.push({
          evidenceId: String(payload.evidence_id ?? item.id),
          text: String(payload.block.text),
          labels: strings(payload.name, payload.citation, payload.alternateCitation),
          kind: "trace",
        });
      }
      if (item.tool !== "submit_grounded_answer") continue;
      const claims = Array.isArray(item.arguments?.claims) ? item.arguments.claims : [];
      result.beaverOutputs.submissions += 1;
      for (const [claimIndex, claim] of claims.entries()) {
        if (typeof claim?.text !== "string") continue;
        result.factualVacuum.unmarkedSubmittedClaimObserved ||=
          claim.text.toLocaleLowerCase().includes("factual vacuum");
        result.beaverOutputs.claims += 1;
        const errors = groundedProseIntegrityErrors(
          claim.text,
          Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [],
          visible,
        ).filter((error) => error.includes("unmarked copied passage"));
        if (errors.length) {
          const serialized = /^unmarked copied passage (.+) matches visible evidence/u.exec(errors[0])?.[1];
          const copied = serialized ? JSON.parse(serialized) as string : "";
          const copiedTokens = tokenizeTextNative(copied);
          const classification = /Canadian Charter of Rights and Freedoms|resolutions of the Senate and House of Commons/u
            .test(copied) ? "false-rejection" : "true-positive";
          reviewedMatches.push({
            id: `${filename}:${claimIndex}`,
            classification,
            copied,
            normalizedCharacters: copiedTokens.map(({ word }) => word).join(" ").length,
            tokens: copiedTokens.length,
          });
          result.beaverOutputs.flagged.push({
            trace: filename,
            claimIndex,
            claim: claim.text.slice(0, 500),
            errors,
          });
        }
      }
    }
    traceSources.push(...visible.flatMap((source) =>
      paragraphs(source.text).slice(0, 2).map((text, index) => ({
        ...source,
        evidenceId: `${source.evidenceId}:trace:${index}`,
        text,
      })),
    ));
    if (result.beaverOutputs.traces % 10 === 0) {
      checkpoint(`processed trace ${result.beaverOutputs.traces}`);
    }
  }
  return traceSources;
}

console.error("[copy-gate] loading local provider prose");
const { cases, journals } = localSources();
const traceSources = traceEvaluation();
result.sources.case = cases.length;
result.sources.journal = journals.length;
result.sources.trace = traceSources.length;
checkpoint(`loaded ${cases.length} case, ${journals.length} journal, and ${traceSources.length} trace passages`);

evaluateSources([...cases, ...journals, ...traceSources]);
const factualVacuum = "Charter decisions should not and must not be made in a factual vacuum.";
result.factualVacuum.regressionDetected = unmarkedRejected(factualVacuum, [{
  evidenceId: "factual-vacuum-regression",
  text: factualVacuum,
  kind: "trace",
}]);
evaluateBoundarySweep();
checkpoint("complete");
console.log(JSON.stringify(result, null, 2));
