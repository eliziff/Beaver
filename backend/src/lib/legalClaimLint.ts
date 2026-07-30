import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withReadonlySqlite } from "./legalDataPath";

/**
 * Deterministic legal-claim lint (research plan workstream C; hypotheses
 * H7/H10/H13/H14 in docs/legal-grounding-experiments-2026-07-30.md).
 *
 * Every feature is pure counting/regex over the claim, its cited spans,
 * and optionally the user question and the corpus trigram reference
 * index — zero model calls. The lint NEVER edits text and NEVER renders
 * a verdict by itself: it emits receipts (feature, value, fired) that a
 * caller may use to gate a model checker, warn a composer, or rank
 * review priority. Thresholds are calibration artifacts, recorded in
 * every receipt; absent calibration a feature reports its value with
 * fired=null.
 *
 * Corpus-alienness (H13, probed AUC 0.834): misframed claims are
 * written in language the legal corpus never uses. The reference index
 * is built by scripts/build_alienness_index.py (stratified corpus
 * sample; sqlite of FNV-1a-hashed word trigrams with counts). The hash
 * here is a bit-exact port; parity is pinned by test vectors computed
 * by the Python builder.
 */

export type LintFeatureReceipt = {
  feature: string;
  value: number;
  threshold: number | null;
  fired: boolean | null;
  detail?: string;
};

export type LintResult = {
  receipts: LintFeatureReceipt[];
  /** true when any calibrated feature fired */
  flagged: boolean;
  index: { language: string; version: string; docCount: number } | null;
};

const STOP = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its of " +
    "on or that the their there these this to was were will with which would " +
    "when who whom whose not no nor does do did any yes"
  ).split(" "),
);

const ABSTRACTION = new Set([
  "framework", "regime", "scheme", "doctrine", "principle", "principles",
  "regulates", "regulate", "regulating", "regulation", "governs", "govern",
  "governing", "establishes", "establish", "establishing", "comprehensive",
  "broadly", "broad", "generally", "general", "systematic", "codifies",
  "codified",
]);

const ABSOLUTES = new Set([
  "always", "never", "all", "every", "any", "only", "must", "solely",
  "exclusively", "automatically", "invariably", "whenever", "regardless",
]);

const STRONG_MODALS = new Set(["must", "shall", "required", "requires", "mandatory"]);
const WEAK_MODALS = new Set(["may", "can", "permitted", "discretion"]);

const TEMPORAL_VERBS =
  /\b(followed|following|applied|applying|adopted|adopting|affirmed|overruled|distinguished)\b/iu;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/gu) ?? [];
}

function contentWords(text: string): Set<string> {
  return new Set(
    words(text).filter((word) => !STOP.has(word) && word.length > 2),
  );
}

/** Bit-exact port of the Python builder's FNV-1a 64 (signed for sqlite). */
export function fnv1a64(value: string): bigint {
  let digest = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, "utf8")) {
    digest ^= BigInt(byte);
    digest = (digest * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return digest >= 0x8000000000000000n
    ? digest - 0x10000000000000000n
    : digest;
}

function trigramHashes(text: string): bigint[] {
  const tokens = words(text);
  const hashes: bigint[] = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    hashes.push(fnv1a64(tokens.slice(index, index + 3).join(" ")));
  }
  return hashes;
}

function defaultIndexPath(language: string) {
  const local =
    process.env.LOCALAPPDATA?.trim() ||
    path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  return path.join(
    local,
    "ALR Quote Verifier",
    "alienness",
    `trigrams-${language}.sqlite`,
  );
}

export type AlienessSpectrum = {
  unattested: number;
  boilerplate: number;
  attestedRare: number;
  trigrams: number;
  index: { language: string; version: string; docCount: number };
};

/**
 * H13 spectrum of a text against the corpus reference index. Returns
 * null when no index is installed (callers must treat that as
 * feature-unavailable, never as clean). boilerplateCut mirrors the
 * probe's >=30 reference-count cut; calibration may move it.
 */
export function corpusAlienness(
  text: string,
  options?: { language?: "en" | "fr"; indexPath?: string; boilerplateCut?: number },
): AlienessSpectrum | null {
  const language = options?.language ?? "en";
  const cut = options?.boilerplateCut ?? 30;
  const file = options?.indexPath ?? defaultIndexPath(language);
  return withReadonlySqlite(file, (database: DatabaseSync) => {
    const meta = Object.fromEntries(
      (database.prepare("select key, value from meta").all() as Array<
        Record<string, unknown>
      >).map((row) => [String(row.key), String(row.value)]),
    );
    const hashes = trigramHashes(text);
    if (!hashes.length) {
      return {
        unattested: 0,
        boilerplate: 0,
        attestedRare: 0,
        trigrams: 0,
        index: {
          language,
          version: meta.schema_version ?? "?",
          docCount: Number(meta.doc_count ?? 0),
        },
      };
    }
    const lookup = database.prepare("select n from trigram where hash = ?");
    let unattested = 0;
    let boilerplate = 0;
    let rare = 0;
    for (const hash of hashes) {
      const row = lookup.get(hash) as Record<string, unknown> | undefined;
      const count = row ? Number(row.n) : 0;
      if (count === 0) unattested += 1;
      else if (count >= cut) boilerplate += 1;
      else rare += 1;
    }
    return {
      unattested: unattested / hashes.length,
      boilerplate: boilerplate / hashes.length,
      attestedRare: rare / hashes.length,
      trigrams: hashes.length,
      index: {
        language,
        version: meta.schema_version ?? "?",
        docCount: Number(meta.doc_count ?? 0),
      },
    };
  });
}

