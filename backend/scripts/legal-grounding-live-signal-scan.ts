/** Read-only, claim-level signal scan over live legal-grounding receipts. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  contentWordCount,
  lintLegalClaim,
} from "../src/lib/legalClaimLint";
import {
  standsForProfile,
  type StandsForCandidate,
} from "../src/lib/caselawCitator";
import {
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  type GroundedLegalClaim,
  type LegalEvidenceReceipt,
  type LegalEvidenceReceiptEvent,
} from "../src/lib/chat/legalEvidenceExperiment";

type Label = 0 | 1;
type RunRow = {
  schema_version?: number;
  case_id?: string;
  suite?: string;
  jurisdiction?: "CA" | "US";
  source_class?: string;
  adversarial?: boolean;
  gold_kind?: string;
  reference_expectation?: unknown;
  model?: string;
  checker_model?: string | null;
  effort?: string;
  arm?: string;
  status?: "completed" | "error" | string;
  prompt_modules?: string[];
  latency_ms?: number;
  target_token_f1?: number;
  rank_policy?: string | null;
  replicate?: number;
  error?: string | null;
  legal_evidence_receipt?: LegalEvidenceReceiptEvent | null;
};

const SIGNALS = [
  "content_words",
  "novel_content_fraction",
  "unattested_trigram_share",
  "prompt_only_share",
  "prompt_alien_cooccurrence",
  "novel_abstraction_terms",
  "novel_absolutes",
  "modality_upgrade",
  "entity_count",
  "scope_mismatch",
  "qualification_drift",
  "evidence_overlap",
  "judicial_characterization_overlap",
  "journal_characterization_overlap",
  "characterization_convergence",
] as const;
type Signal = (typeof SIGNALS)[number];
type SignalValues = Record<Signal, number | null>;

const LOWER_IS_RISK = new Set<Signal>([
  "evidence_overlap",
  "judicial_characterization_overlap",
  "journal_characterization_overlap",
  "characterization_convergence",
]);

type RouteDecision = {
  route: "deterministic_clear" | "deterministic_review" | "semantic_check";
  reason:
    | "exact_verbatim_quote"
    | "missing_evidence"
    | "quote_mismatch"
    | "protocol_attestation_statement"
    | "nonverbatim_claim";
};

type CellRecord = {
  schema_version: 2;
  record_type: "cell";
  cell_id: string;
  source_file: string;
  source_sha256: string;
  source_line: number;
  run_id: string;
  split: string | null;
  replicate: number | null;
  case_id: string | null;
  suite: string | null;
  jurisdiction: string | null;
  source_class: string | null;
  adversarial: boolean | null;
  gold_kind: string | null;
  model: string | null;
  checker_model: string | null;
  effort: string | null;
  arm: string | null;
  rank_policy: string | null;
  transport_status: string;
  protocol_status:
    | "transport_error"
    | "missing_receipt"
    | "no_claims"
    | "no_conclusion"
    | "claims_present";
  receipt_status: string | null;
  checker_status: string | null;
  grounding_status: string | null;
  claim_count: number;
  conclusion_count: number;
  target_token_f1: number | null;
  error: string | null;
};

type ClaimRecord = {
  schema_version: 2;
  record_type: "claim";
  cell_id: string;
  claim_id: string;
  claim_index: number;
  source_file: string;
  source_sha256: string;
  source_line: number;
  run_id: string;
  split: string | null;
  replicate: number | null;
  case_id: string | null;
  suite: string | null;
  jurisdiction: string | null;
  source_class: string | null;
  adversarial: boolean | null;
  gold_kind: string | null;
  model: string | null;
  checker_model: string | null;
  effort: string | null;
  arm: string | null;
  rank_policy: string | null;
  claim_kind: string | null;
  claim_text: string;
  evidence_ids: string[];
  evidence_citations: string[];
  source_document_ids: string[];
  missing_evidence_ids: string[];
  route: RouteDecision["route"];
  route_reason: RouteDecision["reason"];
  review_required: boolean;
  review_reason: string;
  context_status: string;
  semantic_status: string;
  deterministic_support: boolean;
  claim_label: Label | null;
  claim_label_provenance: "checker_claim" | null;
  cell_proxy_label: Label | null;
  cell_proxy_label_provenance: "checker_holistic_proxy" | null;
  target_token_f1: number | null;
  low_f1: Label | null;
  characterization_candidate_counts: {
    judicial: number;
    journal: number;
    same_citation_dual_source: number;
  };
  values: SignalValues;
};

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string): string {
  return hash(readFileSync(file));
}

function auc(rows: Array<{ label: Label; score: number }>): number | null {
  const positives = rows.filter((row) => row.label).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const meanRank = (rank + rank + j - i - 1) / 2;
    for (let k = i; k < j; k += 1)
      if (sorted[k].label) positiveRankSum += meanRank;
    rank += j - i;
    i = j;
  }
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length < 2 || left.length !== right.length) return null;
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const x = average(left);
  const y = average(right);
  const numerator = left.reduce(
    (sum, value, index) => sum + (value - x) * (right[index] - y),
    0,
  );
  const x2 = left.reduce((sum, value) => sum + (value - x) ** 2, 0);
  const y2 = right.reduce((sum, value) => sum + (value - y) ** 2, 0);
  return x2 && y2 ? numerator / Math.sqrt(x2 * y2) : null;
}

const QUALIFIER_GROUPS = [
  /\b(must|required|shall|will|always|never)\b/iu,
  /\b(may|might|could|possibly|likely)\b/iu,
  /\b(not|no|without|unless|except|excluding)\b/iu,
  /\b(if|only if|provided that|where|when)\b/iu,
  /\b(because|therefore|thus|as a result|consequently)\b/iu,
  /\b(before|after|until|since|then|now|later)\b/iu,
  /\b(all|any|each|every|none|solely|merely)\b/iu,
];

function clauseCount(text: string): number {
  return Math.max(
    1,
    (text.match(/[,;:]|\b(?:and|but|while|because|although|unless)\b/giu) ?? [])
      .length + 1,
  );
}

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

function tokenOverlap(left: string, right: string): number {
  const claim = words(left);
  const source = words(right);
  return claim.size
    ? [...claim].filter((word) => source.has(word)).length / claim.size
    : 0;
}

function evidenceOverlap(claim: string, evidence: string): number {
  return tokenOverlap(claim, evidence);
}

function routeDecision(args: {
  claim: GroundedLegalClaim;
  evidence: LegalEvidenceReceipt[];
  deterministicSupport: boolean;
  missingEvidenceIds: string[];
  arm?: string | null;
}): RouteDecision {
  if (!args.claim.text.trim() || args.missingEvidenceIds.length || !args.evidence.length)
    return { route: "deterministic_review", reason: "missing_evidence" };
  if (args.claim.kind === "quotation")
    return args.deterministicSupport
      ? { route: "deterministic_clear", reason: "exact_verbatim_quote" }
      : { route: "deterministic_review", reason: "quote_mismatch" };
  if (
    (args.arm === "required_slot" || args.arm === "witness_panel") &&
    /^No attested characterization of .+ is available\.?$/iu.test(
      args.claim.text.trim(),
    )
  )
    return {
      route: "deterministic_review",
      reason: "protocol_attestation_statement",
    };
  return { route: "semantic_check", reason: "nonverbatim_claim" };
}

function candidateOverlap(claim: string, candidates: StandsForCandidate[]) {
  return candidates.length
    ? Math.max(...candidates.map((candidate) => tokenOverlap(claim, candidate.text)))
    : null;
}

function characterizationFeatures(
  claim: string,
  citations: string[],
  cache: Map<string, ReturnType<typeof standsForProfile>>,
) {
  let judicialCount = 0;
  let journalCount = 0;
  let sameCitationDualSource = 0;
  const judicialScores: number[] = [];
  const journalScores: number[] = [];
  const convergenceScores: number[] = [];
  for (const citation of citations) {
    if (!cache.has(citation))
      cache.set(citation, standsForProfile({ citation, size: 24 }));
    const candidates = cache.get(citation)?.candidates ?? [];
    const judicial = candidates.filter((item) => item.sourceKind === "case");
    const journal = candidates.filter((item) => item.sourceKind === "commentary");
    judicialCount += judicial.length;
    journalCount += journal.length;
    const judicialScore = candidateOverlap(claim, judicial);
    const journalScore = candidateOverlap(claim, journal);
    if (judicialScore !== null) judicialScores.push(judicialScore);
    if (journalScore !== null) journalScores.push(journalScore);
    if (judicialScore !== null && journalScore !== null) {
      sameCitationDualSource += 1;
      convergenceScores.push(Math.min(judicialScore, journalScore));
    }
  }
  return {
    values: {
      judicial_characterization_overlap: judicialScores.length
        ? Math.max(...judicialScores)
        : null,
      journal_characterization_overlap: journalScores.length
        ? Math.max(...journalScores)
        : null,
      characterization_convergence: convergenceScores.length
        ? Math.max(...convergenceScores)
        : null,
    },
    counts: {
      judicial: judicialCount,
      journal: journalCount,
      same_citation_dual_source: sameCitationDualSource,
    },
  };
}

function inferSplit(file: string): string | null {
  const match = basename(file).match(/(?:^|[-_.])(validation|validate|dev|test)(?:[-_.]|$)/iu);
  if (!match) return null;
  return match[1].toLocaleLowerCase().startsWith("val") ? "validation" : match[1].toLocaleLowerCase();
}

function claimLabel(status: string): Label | null {
  if (status === "supported") return 0;
  if (status === "contradicted" || status === "insufficient") return 1;
  return null;
}

function holisticLabel(status: string | null): Label | null {
  if (status === "supported") return 0;
  if (status === "partially_supported" || status === "unsupported") return 1;
  return null;
}

function reviewOutcome(route: RouteDecision, semanticStatus: string) {
  if (route.route === "deterministic_clear")
    return { required: false, reason: "deterministic_clear" };
  if (route.route === "deterministic_review")
    return { required: true, reason: route.reason };
  if (semanticStatus === "supported")
    return { required: false, reason: "semantic_supported" };
  if (semanticStatus === "contradicted" || semanticStatus === "insufficient")
    return { required: true, reason: `semantic_${semanticStatus}` };
  return { required: true, reason: "semantic_pending_or_invalid" };
}

function signalValues(args: {
  claim: GroundedLegalClaim;
  evidence: LegalEvidenceReceipt[];
  jurisdiction: string | null;
  usIndex?: string;
  profileCache: Map<string, ReturnType<typeof standsForProfile>>;
}) {
  const text = args.claim.text.trim();
  const spans = args.evidence
    .map((item) => item.span_text ?? "")
    .filter(Boolean);
  const evidenceText = spans.join(" ");
  const lint = lintLegalClaim({
    claim: text,
    spans,
    ...(args.jurisdiction === "US" && args.usIndex
      ? { alienessIndexPath: args.usIndex }
      : {}),
  });
  const feature = new Map(lint.receipts.map((item) => [item.feature, item.value]));
  const citations = [...new Set(args.evidence.map((item) => item.citation).filter(Boolean))];
  const characterization = characterizationFeatures(text, citations, args.profileCache);
  const values: SignalValues = {
    content_words: contentWordCount(text),
    novel_content_fraction: feature.get("novel_content_fraction") ?? null,
    unattested_trigram_share: feature.get("unattested_trigram_share") ?? null,
    prompt_only_share: feature.get("prompt_only_share") ?? null,
    prompt_alien_cooccurrence: feature.get("prompt_alien_cooccurrence") ?? null,
    novel_abstraction_terms: feature.get("novel_abstraction_terms") ?? null,
    novel_absolutes: feature.get("novel_absolutes") ?? null,
    modality_upgrade: feature.get("modality_upgrade") ?? null,
    entity_count: feature.get("entity_count") ?? null,
    scope_mismatch: spans.length
      ? Math.max(0, clauseCount(text) - Math.max(1, spans.length))
      : null,
    qualification_drift: spans.length
      ? QUALIFIER_GROUPS.filter(
          (group) => group.test(text) && !group.test(evidenceText),
        ).length
      : null,
    evidence_overlap: spans.length ? evidenceOverlap(text, evidenceText) : null,
    ...characterization.values,
  };
  return { values, characterizationCounts: characterization.counts };
}

function readInputs(files: string[], splits: string[]) {
  return files.map((file, fileIndex) => {
    const sourceSha256 = sha256File(file);
    const split = splits[fileIndex] || inferSplit(file);
    const rows = readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunRow);
    return { file, sourceSha256, split, rows };
  });
}

function scoreSignal(
  rows: ClaimRecord[],
  signal: Signal,
  labelField: "claim_label" | "cell_proxy_label",
) {
  const usable = rows.filter(
    (row) => row[labelField] !== null && row.values[signal] !== null,
  );
  const risk = (value: number) => (LOWER_IS_RISK.has(signal) ? -value : value);
  const labels = usable.map((row) => ({
    label: row[labelField] as Label,
    score: risk(row.values[signal] as number),
  }));
  const lowF1 = usable.filter((row) => row.low_f1 !== null);
  const average = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  return {
    n: usable.length,
    distinct_cells: new Set(usable.map((row) => row.cell_id)).size,
    positives: usable.filter((row) => row[labelField] === 1).length,
    missing: rows.length - usable.length,
    risk_orientation: LOWER_IS_RISK.has(signal) ? "lower_is_risk" : "higher_is_risk",
    auc: auc(labels),
    auc_low_f1: auc(
      lowF1.map((row) => ({
        label: row.low_f1 as Label,
        score: risk(row.values[signal] as number),
      })),
    ),
    pearson_f1: pearson(
      lowF1.map((row) => row.values[signal] as number),
      lowF1.map((row) => row.target_token_f1 as number),
    ),
    mean_supported: average(
      usable
        .filter((row) => row[labelField] === 0)
        .map((row) => row.values[signal] as number),
    ),
    mean_rejected: average(
      usable
        .filter((row) => row[labelField] === 1)
        .map((row) => row.values[signal] as number),
    ),
  };
}

function tally<T extends string | null>(values: T[]) {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "null";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function main() {
  const files = flag("files")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!files.length || files.some((file) => !existsSync(file)))
    throw new Error("pass existing --files=a.jsonl,b.jsonl");
  const splits = flag("splits")
    .split(",")
    .map((value) => value.trim());
  if (splits.some(Boolean) && splits.length !== files.length)
    throw new Error("--splits must have one comma-separated value per input file");

  const inputs = readInputs(files, splits);
  const profileCache = new Map<string, ReturnType<typeof standsForProfile>>();
  const cellRecords: CellRecord[] = [];
  const claimRecords: ClaimRecord[] = [];
  const usIndex = flag("us-index") || undefined;

  for (const input of inputs) {
    input.rows.forEach((row, sourceLine) => {
      const receipt = row.legal_evidence_receipt ?? null;
      const claims = receipt?.claims ?? [];
      const conclusions = claims.filter((claim) => claim.kind === "conclusion");
      const cellId = hash(`${input.sourceSha256}:${sourceLine}`);
      const runId = basename(input.file);
      const transportStatus = row.status ?? (row.error ? "error" : "unknown");
      const protocolStatus: CellRecord["protocol_status"] =
        transportStatus === "error" || Boolean(row.error)
          ? "transport_error"
          : !receipt
            ? "missing_receipt"
            : !claims.length
              ? "no_claims"
              : !conclusions.length
                ? "no_conclusion"
                : "claims_present";
      const metadata = {
        source_file: input.file,
        source_sha256: input.sourceSha256,
        source_line: sourceLine,
        run_id: runId,
        split: input.split,
        replicate: Number.isInteger(row.replicate) ? row.replicate! : null,
        case_id: row.case_id ?? null,
        suite: row.suite ?? null,
        jurisdiction: row.jurisdiction ?? null,
        source_class: row.source_class ?? null,
        adversarial: typeof row.adversarial === "boolean" ? row.adversarial : null,
        gold_kind: row.gold_kind ?? null,
        model: row.model ?? null,
        checker_model: row.checker_model ?? null,
        effort: row.effort ?? null,
        arm: row.arm ?? null,
        rank_policy: row.rank_policy ?? null,
      };
      cellRecords.push({
        schema_version: 2,
        record_type: "cell",
        cell_id: cellId,
        ...metadata,
        transport_status: transportStatus,
        protocol_status: protocolStatus,
        receipt_status: receipt?.status ?? null,
        checker_status: receipt?.verification.semantic ?? null,
        grounding_status: receipt?.verification.holistic ?? row.legal_evidence_receipt?.verification.holistic ?? null,
        claim_count: claims.length,
        conclusion_count: conclusions.length,
        target_token_f1:
          typeof row.target_token_f1 === "number" ? row.target_token_f1 : null,
        error: row.error ?? null,
      });
      if (!receipt) return;

      const evidenceById = new Map(
        receipt.evidence.map((item) => [item.evidence_id, item]),
      );
      const state = createLegalEvidenceTurnState(receipt.mode);
      for (const evidence of receipt.evidence)
        state.evidence.set(evidence.evidence_id, { receipt: evidence });

      claims.forEach((receiptClaim, claimIndex) => {
        const claim: GroundedLegalClaim = {
          text: receiptClaim.text ?? "",
          evidence_ids: receiptClaim.evidence_ids ?? [],
          kind: receiptClaim.kind,
          premise_source: receiptClaim.premise_source,
          premise_text: receiptClaim.premise_text,
        };
        const evidence = claim.evidence_ids.flatMap((id) => {
          const found = evidenceById.get(id);
          return found ? [found] : [];
        });
        const missingEvidenceIds = claim.evidence_ids.filter(
          (id) => !evidenceById.has(id),
        );
        const deterministicSupport = deterministicClaimSupport(claim, state);
        const route = routeDecision({
          claim,
          evidence,
          deterministicSupport,
          missingEvidenceIds,
          arm: row.arm,
        });
        const semanticStatus = receiptClaim.evidence_status ?? "not_run";
        const review = reviewOutcome(route, semanticStatus);
        const { values, characterizationCounts } = signalValues({
          claim,
          evidence,
          jurisdiction: row.jurisdiction ?? null,
          usIndex,
          profileCache,
        });
        const claimGroundingLabel = claimLabel(semanticStatus);
        const cellGroundingLabel = holisticLabel(
          receipt.verification.holistic === "not_run"
            ? null
            : receipt.verification.holistic,
        );
        const targetF1 =
          typeof row.target_token_f1 === "number" ? row.target_token_f1 : null;
        claimRecords.push({
          schema_version: 2,
          record_type: "claim",
          cell_id: cellId,
          claim_id: receiptClaim.text_sha256 || hash(claim.text),
          claim_index: claimIndex,
          ...metadata,
          claim_kind: claim.kind ?? null,
          claim_text: claim.text,
          evidence_ids: claim.evidence_ids,
          evidence_citations: [...new Set(evidence.map((item) => item.citation))],
          source_document_ids: [
            ...new Set(evidence.map((item) => item.stable_source_id)),
          ],
          missing_evidence_ids: missingEvidenceIds,
          route: route.route,
          route_reason: route.reason,
          review_required: review.required,
          review_reason: review.reason,
          context_status: receiptClaim.context_status ?? "not_run",
          semantic_status: semanticStatus,
          deterministic_support: deterministicSupport,
          claim_label: claimGroundingLabel,
          claim_label_provenance: claimGroundingLabel === null ? null : "checker_claim",
          cell_proxy_label: cellGroundingLabel,
          cell_proxy_label_provenance:
            cellGroundingLabel === null ? null : "checker_holistic_proxy",
          target_token_f1: targetF1,
          low_f1: targetF1 === null ? null : targetF1 < 0.4 ? 1 : 0,
          characterization_candidate_counts: characterizationCounts,
          values,
        });
      });
    });
  }

  const claimChecked = claimRecords.filter((row) => row.claim_label !== null);
  const proxyChecked = claimRecords.filter((row) => row.cell_proxy_label !== null);
  const output = {
    experiment: "legal-grounding-live-signal-scan",
    schema_version: 2,
    warning:
      "Checker outcomes are automatic proxies, not human gold. Holistic labels repeat at claim level and are secondary only.",
    files,
    cells_read: cellRecords.length,
    claims_read: claimRecords.length,
    distinct_cases: new Set(cellRecords.map((row) => row.case_id).filter(Boolean)).size,
    protocol_status: tally(cellRecords.map((row) => row.protocol_status)),
    receipt_status: tally(cellRecords.map((row) => row.receipt_status)),
    checker_status: tally(cellRecords.map((row) => row.checker_status)),
    grounding_status: tally(cellRecords.map((row) => row.grounding_status)),
    routes: tally(claimRecords.map((row) => row.route)),
    review_required: tally(
      claimRecords.map((row) => (row.review_required ? "yes" : "no")),
    ),
    semantic_status: tally(claimRecords.map((row) => row.semantic_status)),
    claim_checker_labels: {
      n: claimChecked.length,
      positives: claimChecked.filter((row) => row.claim_label === 1).length,
      signals: Object.fromEntries(
        SIGNALS.map((signal) => [
          signal,
          scoreSignal(claimRecords, signal, "claim_label"),
        ]),
      ),
    },
    holistic_proxy_labels: {
      n: proxyChecked.length,
      distinct_cells: new Set(proxyChecked.map((row) => row.cell_id)).size,
      positives: proxyChecked.filter((row) => row.cell_proxy_label === 1).length,
      signals: Object.fromEntries(
        SIGNALS.map((signal) => [
          signal,
          scoreSignal(claimRecords, signal, "cell_proxy_label"),
        ]),
      ),
    },
    characterization_coverage: {
      judicial: claimRecords.filter(
        (row) => row.values.judicial_characterization_overlap !== null,
      ).length,
      journal: claimRecords.filter(
        (row) => row.values.journal_characterization_overlap !== null,
      ).length,
      same_citation_convergence: claimRecords.filter(
        (row) => row.values.characterization_convergence !== null,
      ).length,
    },
  };

  const matrixOut = flag("matrix-out");
  if (matrixOut) {
    const records = [...cellRecords, ...claimRecords];
    writeFileSync(
      matrixOut,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const manifestOut = flag("manifest-out");
    if (manifestOut)
      writeFileSync(
        manifestOut,
        `${JSON.stringify(
          {
            schema_version: 2,
            experiment: output.experiment,
            inputs: inputs.map((input) => ({
              file: input.file,
              sha256: input.sourceSha256,
              split: input.split,
            })),
            matrix: matrixOut,
            cell_records: cellRecords.length,
            claim_records: claimRecords.length,
            label_provenance: {
              primary: "checker_claim",
              secondary: "checker_holistic_proxy",
              human_gold: false,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
  }
  console.log(JSON.stringify(output, null, 2));
}

function selfTest() {
  if (
    tokenOverlap("The court applied this rule.", "The court applied the rule.") <
    0.8
  )
    throw new Error("characterization overlap self-test failed");
  if (
    tokenOverlap(
      "The court applied this rule.",
      "A wholly unrelated proposition.",
    ) !== 0
  )
    throw new Error("characterization separation self-test failed");
  const exact = routeDecision({
    claim: { text: '"A sufficiently long exact quotation from the source."', evidence_ids: ["e"], kind: "quotation" },
    evidence: [{} as LegalEvidenceReceipt],
    deterministicSupport: true,
    missingEvidenceIds: [],
    arm: null,
  });
  if (exact.route !== "deterministic_clear")
    throw new Error("exact quote route self-test failed");
  const paraphrase = routeDecision({
    claim: { text: "The source establishes the proposition.", evidence_ids: ["e"], kind: "conclusion" },
    evidence: [{} as LegalEvidenceReceipt],
    deterministicSupport: false,
    missingEvidenceIds: [],
    arm: null,
  });
  if (paraphrase.route !== "semantic_check")
    throw new Error("semantic route self-test failed");
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else main();
