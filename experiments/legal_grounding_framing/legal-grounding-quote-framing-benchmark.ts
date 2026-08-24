/**
 * Deterministic benchmark for ungrounded framing around known-real quotations.
 *
 * No model participates in construction, labelling, feature extraction, or
 * scoring. Authentic rows are verbatim judicial/journal prose containing one
 * quotation that the shipped exact-quote tier verifies against the cited
 * decision. Each pair keeps that quote fixed and mutates only its framing.
 *
 *   npx tsx experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --self-test
 *   npx tsx experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --dry-run
 *   npx tsx experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --prepare
 *   npx tsx experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --prepare-natural-holdout
 *   npx tsx experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --score
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { a2ajLocalBulkPath } from "../../backend/src/lib/a2ajLocalBulk";
import {
  standsForProfile,
  type StandsForCandidate,
} from "../../backend/src/lib/caselawCitator";
import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  registerLegalEvidence,
} from "../../backend/experiments/legal-evidence/legalEvidenceExperiment";
import {
  courtlistenerLocalBulkAvailable,
  getLocalCourtlistenerCase,
} from "../../backend/src/lib/courtlistenerLocalBulk";
import { verifyCourtlistenerCitations } from "../../backend/src/lib/legalSources/courtlistener";
import { structureNative } from "../../backend/src/lib/structureNative";

const { citationLookupKey, providerCitationsInText: citationsInText,
  classifyCitatorExcerpt } = structureNative();
import {
  contentWordCount,
  corpusAlienness,
  lintLegalClaim,
} from "./legalClaimLint";
import { legalProviderDatabase } from "../../backend/src/lib/legalDataPath";

const SCHEMA_VERSION = "beaver.quote-framing-benchmark.v1";
const BENCHMARK_ID = "quote-framing-v1";
const NATURAL_HOLDOUT_SCHEMA_VERSION =
  "beaver.natural-quote-framing-holdout.v1";
const NATURAL_HOLDOUT_BENCHMARK_ID = "natural-quote-framing-holdout-v1";
const BOOTSTRAP_ITERATIONS = 2_000;
const TARGET_NEGATIVE_RECALL = 0.95;
const MIN_QUOTE_CHARS = 25;
const MIN_FRAME_CONTENT_WORDS = 12;
const DEFAULT_SEED_LIMIT = 100_000;

type SourceStratum = "ca_judicial" | "ca_journal" | "us_journal";
type Jurisdiction = "CA" | "US";
type MutationFamily =
  | "wrong_frame_swap"
  | "modal_strengthening"
  | "scope_universalization"
  | "polarity_reversal";
type Split = "dev" | "test";
type Condition = "attested" | "mutated";

const STRATUM_GROUPS: Record<SourceStratum, number> = {
  ca_judicial: 128,
  ca_journal: 128,
  us_journal: 0,
};
const MUTATION_FAMILIES: MutationFamily[] = [
  "wrong_frame_swap",
  "modal_strengthening",
  "scope_universalization",
  "polarity_reversal",
];

type Seed = {
  citedKey: string;
  citation: string;
};

type QuoteFrame = {
  quote: string;
  before: string;
  after: string;
  frame: string;
  contentWords: number;
};

type SourceVariant = {
  provider: "a2aj" | "courtlistener" | "cap";
  providerId: string;
  stableSourceId: string;
  citation: string;
  name: string | null;
  date: string | null;
  dataset: string;
  language: "en";
  url: string | null;
  field: string;
  text: string;
  normalizedText: string;
};

type Candidate = {
  candidateId: string;
  stratum: SourceStratum;
  jurisdiction: Jurisdiction;
  cited: {
    provider: "a2aj" | "courtlistener" | "cap";
    providerId: string;
    stableSourceId: string;
    citation: string;
    name: string | null;
    date: string | null;
    dataset: string;
    url: string | null;
    sourceField: string;
    sourceSha256: string;
    normalizedQuoteOffset: number;
  };
  citing: {
    stableSourceId: string;
    sourceKind: "case" | "commentary";
    citation: string | null;
    name: string | null;
    court: string | null;
    journalName: string | null;
    date: string | null;
    paragraph: number | null;
    spanSha256: string;
  };
  quote: string;
  quoteSha256: string;
  before: string;
  after: string;
  frame: string;
  frameSha256: string;
  contentWords: number;
};

type MutationReceipt = {
  family: MutationFamily;
  templateId: string;
  operation: string;
  segment: "before" | "after" | "both";
  from: string | null;
  to: string | null;
  authenticFrameSha256: string;
  mutatedFrameSha256: string;
  donorCandidateId?: string;
  donorCitedSourceId?: string;
  donorCitingSourceId?: string;
  donorLengthRatio?: number;
  targetQuoteDonorQuoteOverlap?: number;
};

type Selection = {
  candidate: Candidate;
  donor: Candidate | null;
  family: MutationFamily;
  split: Split;
};

type OperatorFlags = {
  novelStrongModal: boolean;
  novelAbsoluteScope: boolean;
  changedNegationPolarity: boolean;
};

type FeatureValues = {
  frameContentWords: number;
  frameChars: number;
  novelContentFraction: number;
  operatorRisk: boolean;
  operatorFlags: OperatorFlags;
  aliennessUnattested: number | null;
};

type BenchmarkRow = {
  schemaVersion: typeof SCHEMA_VERSION;
  benchmarkId: typeof BENCHMARK_ID;
  groupId: string;
  rowId: string;
  split: Split;
  condition: Condition;
  label: "supported" | "ungrounded";
  labelProvenance:
    | "judicial_attestation_exact_quote"
    | "journal_attestation_exact_quote"
    | "deterministic_mutation_of_attested_frame";
  labelStatus: "silver_constructed_not_human_gold";
  sourceStratum: SourceStratum;
  jurisdiction: Jurisdiction;
  mutationFamily: MutationFamily;
  cited: Candidate["cited"];
  citing: Candidate["citing"];
  quote: {
    text: string;
    sha256: string;
    exactQuoteVerified: true;
  };
  framing: {
    before: string;
    after: string;
    text: string;
    sha256: string;
    fullClaim: string;
    sourceId: string;
  };
  mutationReceipt: MutationReceipt | null;
  features: FeatureValues;
};

type HarvestStats = {
  seedsConsidered: number;
  profilesMissing: number;
  profilesWithoutQuotedFrame: number;
  citedSourcesMissing: number;
  exactQuoteRejected: number;
  acceptedCandidates: number;
  acceptedUniqueCitedSources: number;
  capResolvedSources: number;
  capMissingVolumes: number;
};

type StandsForAudit = {
  sampled: number;
  profileAvailable: number;
  rich: number;
  thin: number;
  none: number;
  selectedCitingSourceInTop24: number;
  selectedSpanInTop24: number;
  errors: number;
  bySourceStratum: Record<string, {
    sampled: number;
    profileAvailable: number;
    selectedCitingSourceInTop24: number;
    selectedSpanInTop24: number;
  }>;
  purpose: string;
};

type SelectionCache = {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
  selections: Selection[];
  harvest: Record<SourceStratum, HarvestStats>;
};

const STRONG_MODALS = new Set([
  "must",
  "shall",
  "required",
  "requires",
  "mandatory",
]);
const ABSOLUTE_SCOPE = new Set([
  "all",
  "always",
  "every",
  "never",
  "only",
  "solely",
  "exclusively",
  "automatically",
  "invariably",
  "unconditional",
  "unlimited",
  "universal",
  "whenever",
  "regardless",
]);
const NEGATIONS = new Set(["not", "no", "never", "neither", "nor", "without"]);
const MODAL_REPLACEMENTS = new Map<string, string>([
  ["may", "must"],
  ["might", "must"],
  ["can", "must"],
  ["could", "must"],
  ["should", "must"],
  ["would", "must"],
  ["permitted", "required"],
  ["permissible", "mandatory"],
  ["discretionary", "mandatory"],
  ["discretion", "obligation"],
]);
const SCOPE_REPLACEMENTS = new Map<string, string>([
  ["some", "all"],
  ["many", "all"],
  ["often", "always"],
  ["usually", "always"],
  ["sometimes", "always"],
  ["generally", "invariably"],
  ["ordinarily", "always"],
  ["typically", "always"],
  ["primarily", "exclusively"],
  ["largely", "exclusively"],
  ["presumptively", "invariably"],
  ["normally", "always"],
  ["commonly", "always"],
  ["frequently", "always"],
  ["regularly", "always"],
  ["mostly", "exclusively"],
  ["substantially", "exclusively"],
  ["limited", "unlimited"],
  ["conditional", "unconditional"],
  ["particular", "universal"],
  ["specific", "universal"],
]);
const AUXILIARIES = new Set([
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "does",
  "do",
  "did",
  "can",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "should",
  "will",
  "would",
]);

function option(name: string): string | undefined {
  const at = process.argv.indexOf("--" + name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes("--" + name);
}

function localAppData(): string {
  return (
    process.env.LOCALAPPDATA?.trim() ||
    path.join(os.homedir(), "AppData", "Local")
  );
}

function artifactDirectory(): string {
  return path.resolve(
    option("artifact-dir") ||
      path.join(
        localAppData(),
        "OpenLegalData",
        "experiments",
        "legal-grounding",
        BENCHMARK_ID,
      ),
  );
}

function sha256(value: string): string {
  return (
    "sha256:" + createHash("sha256").update(value, "utf8").digest("hex")
  );
}

function stableOrder(value: string): string {
  return createHash("sha256").update(SCHEMA_VERSION + ":" + value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeQuote(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[‘’‚′]/gu, "'")
      .replace(/[“”„″]/gu, '"')
      .replace(/[–—−]/gu, "-")
      .replace(/\u00a0/gu, " ")
      .replace(/…/gu, "..."),
  );
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9']+/gu) || [];
}

function wordSet(value: string): Set<string> {
  return new Set(words(value));
}

function removeDetectedCitations(value: string): string {
  const matches = citationsInText(value);
  if (!matches.length) return normalizeWhitespace(value);
  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += value.slice(cursor, match.start) + " ";
    cursor = match.end;
  }
  return normalizeWhitespace(output + value.slice(cursor));
}

function extractQuoteFrame(text: string): QuoteFrame | null {
  const matches: Array<{ start: number; end: number; body: string }> = [];
  for (const expression of [/"([^"\r\n]+)"/gu, /“([^”\r\n]+)”/gu]) {
    for (const match of text.matchAll(expression)) {
      const body = normalizeWhitespace(match[1]);
      if (normalizeQuote(body).length < MIN_QUOTE_CHARS) continue;
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        body,
      });
    }
  }
  matches.sort((left, right) => left.start - right.start);
  if (matches.length !== 1) return null;
  const match = matches[0];
  const before = removeDetectedCitations(text.slice(0, match.start));
  const after = removeDetectedCitations(text.slice(match.end));
  const frame = normalizeWhitespace([before, after].filter(Boolean).join(" "));
  const count = contentWordCount(frame);
  return count >= MIN_FRAME_CONTENT_WORDS
    ? { quote: match.body, before, after, frame, contentWords: count }
    : null;
}

function overlap(left: string, right: string): number {
  const a = wordSet(left);
  const b = wordSet(right);
  if (!a.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / a.size;
}

function operatorFlags(frame: string, quote: string): OperatorFlags {
  const frameWords = wordSet(frame);
  const quoteWords = wordSet(quote);
  const novelStrongModal = [...STRONG_MODALS].some(
    (token) => frameWords.has(token) && !quoteWords.has(token),
  );
  const novelAbsoluteScope = [...ABSOLUTE_SCOPE].some(
    (token) => frameWords.has(token) && !quoteWords.has(token),
  );
  const negationParity = (value: Set<string>) =>
    [...NEGATIONS].reduce(
      (count, token) => count + (value.has(token) ? 1 : 0),
      0,
    ) % 2;
  return {
    novelStrongModal,
    novelAbsoluteScope,
    changedNegationPolarity:
      negationParity(frameWords) !== negationParity(quoteWords),
  };
}

function features(frame: string, quote: string): FeatureValues {
  const lint = lintLegalClaim({ claim: frame, spans: [quote], language: "en" });
  const residual = lint.receipts.find(
    (receipt) => receipt.feature === "novel_content_fraction",
  );
  if (!residual) throw new Error("lint omitted novel_content_fraction");
  const flags = operatorFlags(frame, quote);
  const alienness = corpusAlienness(frame, { language: "en" });
  return {
    frameContentWords: contentWordCount(frame),
    frameChars: frame.length,
    novelContentFraction: residual.value,
    operatorRisk:
      flags.novelStrongModal ||
      flags.novelAbsoluteScope ||
      flags.changedNegationPolarity,
    operatorFlags: flags,
    aliennessUnattested: alienness?.unattested ?? null,
  };
}

type SegmentMutation = {
  before: string;
  after: string;
  operation: string;
  segment: "before" | "after";
  from: string;
  to: string;
};

function preserveCase(replacement: string, source: string): string {
  if (source.toUpperCase() === source) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replaceMappedToken(
  value: string,
  replacements: Map<string, string>,
): { text: string; from: string; to: string } | null {
  const expression = /\b[a-z]+\b/giu;
  for (const match of value.matchAll(expression)) {
    const from = match[0];
    const replacement = replacements.get(from.toLowerCase());
    if (!replacement) continue;
    const to = preserveCase(replacement, from);
    return {
      text:
        value.slice(0, match.index) +
        to +
        value.slice(match.index + from.length),
      from,
      to,
    };
  }
  return null;
}

function mutateMappedSegments(
  candidate: Candidate,
  replacements: Map<string, string>,
  operation: string,
): SegmentMutation | null {
  for (const segment of ["before", "after"] as const) {
    const changed = replaceMappedToken(candidate[segment], replacements);
    if (!changed) continue;
    return {
      before:
        segment === "before" ? normalizeWhitespace(changed.text) : candidate.before,
      after:
        segment === "after" ? normalizeWhitespace(changed.text) : candidate.after,
      operation,
      segment,
      from: changed.from,
      to: changed.to,
    };
  }
  return null;
}

function mutateModal(candidate: Candidate): SegmentMutation | null {
  const mutation = mutateMappedSegments(
    candidate,
    MODAL_REPLACEMENTS,
    "replace_weak_modal_with_strong_modal",
  );
  if (!mutation) return null;
  const original = operatorFlags(candidate.frame, candidate.quote);
  const changedFrame = normalizeWhitespace(
    [mutation.before, mutation.after].filter(Boolean).join(" "),
  );
  if (contentWordCount(changedFrame) !== candidate.contentWords) return null;
  const changed = operatorFlags(changedFrame, candidate.quote);
  return !original.novelStrongModal && changed.novelStrongModal
    ? mutation
    : null;
}

function mutateScope(candidate: Candidate): SegmentMutation | null {
  const mutation = mutateMappedSegments(
    candidate,
    SCOPE_REPLACEMENTS,
    "replace_bounded_scope_with_absolute_scope",
  );
  if (!mutation) return null;
  const original = operatorFlags(candidate.frame, candidate.quote);
  const changedFrame = normalizeWhitespace(
    [mutation.before, mutation.after].filter(Boolean).join(" "),
  );
  if (contentWordCount(changedFrame) !== candidate.contentWords) return null;
  const changed = operatorFlags(changedFrame, candidate.quote);
  return !original.novelAbsoluteScope && changed.novelAbsoluteScope
    ? mutation
    : null;
}

function removeFirstNot(value: string): { text: string; from: string; to: string } | null {
  const match = /\bnot\b/iu.exec(value);
  if (!match) return null;
  return {
    text: normalizeWhitespace(
      value.slice(0, match.index) + " " + value.slice(match.index + match[0].length),
    ),
    from: match[0],
    to: "",
  };
}

function insertNot(value: string): { text: string; from: string; to: string } | null {
  for (const match of value.matchAll(/\b[a-z]+\b/giu)) {
    if (!AUXILIARIES.has(match[0].toLowerCase())) continue;
    const end = match.index + match[0].length;
    return {
      text: normalizeWhitespace(value.slice(0, end) + " not " + value.slice(end)),
      from: match[0],
      to: match[0] + " not",
    };
  }
  return null;
}

function mutatePolarity(candidate: Candidate): SegmentMutation | null {
  const original = operatorFlags(candidate.frame, candidate.quote);
  if (original.changedNegationPolarity) return null;
  for (const segment of ["before", "after"] as const) {
    const changed =
      removeFirstNot(candidate[segment]) || insertNot(candidate[segment]);
    if (!changed) continue;
    const mutation = {
      before:
        segment === "before" ? changed.text : candidate.before,
      after:
        segment === "after" ? changed.text : candidate.after,
      operation: changed.to
        ? "insert_explicit_negation"
        : "remove_explicit_negation",
      segment,
      from: changed.from,
      to: changed.to,
    };
    const changedFrame = normalizeWhitespace(
      [mutation.before, mutation.after].filter(Boolean).join(" "),
    );
    if (contentWordCount(changedFrame) !== candidate.contentWords) continue;
    if (operatorFlags(changedFrame, candidate.quote).changedNegationPolarity) {
      return mutation;
    }
  }
  return null;
}

function mutationFor(
  candidate: Candidate,
  family: Exclude<MutationFamily, "wrong_frame_swap">,
): SegmentMutation | null {
  if (family === "modal_strengthening") return mutateModal(candidate);
  if (family === "scope_universalization") return mutateScope(candidate);
  return mutatePolarity(candidate);
}

function fullClaim(before: string, quote: string, after: string): string {
  return normalizeWhitespace(
    [before, "“" + quote + "”", after].filter(Boolean).join(" "),
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&([a-z]+);/giu, (whole, name: string) => named[name.toLowerCase()] || whole)
    .replace(/&#(\d+);/gu, (whole, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    })
    .replace(/&#x([0-9a-f]+);/giu, (whole, digits: string) => {
      const code = Number.parseInt(digits, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    });
}

function markupToText(value: string): string {
  return normalizeWhitespace(
    decodeEntities(
      value
        .replace(
          /<\/?(?:article|blockquote|br|div|h[1-6]|li|ol|p|section|table|td|th|tr|ul)\b[^>]*>/giu,
          " ",
        )
        .replace(/<[^>]+>/gu, ""),
    ),
  );
}

type A2ajQuoteResolver = {
  resolve: (citation: string) => SourceVariant | null;
  close: () => void;
};

function rowText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function openA2ajQuoteResolver(): A2ajQuoteResolver {
  const filename = a2ajLocalBulkPath();
  if (!existsSync(filename)) throw new Error("missing local source: " + filename);
  const database = new DatabaseSync(filename, { readOnly: true });
  const lookup = database.prepare(
    [
      "SELECT document.*",
      "FROM citation_lookup AS lookup",
      "JOIN document ON document.id = lookup.document_id",
      "WHERE lookup.citation_key = ? AND document.doc_type = 'cases'",
      "ORDER BY document.id",
      "LIMIT 1",
    ].join(" "),
  );
  return {
    resolve(citation: string): SourceVariant | null {
      const key = citationLookupKey(citation);
      if (!key) return null;
      const row = lookup.get(key) as Record<string, unknown> | undefined;
      if (!row) return null;
      const text = rowText(row, "unofficial_text_en");
      const resolvedCitation =
        rowText(row, "citation_en") || rowText(row, "citation2_en");
      if (!text || !resolvedCitation) return null;
      const dataset = rowText(row, "dataset") || "";
      const providerId =
        dataset + ":" + citationLookupKey(resolvedCitation);
      return {
        provider: "a2aj",
        providerId,
        stableSourceId: "a2aj:" + providerId,
        citation: resolvedCitation,
        name: rowText(row, "name_en"),
        date: rowText(row, "document_date_en"),
        dataset,
        language: "en",
        url: rowText(row, "url_en"),
        field: "unofficial_text_en",
        text,
        normalizedText: normalizeQuote(text),
      };
    },
    close(): void {
      database.close();
    },
  };
}

function clusterIdsFromVerification(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const ids: number[] = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const clusters = (result as { clusters?: unknown }).clusters;
    if (!Array.isArray(clusters)) continue;
    for (const cluster of clusters) {
      if (!cluster || typeof cluster !== "object") continue;
      const id = Number((cluster as { id?: unknown }).id);
      if (Number.isFinite(id) && id > 0) ids.push(Math.trunc(id));
    }
  }
  return [...new Set(ids)];
}

function courtlistenerVariantsFromClusters(
  citation: string,
  clusterIds: number[],
): SourceVariant[] {
  const variants: SourceVariant[] = [];
  for (const clusterId of clusterIds) {
    const legalCase = getLocalCourtlistenerCase(clusterId);
    if (!legalCase) continue;
    const seen = new Set<string>();
    for (const opinion of legalCase.opinions) {
      const fields: Array<[string, string | null, boolean]> = [
        ["plain_text", opinion.plainText, false],
        ["html_with_citations", opinion.htmlWithCitations, true],
        ["html", opinion.html, true],
        ["html_lawbox", opinion.htmlLawbox, true],
        ["html_columbia", opinion.htmlColumbia, true],
        ["html_anon_2020", opinion.htmlAnon2020, true],
        ["xml_harvard", opinion.xmlHarvard, true],
        ["xml_scan", opinion.xmlScan, true],
      ];
      for (const [field, raw, markup] of fields) {
        if (!raw) continue;
        const text = markup ? markupToText(raw) : normalizeWhitespace(raw);
        if (text.length < MIN_QUOTE_CHARS) continue;
        const digest = sha256(text);
        if (seen.has(digest)) continue;
        seen.add(digest);
        variants.push({
          provider: "courtlistener",
          providerId: "cluster:" + clusterId,
          stableSourceId: "courtlistener:cluster:" + clusterId,
          citation: legalCase.citations[0] || citation,
          name:
            legalCase.cluster.caseName ||
            legalCase.cluster.caseNameFull ||
            legalCase.cluster.caseNameShort,
          date: legalCase.cluster.dateFiled,
          dataset: "courtlistener-local-bulk",
          language: "en",
          url: legalCase.cluster.slug
            ? "https://www.courtlistener.com/opinion/" +
              clusterId +
              "/" +
              legalCase.cluster.slug +
              "/"
            : "https://www.courtlistener.com/opinion/" + clusterId + "/",
          field: "opinion:" + opinion.id + ":" + field,
          text,
          normalizedText: normalizeQuote(text),
        });
      }
    }
    if (variants.length) break;
  }
  return variants;
}

async function resolveCourtlistenerGroups(
  groups: DescriptionGroup[],
): Promise<Map<string, number[]>> {
  const resolved = new Map<string, number[]>();
  if (!courtlistenerLocalBulkAvailable()) return resolved;
  const savedToken = process.env.COURTLISTENER_API_TOKEN;
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.COURTLISTENER_API_TOKEN = "";
  process.env.NODE_ENV = "production";
  try {
    for (let start = 0; start < groups.length; start += 250) {
      const chunk = groups.slice(start, start + 250);
      const verified = await verifyCourtlistenerCitations({
        citations: chunk.map((group) => group.citation),
        apiToken: null,
      });
      const results =
        verified && typeof verified === "object" &&
        Array.isArray((verified as { results?: unknown }).results)
          ? ((verified as { results: unknown[] }).results)
          : [];
      results.forEach((result, index) => {
        const ids = clusterIdsFromVerification({ results: [result] });
        if (ids.length && chunk[index]) {
          resolved.set(chunk[index].citedKey, ids);
        }
      });
      process.stderr.write(
        "[quote-framing] courtlistener batch=" +
          (Math.floor(start / 250) + 1) +
          " resolved=" +
          resolved.size +
          "\n",
      );
    }
  } finally {
    if (savedToken === undefined) delete process.env.COURTLISTENER_API_TOKEN;
    else process.env.COURTLISTENER_API_TOKEN = savedToken;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
  return resolved;
}

const CAP_REPORTER_SLUGS: Record<string, string> = {
  us: "us",
  sct: "s-ct",
  f2d: "f2d",
  f3d: "f3d",
  fsupp: "f-supp",
  fsupp2d: "f-supp-2d",
  p2d: "p2d",
  p3d: "p3d",
  ne2d: "ne2d",
  nw2d: "nw2d",
  a2d: "a2d",
  so2d: "so-2d",
  se2d: "se2d",
  sw2d: "sw2d",
  calapp4th: "cal-app-4th",
  nys2d: "ny-s2d",
  illapp3d: "ill-app-3d",
  ohiost3d: "ohio-st-3d",
};

function capReporterSlug(reporter: string): string | null {
  const key = reporter.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return CAP_REPORTER_SLUGS[key] || null;
}

type CapQuoteResolver = {
  resolve: (
    citation: string,
    clusterIds: number[],
  ) => Promise<SourceVariant[]>;
  missingVolumes: Set<string>;
  close: () => void;
};

function openCapQuoteResolver(): CapQuoteResolver {
  const courtlistenerPath = legalProviderDatabase(
    "courtlistener",
    "courtlistener.sqlite",
  );
  const database = new DatabaseSync(courtlistenerPath, { readOnly: true });
  const citations = database.prepare(
    "SELECT volume, reporter, page FROM citation WHERE cluster_id = ? ORDER BY id",
  );
  const zipDirectory = path.join(
    localAppData(),
    "ALR Quote Verifier",
    "alienness",
    "us_reference",
    "zips",
  );
  const zipCache = new Map<string, Promise<JSZip>>();
  const missingVolumes = new Set<string>();
  const loadZip = (filename: string) => {
    let loaded = zipCache.get(filename);
    if (!loaded) {
      loaded = JSZip.loadAsync(readFileSync(filename));
      zipCache.set(filename, loaded);
    }
    return loaded;
  };
  return {
    async resolve(
      citation: string,
      clusterIds: number[],
    ): Promise<SourceVariant[]> {
      const wantedKey = citationLookupKey(citation);
      const variants: SourceVariant[] = [];
      for (const clusterId of clusterIds) {
        const rows = citations.all(clusterId) as Array<Record<string, unknown>>;
        rows.sort((left, right) => {
          const key = (row: Record<string, unknown>) =>
            citationLookupKey(
              [row.volume, row.reporter, row.page].map(String).join(" "),
            );
          return Number(key(right) === wantedKey) - Number(key(left) === wantedKey);
        });
        for (const row of rows) {
          const volume = String(row.volume || "").trim();
          const reporter = String(row.reporter || "").trim();
          const page = String(row.page || "").trim();
          const slug = capReporterSlug(reporter);
          if (!volume || !page || !slug || !/^\d+$/u.test(page)) continue;
          const zipPath = path.join(
            zipDirectory,
            slug + "-" + volume + ".zip",
          );
          if (!existsSync(zipPath)) {
            missingVolumes.add(slug + "/" + volume);
            continue;
          }
          const archive = await loadZip(zipPath);
          const prefix = "json/" + page.padStart(4, "0") + "-";
          const entries = Object.values(archive.files).filter(
            (entry) =>
              !entry.dir &&
              entry.name.startsWith(prefix) &&
              entry.name.endsWith(".json"),
          );
          for (const entry of entries) {
            const parsed = JSON.parse(
              await entry.async("string"),
            ) as Record<string, unknown>;
            const caseCitations = Array.isArray(parsed.citations)
              ? parsed.citations
                  .map((item) =>
                    item && typeof item === "object"
                      ? String((item as { cite?: unknown }).cite || "")
                      : "",
                  )
                  .filter(Boolean)
              : [];
            if (
              caseCitations.length &&
              !caseCitations.some(
                (value) => citationLookupKey(value) === wantedKey,
              )
            ) {
              continue;
            }
            const casebody =
              parsed.casebody && typeof parsed.casebody === "object"
                ? (parsed.casebody as { opinions?: unknown })
                : null;
            const opinions = Array.isArray(casebody?.opinions)
              ? casebody.opinions
              : [];
            const text = opinions
              .map((opinion) =>
                opinion && typeof opinion === "object"
                  ? String((opinion as { text?: unknown }).text || "")
                  : "",
              )
              .filter(Boolean)
              .join("\n");
            if (!text) continue;
            const caseId = Number(parsed.id);
            const court =
              parsed.court && typeof parsed.court === "object"
                ? String((parsed.court as { name?: unknown }).name || "")
                : "";
            variants.push({
              provider: "cap",
              providerId: "case:" + caseId,
              stableSourceId: "cap:case:" + caseId,
              citation: caseCitations[0] || citation,
              name: String(
                parsed.name_abbreviation || parsed.name || "",
              ) || null,
              date: String(parsed.decision_date || "") || null,
              dataset: "cap-static-bulk",
              language: "en",
              url:
                "https://static.case.law/" +
                slug +
                "/" +
                volume +
                "/cases/" +
                path.basename(entry.name, ".json") +
                ".json",
              field: "casebody.opinions[].text:" + court,
              text,
              normalizedText: normalizeQuote(text),
            });
          }
          if (variants.length) return variants;
        }
      }
      return variants;
    },
    missingVolumes,
    close(): void {
      database.close();
    },
  };
}

function citingSourceId(candidate: StandsForCandidate): string {
  const identity = normalizeWhitespace(
    [
      candidate.sourceKind,
      candidate.citingCitation || "",
      candidate.citingName || "",
      candidate.journalName || "",
      candidate.citingDate || "",
    ].join("|"),
  ).toLowerCase();
  return candidate.sourceKind + ":" + sha256(identity || candidate.spanSha256).slice(7);
}

function deterministicQuoteVerified(
  source: SourceVariant,
  quote: string,
  jurisdiction: Jurisdiction,
): boolean {
  const state = createLegalEvidenceTurnState(null);
  const receipt = createBenchmarkEvidence({
    jurisdiction,
    sourceClass: "case",
    stableSourceId: source.stableSourceId,
    sourceText: source.text,
    spanText: source.text,
    citation: source.citation,
    name: source.name,
    dataset: source.dataset,
    language: "en",
    version: source.date,
    externalUrl: source.url,
    locatorLabel: "normalized exact-quote source",
  });
  registerLegalEvidence(state, receipt);
  return deterministicClaimSupport(
    {
      text: "“" + quote + "”",
      evidence_ids: [receipt.evidence_id],
      kind: "quotation",
    },
    state,
  );
}

function materializeCandidate(
  profileCandidate: StandsForCandidate,
  quoteFrame: QuoteFrame,
  source: SourceVariant,
  stratum: SourceStratum,
): Candidate | null {
  const normalizedQuote = normalizeQuote(quoteFrame.quote);
  const offset = source.normalizedText.indexOf(normalizedQuote);
  if (offset < 0) return null;
  const jurisdiction: Jurisdiction = source.provider === "a2aj" ? "CA" : "US";
  if (!deterministicQuoteVerified(source, quoteFrame.quote, jurisdiction)) {
    return null;
  }
  const citingId = citingSourceId(profileCandidate);
  const candidateId = sha256(
    [
      source.stableSourceId,
      citingId,
      profileCandidate.spanSha256,
      normalizedQuote,
    ].join("|"),
  ).slice(7, 31);
  return {
    candidateId,
    stratum,
    jurisdiction,
    cited: {
      provider: source.provider,
      providerId: source.providerId,
      stableSourceId: source.stableSourceId,
      citation: source.citation,
      name: source.name,
      date: source.date,
      dataset: source.dataset,
      url: source.url,
      sourceField: source.field,
      sourceSha256: sha256(source.text),
      normalizedQuoteOffset: offset,
    },
    citing: {
      stableSourceId: citingId,
      sourceKind: profileCandidate.sourceKind,
      citation: profileCandidate.citingCitation,
      name: profileCandidate.citingName,
      court: profileCandidate.citingCourt,
      journalName: profileCandidate.journalName,
      date: profileCandidate.citingDate,
      paragraph: profileCandidate.paragraph,
      spanSha256: "sha256:" + profileCandidate.spanSha256,
    },
    quote: quoteFrame.quote,
    quoteSha256: sha256(normalizedQuote),
    before: quoteFrame.before,
    after: quoteFrame.after,
    frame: quoteFrame.frame,
    frameSha256: sha256(quoteFrame.frame),
    contentWords: quoteFrame.contentWords,
  };
}

function citatorPath(): string {
  return path.resolve(
    process.env.MIKE_CITATOR_DB?.trim() ||
      path.join(localAppData(), "ALR Quote Verifier", "citator", "noteup.sqlite"),
  );
}

function journalCommentaryPath(): string {
  return path.resolve(
    process.env.MIKE_JOURNAL_COMMENTARY_DB?.trim() ||
      path.join(
        localAppData(),
        "ALR Quote Verifier",
        "citator",
        "journal_commentary.sqlite",
      ),
  );
}

type DescriptionGroup = {
  citedKey: string;
  citation: string;
  descriptions: Array<{
    candidate: StandsForCandidate;
    quoteFrame: QuoteFrame;
  }>;
};

function descriptionGroups(
  kind: "case" | "commentary",
  limit: number,
): DescriptionGroup[] {
  const selectionCache = option("cache");
  const cachePath = selectionCache
    ? path.resolve(
        selectionCache +
          "." +
          kind +
          "." +
          limit +
          ".descriptions.json",
      )
    : null;
  if (
    cachePath &&
    existsSync(cachePath) &&
    !hasFlag("refresh-cache")
  ) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      schemaVersion?: string;
      groups?: DescriptionGroup[];
    };
    if (
      cached.schemaVersion === SCHEMA_VERSION &&
      Array.isArray(cached.groups)
    ) {
      return cached.groups;
    }
  }
  const filename =
    kind === "case" ? citatorPath() : journalCommentaryPath();
  if (!existsSync(filename)) throw new Error("missing local source: " + filename);
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const sql =
      kind === "case"
        ? [
            "SELECT edge.cited_key, edge.cited_citation, edge.case_id,",
            "edge.text_offset AS first_offset, edge.paragraph, edge.excerpt,",
            "case_doc.citation AS citing_citation,",
            "case_doc.name AS citing_name, case_doc.court AS citing_court,",
            "case_doc.date AS citing_date",
            "FROM edge",
            "JOIN case_doc ON case_doc.id = edge.case_id",
            "WHERE length(edge.excerpt) >= 40",
            "AND (instr(edge.excerpt, '\"') > 0 OR instr(edge.excerpt, '“') > 0)",
            "LIMIT ?",
          ].join(" ")
        : [
            "SELECT note_citation.cited_key, note_citation.citation AS cited_citation,",
            "note.proposition, article.citation AS citing_citation,",
            "article.name AS citing_name, article.date AS citing_date,",
            "article.journal_name, note.id AS note_id",
            "FROM note_citation",
            "JOIN note ON note.id = note_citation.note_id",
            "JOIN article ON article.article_id = note.article_id",
            "WHERE note_citation.rank = 1",
            "AND note.pair_status = 'paired'",
            "AND note.proposition IS NOT NULL",
            "AND length(note.proposition) >= 40",
            "AND (instr(note.proposition, '\"') > 0 OR instr(note.proposition, '“') > 0)",
            "LIMIT ?",
          ].join(" ");
    const rows = database.prepare(sql).all(limit) as Array<
      Record<string, unknown>
    >;
    const groups = new Map<string, DescriptionGroup>();
    for (const row of rows) {
      const citedKey = String(row.cited_key || "").trim();
      const citation = String(row.cited_citation || "").trim();
      if (!citedKey || !citation) continue;
      const raw =
        kind === "case"
          ? String(row.excerpt || "")
          : String(row.proposition || "");
      const verdict = classifyCitatorExcerpt(raw);
      const text =
        kind === "case"
          ? verdict.kind === "prose" || verdict.kind === "mixed"
            ? verdict.proseWindow
            : null
          : verdict.kind === "prose" || verdict.kind === "mixed"
            ? raw.trim()
            : null;
      if (!text) continue;
      const quoteFrame = extractQuoteFrame(text);
      if (!quoteFrame) continue;
      const candidate: StandsForCandidate = {
        sourceKind: kind,
        journalName:
          kind === "commentary"
            ? (rowText(row, "journal_name") || null)
            : null,
        text,
        excerptKind: verdict.kind,
        citingCitation: rowText(row, "citing_citation"),
        citingName: rowText(row, "citing_name"),
        citingCourt:
          kind === "case" ? rowText(row, "citing_court") : null,
        citingLevel: null,
        citingDate: rowText(row, "citing_date"),
        paragraph:
          kind === "case" && row.paragraph !== null
            ? Number(row.paragraph)
            : null,
        spanSha256: sha256(text).slice(7),
      };
      const group =
        groups.get(citedKey) ||
        { citedKey, citation, descriptions: [] };
      if (group.descriptions.length < 64) {
        group.descriptions.push({ candidate, quoteFrame });
      }
      groups.set(citedKey, group);
    }
    const result = [...groups.values()].sort((left, right) =>
      stableOrder(kind + ":" + left.citedKey).localeCompare(
        stableOrder(kind + ":" + right.citedKey),
      ),
    );
    if (cachePath) {
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind, limit, groups: result }) +
          "\n",
        "utf8",
      );
    }
    return result;
  } finally {
    database.close();
  }
}

function emptyHarvestStats(): HarvestStats {
  return {
    seedsConsidered: 0,
    profilesMissing: 0,
    profilesWithoutQuotedFrame: 0,
    citedSourcesMissing: 0,
    exactQuoteRejected: 0,
    acceptedCandidates: 0,
    acceptedUniqueCitedSources: 0,
    capResolvedSources: 0,
    capMissingVolumes: 0,
  };
}

function progress(
  lane: string,
  stats: HarvestStats,
  pools: Record<SourceStratum, Candidate[]>,
): void {
  const unique = (stratum: SourceStratum) =>
    new Set(pools[stratum].map((candidate) => candidate.cited.stableSourceId))
      .size;
  process.stderr.write(
    [
      "[quote-framing]",
      lane,
      "seeds=" + stats.seedsConsidered,
      "accepted=" + stats.acceptedCandidates,
      "unique_ca_judicial=" + unique("ca_judicial"),
      "unique_ca_journal=" + unique("ca_journal"),
      "unique_us_journal=" + unique("us_journal"),
    ].join(" ") + "\n",
  );
}

function candidatePoolReady(
  pool: Candidate[],
  stratum: SourceStratum,
): boolean {
  if (STRATUM_GROUPS[stratum] === 0) return true;
  const minimum =
    Math.ceil((STRATUM_GROUPS[stratum] + STRATUM_GROUPS[stratum] / 4) * 1.35);
  const unique = new Set(pool.map((candidate) => candidate.cited.stableSourceId));
  if (unique.size < minimum) return false;
  const perFamily = STRATUM_GROUPS[stratum] / MUTATION_FAMILIES.length;
  for (const family of [
    "modal_strengthening",
    "scope_universalization",
    "polarity_reversal",
  ] as const) {
    const eligible = new Set(
      pool
        .filter((candidate) => mutationFor(candidate, family))
        .map((candidate) => candidate.cited.stableSourceId),
    ).size;
    if (eligible < Math.ceil(perFamily * 1.5)) return false;
  }
  return Boolean(
    selectStratum(pool, stratum, new Set<string>(), new Set<string>()),
  );
}

async function harvestCandidates(): Promise<{
  pools: Record<SourceStratum, Candidate[]>;
  stats: Record<SourceStratum, HarvestStats>;
}> {
  const seedLimit = Math.max(
    1,
    Math.trunc(Number(option("seed-limit") || DEFAULT_SEED_LIMIT)),
  );
  const pools: Record<SourceStratum, Candidate[]> = {
    ca_judicial: [],
    ca_journal: [],
    us_journal: [],
  };
  const stats: Record<SourceStratum, HarvestStats> = {
    ca_judicial: emptyHarvestStats(),
    ca_journal: emptyHarvestStats(),
    us_journal: emptyHarvestStats(),
  };
  const seen = new Set<string>();
  const a2aj = openA2ajQuoteResolver();
  const cap =
    STRATUM_GROUPS.us_journal > 0 ? openCapQuoteResolver() : null;

  const addFromGroup = async (
    group: DescriptionGroup,
    wantedKind: "case" | "commentary",
    resolvedVariants?: SourceVariant[],
  ): Promise<void> => {
    const relevantStats =
      wantedKind === "case"
        ? [stats.ca_judicial]
        : STRATUM_GROUPS.us_journal > 0
          ? [stats.ca_journal, stats.us_journal]
          : [stats.ca_journal];
    for (const item of relevantStats) item.seedsConsidered += 1;
    const quoted = group.descriptions.filter(
      (item) => item.candidate.sourceKind === wantedKind,
    );
    if (!quoted.length) {
      for (const item of relevantStats) item.profilesWithoutQuotedFrame += 1;
      return;
    }

    const canadian =
      resolvedVariants === undefined ? a2aj.resolve(group.citation) : null;
    const variants: SourceVariant[] =
      resolvedVariants || (canadian ? [canadian] : []);
    if (!variants.length) {
      for (const item of relevantStats) item.citedSourcesMissing += 1;
      return;
    }
    const sourceStratum: SourceStratum =
      wantedKind === "case"
        ? "ca_judicial"
        : variants[0].provider === "a2aj"
          ? "ca_journal"
          : "us_journal";
    if (wantedKind === "case" && variants[0].provider !== "a2aj") return;
    let accepted = 0;
    for (const item of quoted) {
      const source = variants.find((variant) =>
        variant.normalizedText.includes(normalizeQuote(item.quoteFrame.quote)),
      );
      if (!source) {
        stats[sourceStratum].exactQuoteRejected += 1;
        continue;
      }
      const candidate = materializeCandidate(
        item.candidate,
        item.quoteFrame,
        source,
        sourceStratum,
      );
      if (!candidate) {
        stats[sourceStratum].exactQuoteRejected += 1;
        continue;
      }
      if (seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      pools[sourceStratum].push(candidate);
      stats[sourceStratum].acceptedCandidates += 1;
      accepted += 1;
    }
    if (!accepted && quoted.length) stats[sourceStratum].exactQuoteRejected += 1;
  };

  try {
    const caseStats = stats.ca_judicial;
    for (const group of descriptionGroups("case", seedLimit)) {
      await addFromGroup(group, "case");
      if (caseStats.seedsConsidered % 25 === 0) {
        progress("judicial", caseStats, pools);
      }
      if (
        !hasFlag("harvest-all") &&
        !hasFlag("prepare-natural-holdout") &&
        candidatePoolReady(pools.ca_judicial, "ca_judicial")
      ) {
        break;
      }
    }

    const journalGroups = descriptionGroups("commentary", seedLimit);
    const courtlistenerPending: DescriptionGroup[] = [];
    for (const group of journalGroups) {
      const canadian = a2aj.resolve(group.citation);
      if (canadian) await addFromGroup(group, "commentary", [canadian]);
      else courtlistenerPending.push(group);
    }
    if (STRATUM_GROUPS.us_journal > 0 && cap) {
      const courtlistener = await resolveCourtlistenerGroups(
        courtlistenerPending,
      );
      for (const group of courtlistenerPending) {
        const ids = courtlistener.get(group.citedKey) || [];
        const localVariants = courtlistenerVariantsFromClusters(
          group.citation,
          ids,
        );
        const capVariants = await cap.resolve(group.citation, ids);
        if (capVariants.length) stats.us_journal.capResolvedSources += 1;
        const variants = [...localVariants, ...capVariants];
        await addFromGroup(group, "commentary", variants);
        const considered =
          stats.ca_journal.seedsConsidered + stats.us_journal.seedsConsidered;
        if (considered % 50 === 0) {
          progress("journal", stats.ca_journal, pools);
        }
        if (
          candidatePoolReady(pools.ca_journal, "ca_journal") &&
          candidatePoolReady(pools.us_journal, "us_journal")
        ) {
          break;
        }
      }
    }
  } finally {
    a2aj.close();
    if (cap) {
      stats.us_journal.capMissingVolumes = cap.missingVolumes.size;
      cap.close();
    }
  }
  for (const stratum of Object.keys(pools) as SourceStratum[]) {
    stats[stratum].acceptedUniqueCitedSources = new Set(
      pools[stratum].map((candidate) => candidate.cited.stableSourceId),
    ).size;
  }
  return { pools, stats };
}

function availableCandidate(
  candidate: Candidate,
  usedCited: Set<string>,
  usedCiting: Set<string>,
): boolean {
  return (
    !usedCited.has(candidate.cited.stableSourceId) &&
    !usedCiting.has(candidate.citing.stableSourceId)
  );
}

function markCandidate(
  candidate: Candidate,
  usedCited: Set<string>,
  usedCiting: Set<string>,
): void {
  usedCited.add(candidate.cited.stableSourceId);
  usedCiting.add(candidate.citing.stableSourceId);
}

function selectStratum(
  pool: Candidate[],
  stratum: SourceStratum,
  blockedCited: Set<string>,
  blockedCiting: Set<string>,
): {
  selections: Selection[];
  usedCited: Set<string>;
  usedCiting: Set<string>;
} | null {
  const perFamily = STRATUM_GROUPS[stratum] / MUTATION_FAMILIES.length;
  const usedCited = new Set(blockedCited);
  const usedCiting = new Set(blockedCiting);
  const usedCandidates = new Set<string>();
  const drafts: Array<Omit<Selection, "split">> = [];
  const specialFamilies = [
    "modal_strengthening",
    "scope_universalization",
    "polarity_reversal",
  ] as const;
  const orderedFamilies = [...specialFamilies].sort((left, right) => {
    const eligible = (family: (typeof specialFamilies)[number]) =>
      pool.filter((candidate) => mutationFor(candidate, family)).length;
    return eligible(left) - eligible(right);
  });

  for (const family of orderedFamilies) {
    const candidates = pool
      .filter((candidate) => mutationFor(candidate, family))
      .sort((left, right) =>
        stableOrder(family + ":" + left.candidateId).localeCompare(
          stableOrder(family + ":" + right.candidateId),
        ),
      );
    let selected = 0;
    for (const candidate of candidates) {
      if (selected >= perFamily) break;
      if (usedCandidates.has(candidate.candidateId)) continue;
      if (!availableCandidate(candidate, usedCited, usedCiting)) continue;
      drafts.push({ candidate, donor: null, family });
      usedCandidates.add(candidate.candidateId);
      markCandidate(candidate, usedCited, usedCiting);
      selected += 1;
    }
    if (selected !== perFamily) return null;
  }

  const targets = pool
    .filter(
      (candidate) =>
        !usedCandidates.has(candidate.candidateId) &&
        availableCandidate(candidate, usedCited, usedCiting),
    )
    .sort((left, right) =>
      stableOrder("wrong-target:" + left.candidateId).localeCompare(
        stableOrder("wrong-target:" + right.candidateId),
      ),
    );
  let wrongSelected = 0;
  for (const target of targets) {
    if (wrongSelected >= perFamily) break;
    if (!availableCandidate(target, usedCited, usedCiting)) continue;
    const donors = pool
      .filter((donor) => {
        if (donor.candidateId === target.candidateId) return false;
        if (usedCandidates.has(donor.candidateId)) return false;
        if (!availableCandidate(donor, usedCited, usedCiting)) return false;
        if (donor.cited.stableSourceId === target.cited.stableSourceId) {
          return false;
        }
        if (donor.citing.stableSourceId === target.citing.stableSourceId) {
          return false;
        }
        const ratio = donor.contentWords / target.contentWords;
        return (
          Math.abs(ratio - 1) <= 0.15 &&
          overlap(target.quote, donor.quote) < 0.2
        );
      })
      .sort((left, right) => {
        const leftLength = Math.abs(left.contentWords - target.contentWords);
        const rightLength = Math.abs(right.contentWords - target.contentWords);
        const leftOverlap = overlap(target.quote, left.quote);
        const rightOverlap = overlap(target.quote, right.quote);
        return (
          leftLength - rightLength ||
          leftOverlap - rightOverlap ||
          stableOrder(left.candidateId).localeCompare(
            stableOrder(right.candidateId),
          )
        );
      });
    const donor = donors[0];
    if (!donor) continue;
    drafts.push({
      candidate: target,
      donor,
      family: "wrong_frame_swap",
    });
    usedCandidates.add(target.candidateId);
    usedCandidates.add(donor.candidateId);
    markCandidate(target, usedCited, usedCiting);
    markCandidate(donor, usedCited, usedCiting);
    wrongSelected += 1;
  }
  if (wrongSelected !== perFamily) return null;

  const selections: Selection[] = [];
  for (const family of MUTATION_FAMILIES) {
    const familyDrafts = drafts
      .filter((draft) => draft.family === family)
      .sort((left, right) =>
        stableOrder("split:" + left.candidate.candidateId).localeCompare(
          stableOrder("split:" + right.candidate.candidateId),
        ),
      );
    if (familyDrafts.length !== perFamily || perFamily % 2 !== 0) return null;
    familyDrafts.forEach((draft, index) => {
      selections.push({
        ...draft,
        split: index < perFamily / 2 ? "dev" : "test",
      });
    });
  }
  return { selections, usedCited, usedCiting };
}

function selectAll(
  pools: Record<SourceStratum, Candidate[]>,
): Selection[] {
  let usedCited = new Set<string>();
  let usedCiting = new Set<string>();
  const selections: Selection[] = [];
  for (const stratum of [
    "us_journal",
    "ca_journal",
    "ca_judicial",
  ] as SourceStratum[]) {
    const selected = selectStratum(
      pools[stratum],
      stratum,
      usedCited,
      usedCiting,
    );
    if (!selected) {
      const eligibility = Object.fromEntries(
        [
          "modal_strengthening",
          "scope_universalization",
          "polarity_reversal",
        ].map((family) => [
          family,
          new Set(
            pools[stratum]
              .filter((candidate) =>
                mutationFor(
                  candidate,
                  family as Exclude<MutationFamily, "wrong_frame_swap">,
                ),
              )
              .map((candidate) => candidate.cited.stableSourceId),
          ).size,
        ]),
      );
      process.stderr.write(
        "[quote-framing] assignment underfill " +
          JSON.stringify({
            stratum,
            candidates: pools[stratum].length,
            uniqueCited: new Set(
              pools[stratum].map(
                (candidate) => candidate.cited.stableSourceId,
              ),
            ).size,
            uniqueCiting: new Set(
              pools[stratum].map(
                (candidate) => candidate.citing.stableSourceId,
              ),
            ).size,
            eligibility,
          }) +
          "\n",
      );
      throw new Error(
        "quota underfill for " +
          stratum +
          ": no collision-free mutation/donor assignment",
      );
    }
    selections.push(...selected.selections);
    usedCited = selected.usedCited;
    usedCiting = selected.usedCiting;
  }
  return selections;
}

function mutationReceipt(
  selection: Selection,
): {
  before: string;
  after: string;
  frame: string;
  receipt: MutationReceipt;
  sourceId: string;
} {
  const candidate = selection.candidate;
  if (selection.family === "wrong_frame_swap") {
    const donor = selection.donor;
    if (!donor) throw new Error("wrong-frame selection lacks donor");
    const frame = donor.frame;
    return {
      before: donor.before,
      after: donor.after,
      frame,
      sourceId: donor.citing.stableSourceId,
      receipt: {
        family: selection.family,
        templateId: "same_stratum_quote_slot_swap_v1",
        operation: "replace_authentic_frame_with_other_decision_frame",
        segment: "both",
        from: null,
        to: null,
        authenticFrameSha256: candidate.frameSha256,
        mutatedFrameSha256: sha256(frame),
        donorCandidateId: donor.candidateId,
        donorCitedSourceId: donor.cited.stableSourceId,
        donorCitingSourceId: donor.citing.stableSourceId,
        donorLengthRatio: donor.contentWords / candidate.contentWords,
        targetQuoteDonorQuoteOverlap: overlap(candidate.quote, donor.quote),
      },
    };
  }
  const mutation = mutationFor(candidate, selection.family);
  if (!mutation) {
    throw new Error(
      "selected candidate no longer admits " + selection.family,
    );
  }
  const frame = normalizeWhitespace(
    [mutation.before, mutation.after].filter(Boolean).join(" "),
  );
  if (contentWordCount(frame) !== candidate.contentWords) {
    throw new Error(
      selection.family +
        " changed content-word length for " +
        candidate.candidateId,
    );
  }
  return {
    before: mutation.before,
    after: mutation.after,
    frame,
    sourceId:
      "synthetic:" + candidate.citing.stableSourceId + ":" + selection.family,
    receipt: {
      family: selection.family,
      templateId:
        selection.family === "modal_strengthening"
          ? "weak_to_strong_modal_v1"
          : selection.family === "scope_universalization"
            ? "bounded_to_absolute_scope_v1"
            : "explicit_negation_toggle_v1",
      operation: mutation.operation,
      segment: mutation.segment,
      from: mutation.from,
      to: mutation.to,
      authenticFrameSha256: candidate.frameSha256,
      mutatedFrameSha256: sha256(frame),
    },
  };
}

function makeRow(args: {
  selection: Selection;
  groupId: string;
  condition: Condition;
  before: string;
  after: string;
  frame: string;
  sourceId: string;
  receipt: MutationReceipt | null;
}): BenchmarkRow {
  const candidate = args.selection.candidate;
  return {
    schemaVersion: SCHEMA_VERSION,
    benchmarkId: BENCHMARK_ID,
    groupId: args.groupId,
    rowId: args.groupId + ":" + args.condition,
    split: args.selection.split,
    condition: args.condition,
    label: args.condition === "attested" ? "supported" : "ungrounded",
    labelProvenance:
      args.condition === "mutated"
        ? "deterministic_mutation_of_attested_frame"
        : candidate.stratum === "ca_judicial"
          ? "judicial_attestation_exact_quote"
          : "journal_attestation_exact_quote",
    labelStatus: "silver_constructed_not_human_gold",
    sourceStratum: candidate.stratum,
    jurisdiction: candidate.jurisdiction,
    mutationFamily: args.selection.family,
    cited: candidate.cited,
    citing: candidate.citing,
    quote: {
      text: candidate.quote,
      sha256: candidate.quoteSha256,
      exactQuoteVerified: true,
    },
    framing: {
      before: args.before,
      after: args.after,
      text: args.frame,
      sha256: sha256(args.frame),
      fullClaim: fullClaim(args.before, candidate.quote, args.after),
      sourceId: args.sourceId,
    },
    mutationReceipt: args.receipt,
    features: features(args.frame, candidate.quote),
  };
}

function buildRows(selections: Selection[]): BenchmarkRow[] {
  const rows: BenchmarkRow[] = [];
  const ordered = [...selections].sort((left, right) =>
    [
      left.candidate.stratum.localeCompare(right.candidate.stratum),
      left.family.localeCompare(right.family),
      left.split.localeCompare(right.split),
      left.candidate.candidateId.localeCompare(right.candidate.candidateId),
    ].find((value) => value !== 0) || 0,
  );
  ordered.forEach((selection, index) => {
    const groupId =
      "qf1:" +
      String(index + 1).padStart(3, "0") +
      ":" +
      stableOrder(selection.candidate.candidateId).slice(0, 10);
    rows.push(
      makeRow({
        selection,
        groupId,
        condition: "attested",
        before: selection.candidate.before,
        after: selection.candidate.after,
        frame: selection.candidate.frame,
        sourceId: selection.candidate.citing.stableSourceId,
        receipt: null,
      }),
    );
    const mutated = mutationReceipt(selection);
    rows.push(
      makeRow({
        selection,
        groupId,
        condition: "mutated",
        ...mutated,
      }),
    );
  });
  return rows;
}

function countBy<T extends string>(
  values: T[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function validateSelections(selections: Selection[]): void {
  if (selections.length !== 256) {
    throw new Error("expected 256 groups, got " + selections.length);
  }
  const groupCited = new Set<string>();
  const groupCiting = new Set<string>();
  const allCited = new Set<string>();
  const allCiting = new Set<string>();
  for (const selection of selections) {
    const candidate = selection.candidate;
    if (groupCited.has(candidate.cited.stableSourceId)) {
      throw new Error(
        "repeated cited decision: " + candidate.cited.stableSourceId,
      );
    }
    if (groupCiting.has(candidate.citing.stableSourceId)) {
      throw new Error(
        "repeated citing document: " + candidate.citing.stableSourceId,
      );
    }
    groupCited.add(candidate.cited.stableSourceId);
    groupCiting.add(candidate.citing.stableSourceId);
    for (const item of [candidate, selection.donor].filter(
      (value): value is Candidate => value !== null,
    )) {
      if (allCited.has(item.cited.stableSourceId)) {
        throw new Error(
          "reused cited source including donor: " + item.cited.stableSourceId,
        );
      }
      if (allCiting.has(item.citing.stableSourceId)) {
        throw new Error(
          "reused citing source including donor: " + item.citing.stableSourceId,
        );
      }
      allCited.add(item.cited.stableSourceId);
      allCiting.add(item.citing.stableSourceId);
    }
  }
  for (const stratum of Object.keys(STRATUM_GROUPS) as SourceStratum[]) {
    const stratumRows = selections.filter(
      (selection) => selection.candidate.stratum === stratum,
    );
    if (stratumRows.length !== STRATUM_GROUPS[stratum]) {
      throw new Error(
        "stratum quota mismatch " +
          stratum +
          ": " +
          stratumRows.length,
      );
    }
    const perCell = STRATUM_GROUPS[stratum] / 8;
    for (const family of MUTATION_FAMILIES) {
      for (const split of ["dev", "test"] as Split[]) {
        const count = stratumRows.filter(
          (selection) =>
            selection.family === family && selection.split === split,
        ).length;
        if (count !== perCell) {
          throw new Error(
            [stratum, family, split, "expected", perCell, "got", count].join(
              " ",
            ),
          );
        }
      }
    }
  }
}

function validateRows(rows: BenchmarkRow[]): void {
  if (rows.length !== 512) {
    throw new Error("expected 512 rows, got " + rows.length);
  }
  const groups = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    if (row.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("wrong row schema: " + row.rowId);
    }
    if (!row.quote.exactQuoteVerified) {
      throw new Error("unverified quote: " + row.rowId);
    }
    const values = groups.get(row.groupId) || [];
    values.push(row);
    groups.set(row.groupId, values);
  }
  if (groups.size !== 256) throw new Error("expected 256 paired groups");
  for (const [groupId, pair] of groups) {
    if (
      pair.length !== 2 ||
      pair.filter((row) => row.condition === "attested").length !== 1 ||
      pair.filter((row) => row.condition === "mutated").length !== 1
    ) {
      throw new Error("invalid pair: " + groupId);
    }
    const positive = pair.find((row) => row.condition === "attested") as BenchmarkRow;
    const negative = pair.find((row) => row.condition === "mutated") as BenchmarkRow;
    if (
      positive.quote.sha256 !== negative.quote.sha256 ||
      positive.cited.stableSourceId !== negative.cited.stableSourceId ||
      positive.split !== negative.split
    ) {
      throw new Error("pair identity drift: " + groupId);
    }
    if (
      positive.mutationFamily !== "wrong_frame_swap" &&
      positive.features.frameContentWords !==
        negative.features.frameContentWords
    ) {
      throw new Error("length-control drift: " + groupId);
    }
    if (positive.mutationFamily === "wrong_frame_swap") {
      const ratio =
        negative.features.frameContentWords /
        positive.features.frameContentWords;
      if (Math.abs(ratio - 1) > 0.15 + Number.EPSILON) {
        throw new Error("wrong-frame length drift: " + groupId);
      }
    }
  }
  const splitCounts = countBy(
    [...groups.values()].map((pair) => pair[0].split),
  );
  if (splitCounts.dev !== 128 || splitCounts.test !== 128) {
    throw new Error("split quota mismatch: " + JSON.stringify(splitCounts));
  }
}

function loadSelectionCache(filename: string): SelectionCache {
  const parsed = JSON.parse(readFileSync(filename, "utf8")) as SelectionCache;
  if (
    parsed.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(parsed.selections) ||
    parsed.selections.length !== 256
  ) {
    throw new Error("invalid selection cache: " + filename);
  }
  validateSelections(parsed.selections);
  return parsed;
}

function writeSelectionCache(
  filename: string,
  selections: Selection[],
  harvest: Record<SourceStratum, HarvestStats>,
): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const payload: SelectionCache = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    selections,
    harvest,
  };
  writeFileSync(filename, JSON.stringify(payload) + "\n", "utf8");
}

async function obtainSelections(): Promise<{
  selections: Selection[];
  harvest: Record<SourceStratum, HarvestStats>;
  cachePath: string | null;
  cacheSha256: string | null;
}> {
  const cachePath = option("cache") ? path.resolve(option("cache") as string) : null;
  if (cachePath && existsSync(cachePath) && !hasFlag("refresh-cache")) {
    const cached = loadSelectionCache(cachePath);
    return {
      selections: cached.selections,
      harvest: cached.harvest,
      cachePath,
      cacheSha256: sha256(readFileSync(cachePath, "utf8")),
    };
  }
  const harvested = await harvestCandidates();
  let selections: Selection[];
  try {
    selections = selectAll(harvested.pools);
  } catch (error) {
    process.stderr.write(
      "[quote-framing] fail-closed harvest " +
        JSON.stringify(harvested.stats) +
        "\n",
    );
    throw error;
  }
  validateSelections(selections);
  if (cachePath) {
    writeSelectionCache(cachePath, selections, harvested.stats);
  }
  return {
    selections,
    harvest: harvested.stats,
    cachePath,
    cacheSha256:
      cachePath && existsSync(cachePath)
        ? sha256(readFileSync(cachePath, "utf8"))
        : null,
  };
}

function sqliteMeta(filename: string): Record<string, string> | null {
  if (!existsSync(filename)) return null;
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      )
      .get() as Record<string, unknown> | undefined;
    if (!table) return null;
    return Object.fromEntries(
      (
        database.prepare("SELECT key, value FROM meta").all() as Array<
          Record<string, unknown>
        >
      ).map((row) => [String(row.key), String(row.value)]),
    );
  } finally {
    database.close();
  }
}

function fileReceipt(filename: string): Record<string, unknown> {
  const stats = statSync(filename);
  return {
    path: filename,
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    sqliteMeta: sqliteMeta(filename),
  };
}

function auditStandsForProfiles(selections: Selection[]): StandsForAudit {
  const activeStrata = (Object.keys(STRATUM_GROUPS) as SourceStratum[]).filter(
    (stratum) => STRATUM_GROUPS[stratum] > 0,
  );
  const sample = activeStrata.flatMap((stratum) =>
    selections
      .filter((selection) => selection.candidate.stratum === stratum)
      .sort((left, right) =>
        stableOrder("stands-for-audit:" + left.candidate.candidateId).localeCompare(
          stableOrder("stands-for-audit:" + right.candidate.candidateId),
        ),
      )
      .slice(0, 16),
  );
  const audit: StandsForAudit = {
    sampled: sample.length,
    profileAvailable: 0,
    rich: 0,
    thin: 0,
    none: 0,
    selectedCitingSourceInTop24: 0,
    selectedSpanInTop24: 0,
    errors: 0,
    bySourceStratum: Object.fromEntries(
      activeStrata.map((stratum) => [
        stratum,
        {
          sampled: 0,
          profileAvailable: 0,
          selectedCitingSourceInTop24: 0,
          selectedSpanInTop24: 0,
        },
      ]),
    ),
    purpose:
      "provenance/ranking audit only; top-24 presence does not create or veto labels",
  };
  for (const selection of sample) {
    const candidate = selection.candidate;
    const stratum = audit.bySourceStratum[candidate.stratum];
    stratum.sampled += 1;
    try {
      const profile = standsForProfile({
        citation: candidate.cited.citation,
        size: 24,
        rankPolicy: "flat_recency",
      });
      if (!profile) continue;
      audit.profileAvailable += 1;
      stratum.profileAvailable += 1;
      audit[profile.tier] += 1;
      if (
        profile.candidates.some(
          (item) => citingSourceId(item) === candidate.citing.stableSourceId,
        )
      ) {
        audit.selectedCitingSourceInTop24 += 1;
        stratum.selectedCitingSourceInTop24 += 1;
      }
      if (
        profile.candidates.some(
          (item) => "sha256:" + item.spanSha256 === candidate.citing.spanSha256,
        )
      ) {
        audit.selectedSpanInTop24 += 1;
        stratum.selectedSpanInTop24 += 1;
      }
    } catch {
      audit.errors += 1;
    }
  }
  return audit;
}

async function prepare(dryRun: boolean): Promise<void> {
  const obtained = await obtainSelections();
  validateSelections(obtained.selections);
  process.stderr.write("[quote-framing] computing 512 deterministic feature rows\n");
  const rows = buildRows(obtained.selections);
  validateRows(rows);
  const groups = rows.filter((row) => row.condition === "attested");
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    benchmarkId: BENCHMARK_ID,
    dryRun,
    rows: rows.length,
    groups: groups.length,
    groupSplit: countBy(groups.map((row) => row.split)),
    sourceStrata: countBy(groups.map((row) => row.sourceStratum)),
    mutationFamilies: countBy(groups.map((row) => row.mutationFamily)),
    jurisdictions: countBy(groups.map((row) => row.jurisdiction)),
    harvest: obtained.harvest,
    cachePath: obtained.cachePath,
    cacheSha256: obtained.cacheSha256,
    status: "quota_feasible_and_validated",
  };
  if (dryRun) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  const directory = artifactDirectory();
  mkdirSync(directory, { recursive: true });
  process.stderr.write("[quote-framing] auditing 32 shipped stands-for profiles\n");
  const standsForAudit = auditStandsForProfiles(obtained.selections);
  const rowText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const rowsPath = path.join(directory, "rows.jsonl");
  writeFileSync(rowsPath, rowText, "utf8");
  const sources = [
    citatorPath(),
    journalCommentaryPath(),
    a2ajLocalBulkPath(),
    legalProviderDatabase("courtlistener", "courtlistener.sqlite"),
    path.join(
      localAppData(),
      "ALR Quote Verifier",
      "alienness",
      "trigrams-en.sqlite",
    ),
  ].filter(existsSync);
  const manifest = {
    ...summary,
    dryRun: false,
    createdAt: new Date().toISOString(),
    standsForAudit,
    rowsPath,
    rowsSha256: sha256(rowText),
    protocol: {
      purpose:
        "detect ungrounded framing around a quotation already verified exact",
      noModelCalls: true,
      minimumQuoteCharacters: MIN_QUOTE_CHARS,
      minimumFrameContentWords: MIN_FRAME_CONTENT_WORDS,
      uniqueCitedDecisionPerGroup: true,
      uniqueCitingDocumentPerGroup: true,
      wrongFrameDonor: {
        sameSourceJurisdictionStratum: true,
        differentDecision: true,
        contentWordLengthTolerance: 0.15,
        maximumQuoteOverlap: 0.2,
      },
      quotas: {
        sourceStrata: Object.fromEntries(
          Object.entries(STRATUM_GROUPS).filter((entry) => entry[1] > 0),
        ),
        mutationFamilies: Object.fromEntries(
          MUTATION_FAMILIES.map((family) => [family, 64]),
        ),
        splits: { dev: 128, test: 128 },
      },
      primarySignal: "novel_content_fraction",
      secondarySignal: "fixed_operator_risk",
      targetDevNegativeRecall: TARGET_NEGATIVE_RECALL,
      bootstrapIterations: BOOTSTRAP_ITERATIONS,
      labels:
        "attested/constructed silver; explicitly not human gold",
      feasibilityAmendment: {
        removedCell: "64 US journal groups",
        replacement: "64 additional Canadian journal groups",
        reason:
          "50k-row local preflight produced 0 exact US journal pairs from 132 CourtListener-resolved candidates; cached CAP covered 2 and both failed exact matching",
        missingCapVolumesObserved: 166,
        generalizationClaim: "Canadian legal prose only",
      },
    },
    localSources: sources.map(fileReceipt),
  };
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        artifactDirectory: directory,
        rowsPath,
        rowsSha256: manifest.rowsSha256,
        manifestPath,
        manifestSha256: sha256(readFileSync(manifestPath, "utf8")),
      },
      null,
      2,
    ) + "\n",
  );
}

type HoldoutExclusions = {
  candidateIds: Set<string>;
  citedSourceIds: Set<string>;
  citingSourceIds: Set<string>;
  decisionKeys: Set<string>;
};

function emptyHoldoutExclusions(): HoldoutExclusions {
  return {
    candidateIds: new Set<string>(),
    citedSourceIds: new Set<string>(),
    citingSourceIds: new Set<string>(),
    decisionKeys: new Set<string>(),
  };
}

function addDecisionKey(exclusions: HoldoutExclusions, citation: string | null): void {
  if (!citation) return;
  const key = citationLookupKey(citation);
  if (key) exclusions.decisionKeys.add(key);
}

function addCandidateExclusion(
  exclusions: HoldoutExclusions,
  candidate: Candidate,
): void {
  exclusions.candidateIds.add(candidate.candidateId);
  exclusions.citedSourceIds.add(candidate.cited.stableSourceId);
  exclusions.citingSourceIds.add(candidate.citing.stableSourceId);
  addDecisionKey(exclusions, candidate.cited.citation);
  if (candidate.citing.sourceKind === "case") {
    addDecisionKey(exclusions, candidate.citing.citation);
  }
}

function loadHoldoutExclusions(
  rowsPath: string,
  cachePath: string | null,
): HoldoutExclusions {
  const exclusions = emptyHoldoutExclusions();
  const rows = readFileSync(rowsPath, "utf8")
    .split(/\r?\n/gu)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkRow);
  for (const row of rows) {
    exclusions.citedSourceIds.add(row.cited.stableSourceId);
    exclusions.citingSourceIds.add(row.citing.stableSourceId);
    addDecisionKey(exclusions, row.cited.citation);
    if (row.citing.sourceKind === "case") {
      addDecisionKey(exclusions, row.citing.citation);
    }
    if (row.mutationReceipt?.donorCitedSourceId) {
      exclusions.citedSourceIds.add(row.mutationReceipt.donorCitedSourceId);
    }
    if (row.mutationReceipt?.donorCitingSourceId) {
      exclusions.citingSourceIds.add(row.mutationReceipt.donorCitingSourceId);
    }
  }
  if (cachePath) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as SelectionCache;
    if (!Array.isArray(cache.selections)) {
      throw new Error("invalid exclusion cache: " + cachePath);
    }
    for (const selection of cache.selections) {
      addCandidateExclusion(exclusions, selection.candidate);
      if (selection.donor) addCandidateExclusion(exclusions, selection.donor);
    }
  }
  return exclusions;
}

function decisionKeyForCandidate(candidate: Candidate): string {
  return citationLookupKey(candidate.cited.citation);
}

function citingDecisionKey(candidate: Candidate): string | null {
  if (candidate.citing.sourceKind !== "case" || !candidate.citing.citation) {
    return null;
  }
  return citationLookupKey(candidate.citing.citation) || null;
}

function candidateOutsideHoldoutExclusions(
  candidate: Candidate,
  exclusions: HoldoutExclusions,
): boolean {
  const citedKey = decisionKeyForCandidate(candidate);
  const citingKey = citingDecisionKey(candidate);
  return (
    words(candidate.quote).length >= 10 &&
    !exclusions.candidateIds.has(candidate.candidateId) &&
    !exclusions.citedSourceIds.has(candidate.cited.stableSourceId) &&
    !exclusions.citingSourceIds.has(candidate.citing.stableSourceId) &&
    Boolean(citedKey) &&
    !exclusions.decisionKeys.has(citedKey) &&
    (!citingKey || !exclusions.decisionKeys.has(citingKey)) &&
    citedKey !== citingKey
  );
}

function selectNaturalHoldout(
  pools: Record<SourceStratum, Candidate[]>,
  exclusions: HoldoutExclusions,
  requested: number,
): Candidate[] {
  const strata = ["ca_judicial", "ca_journal"] as const;
  const eligible = Object.fromEntries(
    strata.map((stratum) => [
      stratum,
      pools[stratum]
        .filter((candidate) => candidateOutsideHoldoutExclusions(candidate, exclusions))
        .sort((left, right) =>
          stableOrder("natural-holdout:" + left.candidateId).localeCompare(
            stableOrder("natural-holdout:" + right.candidateId),
          ),
        ),
    ]),
  ) as Record<(typeof strata)[number], Candidate[]>;
  const quota = {
    ca_judicial: Math.floor(requested / 2),
    ca_journal: requested - Math.floor(requested / 2),
  };
  const cursor = { ca_judicial: 0, ca_journal: 0 };
  const selected: Candidate[] = [];
  const selectedByStratum = { ca_judicial: 0, ca_journal: 0 };
  const usedCited = new Set<string>();
  const usedCiting = new Set<string>();
  const usedDecisionKeys = new Set<string>();
  const available = (candidate: Candidate) => {
    const citedKey = decisionKeyForCandidate(candidate);
    const citingKey = citingDecisionKey(candidate);
    return (
      !usedCited.has(candidate.cited.stableSourceId) &&
      !usedCiting.has(candidate.citing.stableSourceId) &&
      !usedDecisionKeys.has(citedKey) &&
      (!citingKey || !usedDecisionKeys.has(citingKey))
    );
  };
  const take = (candidate: Candidate) => {
    selected.push(candidate);
    selectedByStratum[candidate.stratum as "ca_judicial" | "ca_journal"] += 1;
    usedCited.add(candidate.cited.stableSourceId);
    usedCiting.add(candidate.citing.stableSourceId);
    usedDecisionKeys.add(decisionKeyForCandidate(candidate));
    const citingKey = citingDecisionKey(candidate);
    if (citingKey) usedDecisionKeys.add(citingKey);
  };
  for (const stratum of strata) {
    while (
      selectedByStratum[stratum] < quota[stratum] &&
      cursor[stratum] < eligible[stratum].length
    ) {
      const candidate = eligible[stratum][cursor[stratum]];
      cursor[stratum] += 1;
      if (available(candidate)) take(candidate);
    }
  }
  if (selected.length < requested) {
    const remainder = strata
      .flatMap((stratum) => eligible[stratum])
      .filter((candidate) => !selected.includes(candidate))
      .sort((left, right) =>
        stableOrder("natural-holdout-fill:" + left.candidateId).localeCompare(
          stableOrder("natural-holdout-fill:" + right.candidateId),
        ),
      );
    for (const candidate of remainder) {
      if (selected.length >= requested) break;
      if (available(candidate)) take(candidate);
    }
  }
  if (selected.length !== requested) {
    throw new Error(
      "natural holdout underfill: " +
        JSON.stringify({
          requested,
          selected: selected.length,
          eligible: Object.fromEntries(
            strata.map((stratum) => [stratum, eligible[stratum].length]),
          ),
          selectedByStratum,
        }),
    );
  }
  return selected;
}

async function prepareNaturalHoldout(): Promise<void> {
  const excludeRowsPath = path.resolve(option("exclude-rows") || "");
  if (!option("exclude-rows") || !existsSync(excludeRowsPath)) {
    throw new Error("--exclude-rows must name the frozen discovery rows.jsonl");
  }
  const excludeCachePath = option("exclude-cache")
    ? path.resolve(option("exclude-cache") as string)
    : null;
  if (excludeCachePath && !existsSync(excludeCachePath)) {
    throw new Error("missing --exclude-cache: " + excludeCachePath);
  }
  const requested = Math.trunc(Number(option("holdout-groups") || 256));
  if (!Number.isInteger(requested) || requested < 2) {
    throw new Error("--holdout-groups must be an integer >= 2");
  }
  const output = path.resolve(
    option("out") || path.join(artifactDirectory(), "natural-holdout.rows.jsonl"),
  );
  const manifestPath = path.resolve(option("manifest-out") || output + ".manifest.json");
  const exclusions = loadHoldoutExclusions(excludeRowsPath, excludeCachePath);
  const harvested = await harvestCandidates();
  const selected = selectNaturalHoldout(harvested.pools, exclusions, requested)
    .sort((left, right) =>
      stableOrder("natural-holdout-output:" + left.candidateId).localeCompare(
        stableOrder("natural-holdout-output:" + right.candidateId),
      ),
    );
  const rows = selected.map((candidate, index) => {
    const groupId =
      "qfh1:" +
      String(index + 1).padStart(3, "0") +
      ":" +
      stableOrder(candidate.candidateId).slice(0, 10);
    return {
      schemaVersion: NATURAL_HOLDOUT_SCHEMA_VERSION,
      benchmarkId: NATURAL_HOLDOUT_BENCHMARK_ID,
      groupId,
      rowId: groupId + ":attested",
      split: "test" as const,
      condition: "attested" as const,
      label: "supported" as const,
      labelProvenance:
        candidate.citing.sourceKind === "case"
          ? "judicial_attestation_exact_quote"
          : "journal_attestation_exact_quote",
      labelStatus: "silver_attested_not_human_gold",
      sourceStratum: candidate.stratum,
      jurisdiction: candidate.jurisdiction,
      cited: candidate.cited,
      citing: candidate.citing,
      quote: {
        text: candidate.quote,
        sha256: candidate.quoteSha256,
        exactQuoteVerified: true as const,
      },
      framing: {
        before: candidate.before,
        after: candidate.after,
        text: candidate.frame,
        sha256: candidate.frameSha256,
        fullClaim: fullClaim(candidate.before, candidate.quote, candidate.after),
        sourceId: candidate.citing.stableSourceId,
      },
      selectionReceipt: {
        candidateId: candidate.candidateId,
        minimumQuoteWords: 10,
        quoteWords: words(candidate.quote).length,
        selectedWithoutGeneratedClaimOrCheckerVerdict: true,
      },
    };
  });
  const rowText = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(output, rowText, "utf8");
  const manifest = {
    schemaVersion: NATURAL_HOLDOUT_SCHEMA_VERSION,
    benchmarkId: NATURAL_HOLDOUT_BENCHMARK_ID,
    createdAt: new Date().toISOString(),
    rows: rows.length,
    rowsPath: output,
    rowsSha256: sha256(rowText),
    sourceStrata: countBy(rows.map((row) => row.sourceStratum)),
    citingSourceKinds: countBy(rows.map((row) => row.citing.sourceKind)),
    harvest: harvested.stats,
    protocol: {
      split: "test_only_after_discovery_hypotheses_frozen",
      exactQuoteVerified: true,
      minimumQuoteWords: 10,
      uniqueCitedDecision: true,
      uniqueCitingDocument: true,
      decisionGraphDisjointFromDiscovery: true,
      selectionUsesGeneratedClaim: false,
      selectionUsesCheckerVerdict: false,
      characterizationSourceUsedForSelectionOnly: true,
    },
    exclusions: {
      rowsPath: excludeRowsPath,
      rowsSha256: sha256(readFileSync(excludeRowsPath, "utf8")),
      cachePath: excludeCachePath,
      cacheSha256: excludeCachePath
        ? sha256(readFileSync(excludeCachePath, "utf8"))
        : null,
      candidateIds: exclusions.candidateIds.size,
      citedSourceIds: exclusions.citedSourceIds.size,
      citingSourceIds: exclusions.citingSourceIds.size,
      decisionKeys: exclusions.decisionKeys.size,
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        rowsPath: output,
        rowsSha256: manifest.rowsSha256,
        manifestPath,
        rows: rows.length,
        sourceStrata: manifest.sourceStrata,
        harvest: harvested.stats,
      },
      null,
      2,
    ) + "\n",
  );
}

type ScoreDescriptor = {
  name: string;
  score: (row: BenchmarkRow) => number | null;
  thresholdValue: (row: BenchmarkRow) => number | null;
  flagged: (row: BenchmarkRow, threshold: number) => boolean;
  direction: string;
};

type OperatingMetrics = {
  n: number;
  mutated: number;
  supported: number;
  accuracy: number | null;
  falseNegativeRate: number | null;
  negativeRecall: number | null;
  supportedFalseFlagRate: number | null;
  reviewRate: number | null;
  pairedRankingAccuracy: number | null;
  pairedOperationalAccuracy: number | null;
};

function readRows(filename: string): BenchmarkRow[] {
  const rows = readFileSync(filename, "utf8")
    .split(/\r?\n/gu)
    .filter(Boolean)
    .map((line, index) => {
      const row = JSON.parse(line) as BenchmarkRow;
      if (!row.rowId || !row.groupId || !row.framing?.text || !row.quote?.text) {
        throw new Error(
          "invalid benchmark row " + filename + ":" + (index + 1),
        );
      }
      return row;
    });
  validateRows(rows);
  return rows;
}

function auc(
  rows: Array<{ positive: boolean; score: number }>,
): number | null {
  const positives = rows.filter((row) => row.positive).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((left, right) => left.score - right.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let index = 0; index < sorted.length; ) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score) {
      end += 1;
    }
    const meanRank = (rank + rank + end - index - 1) / 2;
    for (let at = index; at < end; at += 1) {
      if (sorted[at].positive) positiveRankSum += meanRank;
    }
    rank += end - index;
    index = end;
  }
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

function averagePrecision(
  rows: Array<{ positive: boolean; score: number }>,
): number | null {
  const positives = rows.filter((row) => row.positive).length;
  if (!positives || positives === rows.length) return null;
  const sorted = [...rows].sort((left, right) => right.score - left.score);
  let truePositives = 0;
  let precisionSum = 0;
  sorted.forEach((row, index) => {
    if (!row.positive) return;
    truePositives += 1;
    precisionSum += truePositives / (index + 1);
  });
  return precisionSum / positives;
}

function scoredRows(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
): Array<{ row: BenchmarkRow; score: number }> {
  return rows
    .map((row) => ({ row, score: descriptor.score(row) }))
    .filter(
      (item): item is { row: BenchmarkRow; score: number } =>
        item.score !== null && Number.isFinite(item.score),
    );
}

function pairedRows(rows: BenchmarkRow[]): BenchmarkRow[][] {
  const groups = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const pair = groups.get(row.groupId) || [];
    pair.push(row);
    groups.set(row.groupId, pair);
  }
  return [...groups.values()].filter(
    (pair) =>
      pair.length === 2 &&
      pair.some((row) => row.condition === "attested") &&
      pair.some((row) => row.condition === "mutated"),
  );
}

function operatingMetrics(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
  threshold: number,
): OperatingMetrics {
  const scored = scoredRows(rows, descriptor);
  const mutated = scored.filter((item) => item.row.condition === "mutated");
  const supported = scored.filter((item) => item.row.condition === "attested");
  const flagged = (row: BenchmarkRow) => descriptor.flagged(row, threshold);
  const falseNegatives = mutated.filter((item) => !flagged(item.row)).length;
  const falseFlags = supported.filter((item) => flagged(item.row)).length;
  const correct = scored.filter((item) =>
    item.row.condition === "mutated" ? flagged(item.row) : !flagged(item.row),
  ).length;
  let ranking = 0;
  let operational = 0;
  let completePairs = 0;
  for (const pair of pairedRows(rows)) {
    const positive = pair.find((row) => row.condition === "attested") as BenchmarkRow;
    const negative = pair.find((row) => row.condition === "mutated") as BenchmarkRow;
    const positiveScore = descriptor.score(positive);
    const negativeScore = descriptor.score(negative);
    if (
      positiveScore === null ||
      negativeScore === null ||
      !Number.isFinite(positiveScore) ||
      !Number.isFinite(negativeScore)
    ) {
      continue;
    }
    completePairs += 1;
    ranking +=
      negativeScore > positiveScore
        ? 1
        : negativeScore === positiveScore
          ? 0.5
          : 0;
    if (!flagged(positive) && flagged(negative)) operational += 1;
  }
  return {
    n: scored.length,
    mutated: mutated.length,
    supported: supported.length,
    accuracy: scored.length ? correct / scored.length : null,
    falseNegativeRate: mutated.length
      ? falseNegatives / mutated.length
      : null,
    negativeRecall: mutated.length
      ? (mutated.length - falseNegatives) / mutated.length
      : null,
    supportedFalseFlagRate: supported.length
      ? falseFlags / supported.length
      : null,
    reviewRate: scored.length
      ? scored.filter((item) => flagged(item.row)).length / scored.length
      : null,
    pairedRankingAccuracy: completePairs ? ranking / completePairs : null,
    pairedOperationalAccuracy: completePairs
      ? operational / completePairs
      : null,
  };
}

function discrimination(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
): {
  n: number;
  coverage: number;
  rocAuc: number | null;
  prAuc: number | null;
} {
  const scored = scoredRows(rows, descriptor);
  const labels = scored.map((item) => ({
    positive: item.row.condition === "mutated",
    score: item.score,
  }));
  return {
    n: scored.length,
    coverage: scored.length / Math.max(1, rows.length),
    rocAuc: auc(labels),
    prAuc: averagePrecision(labels),
  };
}

function fitThreshold(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
): {
  threshold: number;
  metrics: OperatingMetrics;
} {
  const values = rows
    .map(descriptor.thresholdValue)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  if (!values.length) throw new Error("no dev values for " + descriptor.name);
  const unique = [...new Set(values)].sort((left, right) => right - left);
  const epsilon = 1e-9;
  const candidates = [
    unique[0] + epsilon,
    ...unique,
    unique[unique.length - 1] - epsilon,
  ];
  const eligible = candidates
    .map((threshold) => ({
      threshold,
      metrics: operatingMetrics(rows, descriptor, threshold),
    }))
    .filter(
      (item) =>
        (item.metrics.negativeRecall ?? 0) >= TARGET_NEGATIVE_RECALL,
    )
    .sort((left, right) => {
      const falseFlag =
        (left.metrics.supportedFalseFlagRate ?? 1) -
        (right.metrics.supportedFalseFlagRate ?? 1);
      const review = (left.metrics.reviewRate ?? 1) - (right.metrics.reviewRate ?? 1);
      return falseFlag || review || right.threshold - left.threshold;
    });
  if (!eligible.length) {
    throw new Error(
      descriptor.name + " cannot reach the dev negative-recall target",
    );
  }
  return eligible[0];
}

function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.max(0, Math.min(sorted.length - 1, Math.floor(fraction * sorted.length)))
  ];
}

function bootstrap(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
  threshold: number,
): Record<string, { low: number | null; high: number | null }> {
  const pairs = pairedRows(rows);
  if (pairs.length < 2) {
    return Object.fromEntries(
      ["rocAuc", "falseNegativeRate", "supportedFalseFlagRate", "pairedOperationalAccuracy"].map(
        (name) => [name, { low: null, high: null }],
      ),
    );
  }
  let state = 0x6d2b79f5;
  const random = () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x9e3779b9) >>> 0;
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  const values: Record<string, number[]> = {
    rocAuc: [],
    falseNegativeRate: [],
    supportedFalseFlagRate: [],
    pairedOperationalAccuracy: [],
  };
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
    const sampled = pairs.flatMap((_, sampleIndex) =>
      pairs[Math.floor(random() * pairs.length)].map((row) => ({
        ...row,
        groupId: row.groupId + ":bootstrap:" + sampleIndex,
      })),
    );
    const area = discrimination(sampled, descriptor).rocAuc;
    const operating = operatingMetrics(sampled, descriptor, threshold);
    if (area !== null) values.rocAuc.push(area);
    if (operating.falseNegativeRate !== null) {
      values.falseNegativeRate.push(operating.falseNegativeRate);
    }
    if (operating.supportedFalseFlagRate !== null) {
      values.supportedFalseFlagRate.push(operating.supportedFalseFlagRate);
    }
    if (operating.pairedOperationalAccuracy !== null) {
      values.pairedOperationalAccuracy.push(
        operating.pairedOperationalAccuracy,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, samples]) => [
      name,
      {
        low: quantile(samples, 0.025),
        high: quantile(samples, 0.975),
      },
    ]),
  );
}

function sliceReport(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
  threshold: number,
): Record<string, unknown> {
  return {
    ...discrimination(rows, descriptor),
    operating: operatingMetrics(rows, descriptor, threshold),
  };
}

function reportArm(
  rows: BenchmarkRow[],
  descriptor: ScoreDescriptor,
): Record<string, unknown> {
  const dev = rows.filter((row) => row.split === "dev");
  const test = rows.filter((row) => row.split === "test");
  const fitted = fitThreshold(dev, descriptor);
  const by = (
    values: string[],
    selector: (row: BenchmarkRow) => string,
  ) =>
    Object.fromEntries(
      values.map((value) => [
        value,
        sliceReport(
          test.filter((row) => selector(row) === value),
          descriptor,
          fitted.threshold,
        ),
      ]),
    );
  return {
    direction: descriptor.direction,
    threshold: fitted.threshold,
    thresholdFit: {
      split: "dev",
      targetNegativeRecall: TARGET_NEGATIVE_RECALL,
      discrimination: discrimination(dev, descriptor),
      operating: fitted.metrics,
    },
    heldOut: {
      split: "test",
      ...sliceReport(test, descriptor, fitted.threshold),
      bootstrapGroup95: bootstrap(test, descriptor, fitted.threshold),
      byMutation: by(
        MUTATION_FAMILIES,
        (row) => row.mutationFamily,
      ),
      bySourceStratum: by(
        Object.keys(STRATUM_GROUPS),
        (row) => row.sourceStratum,
      ),
      byJurisdiction: by(["CA", "US"], (row) => row.jurisdiction),
    },
  };
}

function heldOutField(
  report: Record<string, unknown>,
  field: string,
): number | null {
  const heldOut = report.heldOut as Record<string, unknown>;
  const value = heldOut[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function heldOutOperating(
  report: Record<string, unknown>,
): OperatingMetrics {
  return ((report.heldOut as Record<string, unknown>)
    .operating || {}) as OperatingMetrics;
}

function thresholdFromReport(report: Record<string, unknown>): number {
  const value = report.threshold;
  if (typeof value !== "number") throw new Error("report threshold missing");
  return value;
}

function operatorAblation(
  rows: BenchmarkRow[],
  residualThreshold: number,
): Record<string, unknown> {
  const test = rows.filter((row) => row.split === "test");
  const baseFlag = (row: BenchmarkRow) =>
    row.features.novelContentFraction >= residualThreshold;
  const augmentedFlag = (row: BenchmarkRow) =>
    baseFlag(row) || row.features.operatorRisk;
  const rate = (
    selected: BenchmarkRow[],
    predicate: (row: BenchmarkRow) => boolean,
  ) => {
    const negatives = selected.filter((row) => row.condition === "mutated");
    const positives = selected.filter((row) => row.condition === "attested");
    return {
      recall: negatives.length
        ? negatives.filter(predicate).length / negatives.length
        : null,
      supportedFalseFlagRate: positives.length
        ? positives.filter(predicate).length / positives.length
        : null,
    };
  };
  const targetFamilies = [
    "modal_strengthening",
    "scope_universalization",
    "polarity_reversal",
  ] as MutationFamily[];
  const selected = test.filter((row) =>
    targetFamilies.includes(row.mutationFamily),
  );
  const base = rate(selected, baseFlag);
  const augmented = rate(selected, augmentedFlag);
  const allSupported = test.filter((row) => row.condition === "attested");
  const baseAllFalseFlag =
    allSupported.filter(baseFlag).length / allSupported.length;
  const augmentedAllFalseFlag =
    allSupported.filter(augmentedFlag).length / allSupported.length;
  return {
    threshold: residualThreshold,
    families: targetFamilies,
    base,
    augmented,
    recallImprovement:
      base.recall === null || augmented.recall === null
        ? null
        : augmented.recall - base.recall,
    allSupportedFalseFlagIncrease:
      augmentedAllFalseFlag - baseAllFalseFlag,
    byFamily: Object.fromEntries(
      targetFamilies.map((family) => {
        const familyRows = selected.filter(
          (row) => row.mutationFamily === family,
        );
        const familyBase = rate(familyRows, baseFlag);
        const familyAugmented = rate(familyRows, augmentedFlag);
        return [
          family,
          {
            base: familyBase,
            augmented: familyAugmented,
            recallImprovement:
              familyBase.recall === null || familyAugmented.recall === null
                ? null
                : familyAugmented.recall - familyBase.recall,
          },
        ];
      }),
    ),
  };
}

function verifyStoredFeatures(rows: BenchmarkRow[]): void {
  const tolerance = 1e-12;
  for (const row of rows) {
    const lint = lintLegalClaim({
      claim: row.framing.text,
      spans: [row.quote.text],
      language: "en",
    });
    const residual = lint.receipts.find(
      (receipt) => receipt.feature === "novel_content_fraction",
    );
    const flags = operatorFlags(row.framing.text, row.quote.text);
    const operatorRisk =
      flags.novelStrongModal ||
      flags.novelAbsoluteScope ||
      flags.changedNegationPolarity;
    if (
      !residual ||
      Math.abs(residual.value - row.features.novelContentFraction) > tolerance ||
      contentWordCount(row.framing.text) !== row.features.frameContentWords ||
      operatorRisk !== row.features.operatorRisk ||
      JSON.stringify(flags) !== JSON.stringify(row.features.operatorFlags)
    ) {
      throw new Error("stored deterministic features drifted: " + row.rowId);
    }
  }
}

function simpleDescriptor(args: {
  name: string;
  value: (row: BenchmarkRow) => number | null;
  direction: string;
}): ScoreDescriptor {
  return {
    name: args.name,
    score: args.value,
    thresholdValue: args.value,
    flagged: (row, threshold) => {
      const value = args.value(row);
      return value !== null && value >= threshold;
    },
    direction: args.direction,
  };
}

function mutationOperating(
  report: Record<string, unknown>,
  family: MutationFamily,
): OperatingMetrics {
  const heldOut = report.heldOut as Record<string, unknown>;
  const byMutation = heldOut.byMutation as Record<
    string,
    Record<string, unknown>
  >;
  return byMutation[family].operating as OperatingMetrics;
}

function scoreBenchmark(filename: string): void {
  const rows = readRows(filename);
  verifyStoredFeatures(rows);
  const dev = rows.filter((row) => row.split === "dev");
  const rawLengthAuc = auc(
    dev.map((row) => ({
      positive: row.condition === "mutated",
      score: row.features.frameContentWords,
    })),
  );
  const lengthDirection = rawLengthAuc !== null && rawLengthAuc < 0.5 ? -1 : 1;
  const length = simpleDescriptor({
    name: "length_only",
    value: (row) => lengthDirection * row.features.frameContentWords,
    direction:
      lengthDirection === 1
        ? "more unique content words means higher risk"
        : "fewer unique content words means higher risk; direction fit on dev",
  });
  const alienness = simpleDescriptor({
    name: "alienness",
    value: (row) => row.features.aliennessUnattested,
    direction: "higher corpus-unattested trigram share means higher risk",
  });
  const residual = simpleDescriptor({
    name: "residual",
    value: (row) => row.features.novelContentFraction,
    direction: "higher novel content fraction means higher risk",
  });
  const residualOrOperator: ScoreDescriptor = {
    name: "residual_or_operator",
    score: (row) =>
      row.features.operatorRisk
        ? 1 + row.features.novelContentFraction / 1_000_000
        : row.features.novelContentFraction,
    thresholdValue: (row) => row.features.novelContentFraction,
    flagged: (row, threshold) =>
      row.features.operatorRisk ||
      row.features.novelContentFraction >= threshold,
    direction:
      "operator risk first, otherwise higher novel content fraction",
  };
  const descriptors = {
    length_only: length,
    alienness,
    residual,
    residual_or_operator: residualOrOperator,
  };
  const arms = Object.fromEntries(
    Object.entries(descriptors).map(([name, descriptor]) => [
      name,
      reportArm(rows, descriptor),
    ]),
  ) as Record<string, Record<string, unknown>>;

  const residualAuc = heldOutField(arms.residual, "rocAuc");
  const lengthAuc = heldOutField(arms.length_only, "rocAuc");
  const aliennessAuc = heldOutField(arms.alienness, "rocAuc");
  const compositeOperating = heldOutOperating(arms.residual_or_operator);
  const residualThreshold = thresholdFromReport(arms.residual);
  const ablation = operatorAblation(rows, residualThreshold);
  const recallImprovement = ablation.recallImprovement;
  const falseFlagIncrease = ablation.allSupportedFalseFlagIncrease;
  const mutationFalseNegativeRates = Object.fromEntries(
    MUTATION_FAMILIES.map((family) => [
      family,
      mutationOperating(arms.residual_or_operator, family).falseNegativeRate,
    ]),
  ) as Record<MutationFamily, number | null>;

  const gates = {
    residualHeldOutAucAtLeast075:
      residualAuc !== null && residualAuc >= 0.75,
    residualBeatsLengthBy010:
      residualAuc !== null &&
      lengthAuc !== null &&
      residualAuc - lengthAuc >= 0.1,
    compositeFalseNegativeRateAtMost010:
      compositeOperating.falseNegativeRate !== null &&
      compositeOperating.falseNegativeRate <= 0.1,
    compositeSupportedFalseFlagRateAtMost050:
      compositeOperating.supportedFalseFlagRate !== null &&
      compositeOperating.supportedFalseFlagRate <= 0.5,
    everyMutationFalseNegativeRateAtMost020: MUTATION_FAMILIES.every(
      (family) =>
        mutationFalseNegativeRates[family] !== null &&
        (mutationFalseNegativeRates[family] as number) <= 0.2,
    ),
    operatorImprovesTargetRecallBy015:
      typeof recallImprovement === "number" && recallImprovement >= 0.15,
    operatorAddsAtMost010SupportedFalseFlags:
      typeof falseFlagIncrease === "number" && falseFlagIncrease <= 0.1,
  };
  const pass = Object.values(gates).every(Boolean);
  const retainAlienness =
    aliennessAuc !== null &&
    residualAuc !== null &&
    aliennessAuc - residualAuc >= 0.02;
  const verdict = pass ? "pass" : "fail";
  const compositeFalseNegativeRate = compositeOperating.falseNegativeRate;
  const compositeFalseFlagRate = compositeOperating.supportedFalseFlagRate;
  const productRecommendation = pass
    ? "For already-exact quotations, route human review when the frozen residual threshold fires or a directional operator changes. Keep exact-quote verification separate. Length remains a measured standalone fallback."
    : "Do not use alienness or residual novelty as universal framing gates. Retain frame length as a cheap routing feature and calibrate it on natural inference traffic because this paired benchmark intentionally controls length. The residual/operator composite missed " +
      (compositeFalseNegativeRate === null
        ? "an unavailable share"
        : (compositeFalseNegativeRate * 100).toFixed(1) + "%") +
      " of constructed errors but flagged " +
      (compositeFalseFlagRate === null
        ? "an unavailable share"
        : (compositeFalseFlagRate * 100).toFixed(1) + "%") +
      " of supported controls, so keep explicit operator changes only as a targeted high-recall review trigger, not Beaver's default detector.";

  const directory = artifactDirectory();
  const output = option("out")
    ? path.resolve(option("out") as string)
    : path.join(directory, "score.json");
  mkdirSync(path.dirname(output), { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const report = {
    schemaVersion: SCHEMA_VERSION,
    benchmarkId: BENCHMARK_ID,
    scoredAt: new Date().toISOString(),
    input: filename,
    inputSha256: sha256(readFileSync(filename, "utf8")),
    manifestSha256: existsSync(manifestPath)
      ? sha256(readFileSync(manifestPath, "utf8"))
      : null,
    rows: rows.length,
    groups: 256,
    thresholdPolicy: {
      split: "dev",
      objective: "lowest supported false-flag rate at >=95% negative recall",
      falseNegativesWeightedAsWorse: true,
    },
    arms,
    operatorAblationAtFrozenResidualThreshold: ablation,
    passGates: {
      ...gates,
      mutationFalseNegativeRates,
    },
    aliennessDecision: {
      heldOutAuc: aliennessAuc,
      residualHeldOutAuc: residualAuc,
      minimumIncrement: 0.02,
      retain: retainAlienness,
    },
    lengthDecision: {
      heldOutAuc: lengthAuc,
      deliberatelyControlledByProtocol: true,
      conclusion:
        "This benchmark estimates incremental signal after length control; it does not estimate length's value on natural inference traffic.",
    },
    verdict,
    productRecommendation,
    labelStatus: "silver_constructed_not_human_gold",
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(output, text, "utf8");
  const digest = sha256(text);
  writeFileSync(output + ".sha256", digest + "  " + path.basename(output) + "\n");
  process.stdout.write(
    JSON.stringify(
      {
        output,
        outputSha256: digest,
        verdict,
        gates: report.passGates,
        aliennessDecision: report.aliennessDecision,
        productRecommendation,
      },
      null,
      2,
    ) + "\n",
  );
}

function selfTest(): void {
  const sentence =
    'The reviewing court may generally describe this limited procedural result for future applications and carefully tie it to the factual record: "The tribunal may grant relief when the statutory conditions are met." Its explanation remained confined to that setting.';
  const extracted = extractQuoteFrame(sentence);
  if (!extracted || extracted.contentWords < MIN_FRAME_CONTENT_WORDS) {
    throw new Error("quote/frame extraction self-test failed");
  }
  const sourceText =
    "Reasons for judgment. The tribunal may grant relief when the statutory conditions are met. End.";
  const source: SourceVariant = {
    provider: "a2aj",
    providerId: "self-test",
    stableSourceId: "a2aj:self-test",
    citation: "2026 TEST 1",
    name: "Self Test",
    date: "2026-01-01",
    dataset: "self-test",
    language: "en",
    url: null,
    field: "text",
    text: sourceText,
    normalizedText: normalizeQuote(sourceText),
  };
  if (!deterministicQuoteVerified(source, extracted.quote, "CA")) {
    throw new Error("exact-quote verification self-test failed");
  }
  const candidate: Candidate = {
    candidateId: "self-test",
    stratum: "ca_judicial",
    jurisdiction: "CA",
    cited: {
      provider: "a2aj",
      providerId: "self-test",
      stableSourceId: "a2aj:self-test",
      citation: "2026 TEST 1",
      name: "Self Test",
      date: "2026-01-01",
      dataset: "self-test",
      url: null,
      sourceField: "text",
      sourceSha256: sha256(sourceText),
      normalizedQuoteOffset: source.normalizedText.indexOf(
        normalizeQuote(extracted.quote),
      ),
    },
    citing: {
      stableSourceId: "case:self-test",
      sourceKind: "case",
      citation: "2026 TEST 2",
      name: "Citing Self Test",
      court: "TEST",
      journalName: null,
      date: "2026-01-02",
      paragraph: 1,
      spanSha256: sha256(sentence),
    },
    quote: extracted.quote,
    quoteSha256: sha256(normalizeQuote(extracted.quote)),
    before: extracted.before,
    after: extracted.after,
    frame: extracted.frame,
    frameSha256: sha256(extracted.frame),
    contentWords: extracted.contentWords,
  };
  const mutations = [
    mutateModal(candidate),
    mutateScope(candidate),
    mutatePolarity(candidate),
  ];
  if (mutations.some((mutation) => !mutation)) {
    throw new Error("operator mutation self-test failed");
  }
  for (const mutation of mutations as SegmentMutation[]) {
    const frame = normalizeWhitespace(
      [mutation.before, mutation.after].filter(Boolean).join(" "),
    );
    if (
      contentWordCount(frame) !== candidate.contentWords ||
      !features(frame, candidate.quote).operatorRisk
    ) {
      throw new Error("length/operator invariant self-test failed");
    }
  }
  if (
    auc([
      { positive: false, score: 0 },
      { positive: true, score: 1 },
    ]) !== 1
  ) {
    throw new Error("metric self-test failed");
  }
  process.stdout.write(
    JSON.stringify({
      status: "ok",
      schemaVersion: SCHEMA_VERSION,
      exactQuote: true,
      mutations: 3,
      lengthControlled: true,
    }) + "\n",
  );
}

async function main(): Promise<void> {
  if (hasFlag("self-test")) {
    selfTest();
    return;
  }
  if (hasFlag("dry-run")) {
    await prepare(true);
    return;
  }
  if (hasFlag("prepare")) {
    await prepare(false);
    return;
  }
  if (hasFlag("prepare-natural-holdout")) {
    await prepareNaturalHoldout();
    return;
  }
  if (hasFlag("score")) {
    const filename = option("score")
      ? path.resolve(option("score") as string)
      : path.join(artifactDirectory(), "rows.jsonl");
    scoreBenchmark(filename);
    return;
  }
  throw new Error(
    "use --self-test, --dry-run, --prepare, --prepare-natural-holdout, or --score [rows.jsonl]",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.stack || error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