export type LintInput = {
  claim: string;
  /** exact cited span texts (already resolved from evidence receipts) */
  spans: string[];
  /** the user's question/request, when known (H14) */
  question?: string | null;
  /**
   * decision dates for temporal lint: the citing claim's case date vs the
   * cited case's date, when the claim asserts a follow/apply relation.
   */
  claimCaseDate?: string | null;
  citedCaseDate?: string | null;
  language?: "en" | "fr";
  alienessIndexPath?: string;
};

/**
 * Calibration knobs. Defaults are the probe-run observations, NOT
 * validated thresholds: features fire only where a threshold is set,
 * and callers doing research should read raw values from receipts.
 */
export type LintThresholds = {
  novelContentFraction?: number;
  unattestedShare?: number;
  promptOnlyShare?: number;
};

export function lintLegalClaim(
  input: LintInput,
  thresholds: LintThresholds = {},
): LintResult {
  const receipts: LintFeatureReceipt[] = [];
  const spanText = input.spans.join(" ");
  const claimContent = contentWords(input.claim);
  const spanContent = contentWords(spanText);
  const spanWords = new Set(words(spanText));
  const claimWords = new Set(words(input.claim));

  const novel = [...claimContent].filter((word) => !spanContent.has(word));
  const novelFraction = claimContent.size
    ? novel.length / claimContent.size
    : 0;
  receipts.push({
    feature: "novel_content_fraction",
    value: novelFraction,
    threshold: thresholds.novelContentFraction ?? null,
    fired:
      thresholds.novelContentFraction === undefined
        ? null
        : novelFraction > thresholds.novelContentFraction,
  });

  const abstraction = novel.filter((word) => ABSTRACTION.has(word));
  receipts.push({
    feature: "novel_abstraction_terms",
    value: abstraction.length,
    threshold: null,
    fired: null,
    detail: abstraction.join(","),
  });

  const absolutes = [...ABSOLUTES].filter(
    (word) => claimWords.has(word) && !spanWords.has(word),
  );
  receipts.push({
    feature: "novel_absolutes",
    value: absolutes.length,
    threshold: null,
    fired: null,
    detail: absolutes.join(","),
  });

  const modalityUpgrade =
    [...STRONG_MODALS].some(
      (word) => claimWords.has(word) && !spanWords.has(word),
    ) && [...WEAK_MODALS].some((word) => spanWords.has(word));
  receipts.push({
    feature: "modality_upgrade",
    value: modalityUpgrade ? 1 : 0,
    threshold: null,
    fired: null,
  });

  // Entity poverty: the measured overreach signature is abstraction
  // WITHOUT specifics (numbers, section refs, years).
  const entityCount = (
    input.claim.match(/(?:§+\s*[\dA-Za-z().-]+|\b\d{1,4}(?:\.\d+)?\b)/gu) ?? []
  ).length;
  receipts.push({
    feature: "entity_count",
    value: entityCount,
    threshold: null,
    fired: null,
  });

  if (input.question) {
    const questionContent = contentWords(input.question);
    const promptOnly = [...claimContent].filter(
      (word) => questionContent.has(word) && !spanContent.has(word),
    );
    const promptOnlyShare = claimContent.size
      ? promptOnly.length / claimContent.size
      : 0;
    receipts.push({
      feature: "prompt_only_share",
      value: promptOnlyShare,
      threshold: thresholds.promptOnlyShare ?? null,
      fired:
        thresholds.promptOnlyShare === undefined
          ? null
          : promptOnlyShare > thresholds.promptOnlyShare,
      detail: promptOnly.slice(0, 12).join(","),
    });
  }

  if (
    input.claimCaseDate &&
    input.citedCaseDate &&
    TEMPORAL_VERBS.test(input.claim) &&
    input.claimCaseDate < input.citedCaseDate
  ) {
    receipts.push({
      feature: "temporal_inversion",
      value: 1,
      threshold: 0,
      fired: true,
      detail: `${input.claimCaseDate} asserts follow/apply of ${input.citedCaseDate}`,
    });
  }

  const spectrum = corpusAlienness(input.claim, {
    language: input.language,
    indexPath: input.alienessIndexPath,
  });
  if (spectrum) {
    receipts.push({
      feature: "unattested_trigram_share",
      value: spectrum.unattested,
      threshold: thresholds.unattestedShare ?? null,
      fired:
        thresholds.unattestedShare === undefined
          ? null
          : spectrum.trigrams >= 5 &&
            spectrum.unattested > thresholds.unattestedShare,
    });
    receipts.push({
      feature: "attested_trigram_share",
      value: spectrum.boilerplate + spectrum.attestedRare,
      threshold: null,
      fired: null,
    });
    if (input.question) {
      // H14∩H13 intersection: claim content words that are BOTH
      // prompt-supplied and inside corpus-unattested trigrams mark the
      // direction of the bend. Approximated at word level: prompt-only
      // words absent from the span (computed above) whose surrounding
      // trigrams are unattested are already counted in both features;
      // the intersection receipt just records the co-occurrence.
      const promptReceipt = receipts.find(
        (receipt) => receipt.feature === "prompt_only_share",
      );
      if (promptReceipt) {
        receipts.push({
          feature: "prompt_alien_cooccurrence",
          value: promptReceipt.value * spectrum.unattested,
          threshold: null,
          fired: null,
        });
      }
    }
  }

  return {
    receipts,
    flagged: receipts.some((receipt) => receipt.fired === true),
    index: spectrum?.index ?? null,
  };
}
