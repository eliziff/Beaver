/** Analyze routed semantic-check receipts without treating them as human gold. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { contentWordCount } from "../../backend/src/lib/legalClaimLint";

type Label = 0 | 1;
type MatrixClaim = {
  record_type: "claim";
  cell_id: string;
  claim_id: string;
  case_id: string | null;
  suite: string | null;
  split: string | null;
  arm: string | null;
  claim_kind: string | null;
  claim_text: string;
  evidence_ids: string[];
  route: string;
  route_reason: string;
  deterministic_support: boolean;
  cell_proxy_label: Label | null;
  values: Record<string, number | null>;
  exact_quote?: string;
};
type SemanticReceipt = {
  row_id?: string;
  cell_id?: string;
  claim_id?: string;
  checker_model?: string;
  verdict: "supported" | "insufficient" | "contradicted" | "invalid" | "abstain";
  evidence_span_sha256: string[];
  latency_ms: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
  } | null;
  error: string | null;
};
type Joined = {
  matrix: MatrixClaim;
  receipt: SemanticReceipt;
  label: Label | null;
  unit_id: string;
};

const SIGNALS = [
  "word_count",
  "content_words",
  "frame_chars",
  "novel_content_fraction",
  "unattested_trigram_share",
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
  "frame_quote_ratio",
  "quote_operator_risk",
  "length_or_operator",
] as const;
type Signal = (typeof SIGNALS)[number];

const QUOTE_FRAMING_SIGNALS: Signal[] = [
  "word_count",
  "content_words",
  "frame_chars",
  "frame_quote_ratio",
  "quote_operator_risk",
  "length_or_operator",
  "novel_content_fraction",
  "novel_abstraction_terms",
  "novel_absolutes",
  "modality_upgrade",
  "entity_count",
  "evidence_overlap",
];

const LOWER_IS_RISK = new Set<Signal>([
  "evidence_overlap",
  "judicial_characterization_overlap",
  "journal_characterization_overlap",
  "characterization_convergence",
]);
const LENGTH_SIGNALS = new Set<Signal>([
  "word_count",
  "content_words",
  "frame_chars",
]);

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function labelOf(verdict: SemanticReceipt["verdict"]): Label | null {
  if (verdict === "supported") return 0;
  if (verdict === "insufficient" || verdict === "contradicted") return 1;
  return null;
}

const STRONG_MODALS = new Set(["must", "shall", "required", "requires", "mandatory"]);
const ABSOLUTE_SCOPE = new Set([
  "all",
  "always",
  "every",
  "never",
  "only",
  "solely",
  "exclusively",
  "automatically",
]);
const NEGATIONS = new Set(["not", "no", "never", "without", "unless"]);

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function quoteOperatorRisk(frame: string, quote: string): number {
  const frameWords = words(frame);
  const quoteWords = words(quote);
  const added = (tokens: Set<string>) =>
    [...tokens].some((token) => frameWords.has(token) && !quoteWords.has(token));
  const negationParity = (tokens: Set<string>) =>
    [...NEGATIONS].reduce(
      (count, token) => count + (tokens.has(token) ? 1 : 0),
      0,
    ) % 2;
  return Number(
    added(STRONG_MODALS) ||
      added(ABSOLUTE_SCOPE) ||
      negationParity(frameWords) !== negationParity(quoteWords),
  );
}

function quoteFramingClaims(
  rows: MatrixClaim[],
  minimumQuoteWords: number,
): MatrixClaim[] {
  const quotesByCell = new Map<string, MatrixClaim[]>();
  for (const row of rows) {
    if (
      row.route_reason !== "exact_verbatim_quote" ||
      !row.deterministic_support
    ) {
      continue;
    }
    const group = quotesByCell.get(row.cell_id) ?? [];
    group.push(row);
    quotesByCell.set(row.cell_id, group);
  }
  return rows.flatMap((row) => {
    if (row.route_reason === "generated_affirmative_quote_framing") {
      const quoteWords = row.exact_quote?.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
      if (quoteWords < minimumQuoteWords) return [];
      return [row];
    }
    if (row.route !== "semantic_check") return [];
    const evidence = new Set(row.evidence_ids);
    const quotes = (quotesByCell.get(row.cell_id) ?? []).filter((quote) =>
      quote.evidence_ids.some((id) => evidence.has(id)),
    );
    if (!quotes.length) return [];
    const quoteText = quotes.map((quote) => quote.claim_text).join(" ");
    const frameWords =
      row.values.content_words ?? contentWordCount(row.claim_text);
    const operator = quoteOperatorRisk(row.claim_text, quoteText);
    return [
      {
        ...row,
        values: {
          ...row.values,
          frame_quote_ratio:
            frameWords / Math.max(1, contentWordCount(quoteText)),
          quote_operator_risk: operator,
          // Every operator row ranks above every plausible text length. A
          // threshold at 1e6 is exactly the operator-only end of this OR rule.
          length_or_operator: operator ? 1_000_000 : frameWords,
        },
      },
    ];
  });
}

function assertSplitDisjoint(rows: MatrixClaim[], splits: string[]): void {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.case_id || !row.split || !splits.includes(row.split)) continue;
    const values = seen.get(row.case_id) ?? new Set<string>();
    values.add(row.split);
    seen.set(row.case_id, values);
  }
  const overlap = [...seen].filter(([, values]) => values.size > 1);
  if (overlap.length)
    throw new Error(`case leakage across splits: ${overlap[0][0]}`);
}

function auc(rows: Array<{ label: Label; score: number }>): number | null {
  const positives = rows.filter((row) => row.label).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((left, right) => left.score - right.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let index = 0; index < sorted.length; ) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score)
      end += 1;
    const meanRank = (rank + rank + end - index - 1) / 2;
    for (let at = index; at < end; at += 1)
      if (sorted[at].label) positiveRankSum += meanRank;
    rank += end - index;
    index = end;
  }
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

function groupedBootstrap(
  rows: Array<{ caseId: string; label: Label; score: number }>,
  iterations = 1_000,
) {
  const groups = [...new Set(rows.map((row) => row.caseId))];
  if (groups.length < 5) return { low: null, high: null, groups: groups.length };
  const byGroup = new Map(
    groups.map((group) => [group, rows.filter((row) => row.caseId === group)]),
  );
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed ^ (seed >>> 16), 2246822519) + 3266489917) >>> 0;
    return seed / 4294967296;
  };
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = groups.flatMap(() => {
      const group = groups[Math.floor(random() * groups.length)];
      return byGroup.get(group)!;
    });
    const value = auc(sample);
    if (value !== null) values.push(value);
  }
  values.sort((left, right) => left - right);
  return {
    low: values[Math.floor(values.length * 0.025)] ?? null,
    high: values[Math.floor(values.length * 0.975)] ?? null,
    groups: groups.length,
  };
}

function fitThresholdForFpr(scores: number[], maxFpr: number): number | null {
  const sorted = [...scores].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const candidates = [...new Set([...sorted, sorted.at(-1)! + 1e-9])].sort(
    (left, right) => left - right,
  );
  return (
    candidates.find(
      (threshold) =>
        sorted.filter((score) => score >= threshold).length / sorted.length <=
        maxFpr,
    ) ?? null
  );
}

function fitThresholdForRecall(
  rows: Array<{ label: Label; score: number }>,
  targetRecall: number,
): number | null {
  const unsupported = rows.filter((row) => row.label === 1);
  const supported = rows.filter((row) => row.label === 0);
  if (!unsupported.length) return null;
  const candidates = [...new Set(rows.map((row) => row.score))].sort(
    (left, right) => right - left,
  );
  const eligible = candidates.flatMap((threshold) => {
    const recall =
      unsupported.filter((row) => row.score >= threshold).length /
      unsupported.length;
    if (recall < targetRecall) return [];
    const falsePositiveRate = supported.length
      ? supported.filter((row) => row.score >= threshold).length /
        supported.length
      : 0;
    return [{ threshold, falsePositiveRate }];
  });
  return (
    eligible.sort(
      (left, right) =>
        left.falsePositiveRate - right.falsePositiveRate ||
        right.threshold - left.threshold,
    )[0]?.threshold ?? null
  );
}

function operating(
  rows: Array<{ label: Label; score: number }>,
  threshold: number | null,
) {
  const unsupported = rows.filter((row) => row.label === 1);
  const supported = rows.filter((row) => row.label === 0);
  const flagged = (row: (typeof rows)[number]) =>
    threshold !== null && row.score >= threshold;
  return {
    n: rows.length,
    supported: supported.length,
    unsupported: unsupported.length,
    false_negatives: unsupported.filter((row) => !flagged(row)).length,
    recall_unsupported: unsupported.length
      ? unsupported.filter(flagged).length / unsupported.length
      : null,
    false_positive_rate: supported.length
      ? supported.filter(flagged).length / supported.length
      : null,
    review_rate: rows.length ? rows.filter(flagged).length / rows.length : null,
  };
}

function riskScore(signal: Signal, value: number) {
  return LOWER_IS_RISK.has(signal) ? -value : value;
}

function scoreSignal(args: {
  rows: Joined[];
  signal: Signal;
  trainSplit: string;
  evalSplits: string[];
  maxFpr: number;
  targetRecall: number | null;
  allowOrientationFlip: boolean;
  forceLowerRisk: boolean;
  fixedThreshold: number | null;
}) {
  const usable = args.rows.filter(
    (row) =>
      row.label !== null && typeof row.matrix.values[args.signal] === "number",
  );
  const lowerIsRisk = args.forceLowerRisk || LOWER_IS_RISK.has(args.signal);
  const predeclared = usable.map((row) => ({
    row,
    caseId: row.matrix.case_id ?? row.matrix.cell_id,
    label: row.label as Label,
    score: lowerIsRisk
      ? -(row.matrix.values[args.signal] as number)
      : riskScore(args.signal, row.matrix.values[args.signal] as number),
  }));
  const predeclaredTrain = predeclared.filter(
    (item) => item.row.matrix.split === args.trainSplit,
  );
  const trainAucPredeclared = auc(predeclaredTrain);
  const multiplier =
    args.allowOrientationFlip &&
    trainAucPredeclared !== null &&
    trainAucPredeclared < 0.5
      ? -1
      : 1;
  const scored = predeclared.map((item) => ({
    ...item,
    score: item.score * multiplier,
  }));
  const train = scored.filter((item) => item.row.matrix.split === args.trainSplit);
  const threshold =
    args.fixedThreshold !== null
      ? args.fixedThreshold
      : args.targetRecall === null
      ? fitThresholdForFpr(
          train.filter((item) => item.label === 0).map((item) => item.score),
          args.maxFpr,
        )
      : fitThresholdForRecall(train, args.targetRecall);
  const basicSummary = (items: typeof scored) => ({
    n: items.length,
    distinct_cases: new Set(items.map((item) => item.caseId)).size,
    unsupported: items.filter((item) => item.label === 1).length,
    auc: auc(items),
    auc_case_bootstrap_95: groupedBootstrap(items),
    operating_point: operating(items, threshold),
  });
  const summarize = (items: typeof scored) => ({
    ...basicSummary(items),
    by_arm: Object.fromEntries(
      [...new Set(items.map((item) => item.row.matrix.arm ?? "unknown"))]
        .sort()
        .map((arm) => [
          arm,
          basicSummary(
            items.filter(
              (item) => (item.row.matrix.arm ?? "unknown") === arm,
            ),
          ),
        ]),
    ),
  });
  return {
    predeclared_risk_orientation: lowerIsRisk
      ? "lower_is_risk"
      : "higher_is_risk",
    orientation_selected_on_train:
      multiplier === 1
        ? lowerIsRisk
          ? "lower_is_risk"
          : "higher_is_risk"
        : lowerIsRisk
          ? "higher_is_risk"
          : "lower_is_risk",
    train_auc_predeclared_orientation: trainAucPredeclared,
    coverage: usable.length / Math.max(1, args.rows.filter((row) => row.label !== null).length),
    missing_supported: args.rows.filter(
      (row) => row.label === 0 && row.matrix.values[args.signal] === null,
    ).length,
    missing_unsupported: args.rows.filter(
      (row) => row.label === 1 && row.matrix.values[args.signal] === null,
    ).length,
    threshold,
    threshold_fit_split:
      args.fixedThreshold === null ? args.trainSplit : "frozen_discovery_dev",
    threshold_objective:
      args.fixedThreshold !== null
        ? { frozen_external_threshold: args.fixedThreshold }
        : args.targetRecall === null
        ? { target_max_false_positive_rate: args.maxFpr }
        : { target_unsupported_recall: args.targetRecall },
    train: summarize(train),
    eval: Object.fromEntries(
      args.evalSplits.map((split) => [
        split,
        summarize(scored.filter((item) => item.row.matrix.split === split)),
      ]),
    ),
  };
}

function tally(values: Array<string | null>) {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "null";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function quantile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function summarizeRows(rows: Joined[]) {
  return {
    n: rows.length,
    distinct_units: new Set(rows.map((row) => row.unit_id)).size,
    distinct_cases: new Set(rows.map((row) => row.matrix.case_id)).size,
    verdicts: tally(rows.map((row) => row.receipt.verdict)),
    by_suite: Object.fromEntries(
      [...new Set(rows.map((row) => row.matrix.suite ?? "unknown"))]
        .sort()
        .map((suite) => [
          suite,
          tally(
            rows
              .filter((row) => (row.matrix.suite ?? "unknown") === suite)
              .map((row) => row.receipt.verdict),
          ),
        ]),
    ),
    by_arm: Object.fromEntries(
      [...new Set(rows.map((row) => row.matrix.arm ?? "unknown"))]
        .sort()
        .map((arm) => [
          arm,
          tally(
            rows
              .filter((row) => (row.matrix.arm ?? "unknown") === arm)
              .map((row) => row.receipt.verdict),
          ),
        ]),
    ),
  };
}

function main() {
  const matrixFile = flag("matrix");
  const resultsFile = flag("results");
  const quoteFramingOnly = flag("quote-framing-only", "0") !== "0";
  const minimumQuoteWords = Number(flag("min-quote-words", "0"));
  const trainSelectLengthOrientation =
    flag("train-select-length-orientation", "0") !== "0";
  const trainSelectAllOrientations =
    flag("train-select-all-orientations", "0") !== "0";
  const forceShorterLengthRisk =
    flag("force-shorter-length-risk", "0") !== "0";
  const frozenContentWordsMaxText = flag("frozen-content-words-max", "");
  const frozenFrameCharsMaxText = flag("frozen-frame-chars-max", "");
  const frozenLengthMaxima: Partial<Record<Signal, number>> = {
    ...(frozenContentWordsMaxText
      ? { content_words: Number(frozenContentWordsMaxText) }
      : {}),
    ...(frozenFrameCharsMaxText
      ? { frame_chars: Number(frozenFrameCharsMaxText) }
      : {}),
  };
  if (
    Object.values(frozenLengthMaxima).some(
      (value) => !Number.isFinite(value) || (value as number) < 0,
    )
  ) {
    throw new Error("frozen length maxima must be finite and non-negative");
  }
  if (Object.keys(frozenLengthMaxima).length && !forceShorterLengthRisk) {
    throw new Error("frozen length maxima require --force-shorter-length-risk 1");
  }
  if (!Number.isInteger(minimumQuoteWords) || minimumQuoteWords < 0) {
    throw new Error("--min-quote-words must be a non-negative integer");
  }
  const trainSplit = flag("train-split", "validation");
  const evalSplits = flag("eval-splits", "test,external")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const maxFpr = Number(flag("max-fpr", "0.20"));
  const targetRecallText = flag(
    "target-recall",
    quoteFramingOnly ? "0.95" : "",
  );
  const targetRecall = targetRecallText ? Number(targetRecallText) : null;
  if (
    targetRecall !== null &&
    (!Number.isFinite(targetRecall) || targetRecall <= 0 || targetRecall > 1)
  ) {
    throw new Error("--target-recall must be in (0, 1]");
  }
  const allMatrix = readJsonl<Record<string, unknown>>(matrixFile).filter(
    (row): row is MatrixClaim => row.record_type === "claim",
  );
  const matrix = quoteFramingOnly
    ? quoteFramingClaims(allMatrix, minimumQuoteWords)
    : allMatrix;
  if (quoteFramingOnly) {
    if (!matrix.length)
      throw new Error("matrix has no semantic claims sharing exact quote evidence");
    assertSplitDisjoint(matrix, [trainSplit, ...evalSplits]);
  }
  const receipts = readJsonl<SemanticReceipt>(resultsFile);
  const byKey = new Map(
    matrix.map((row) => [`${row.cell_id}|${row.claim_id}`, row]),
  );
  const selectedReceipts = quoteFramingOnly
    ? receipts.filter((receipt) =>
        byKey.has(
          `${receipt.cell_id ?? receipt.row_id}|${receipt.claim_id ?? receipt.row_id}`,
        ),
      )
    : receipts;
  const joined = selectedReceipts.map((receipt): Joined => {
    const cellId = receipt.cell_id ?? receipt.row_id;
    const claimId = receipt.claim_id ?? receipt.row_id;
    const matrixRow = byKey.get(`${cellId}|${claimId}`);
    if (!matrixRow)
      throw new Error(`semantic receipt does not resolve in matrix: ${cellId}`);
    return {
      matrix: matrixRow,
      receipt,
      label: labelOf(receipt.verdict),
      unit_id: hash(
        `${claimId}|${[...receipt.evidence_span_sha256].sort().join(",")}`,
      ),
    };
  });
  const deduped = [...new Map(joined.map((row) => [row.unit_id, row])).values()];
  const adjudicated = deduped.filter((row) => row.label !== null);
  const signals = quoteFramingOnly ? QUOTE_FRAMING_SIGNALS : [...SIGNALS];
  const signalReports = Object.fromEntries(
    signals.map((signal) => [
      signal,
      scoreSignal({
        rows: deduped,
        signal,
        trainSplit,
        evalSplits,
        maxFpr,
        targetRecall,
        allowOrientationFlip:
          !(forceShorterLengthRisk && LENGTH_SIGNALS.has(signal)) &&
          (!quoteFramingOnly ||
            trainSelectAllOrientations ||
            (trainSelectLengthOrientation && LENGTH_SIGNALS.has(signal))),
        forceLowerRisk:
          forceShorterLengthRisk && LENGTH_SIGNALS.has(signal),
        fixedThreshold:
          frozenLengthMaxima[signal] === undefined
            ? null
            : -(frozenLengthMaxima[signal] as number),
      }),
    ]),
  );
  const proxyComparable = adjudicated.filter(
    (row) => row.matrix.cell_proxy_label !== null,
  );
  const latencies = selectedReceipts.map((row) => row.latency_ms);
  const total = (field: "inputTokens" | "outputTokens" | "reasoningTokens") =>
    selectedReceipts.reduce(
      (sum, row) => sum + (row.usage?.[field] ?? 0),
      0,
    );
  const checkerModels = [
    ...new Set(
      selectedReceipts.map((row) => row.checker_model ?? "unknown"),
    ),
  ].sort();
  const output = {
    benchmark: quoteFramingOnly
      ? "natural-exact-quote-framing-analysis-v1"
      : "legal-grounding-routed-semantic-analysis-v1",
    matrix: { file: matrixFile, sha256: hash(readFileSync(matrixFile)) },
    results: { file: resultsFile, sha256: hash(readFileSync(resultsFile)) },
    label_provenance: {
      kind: "independent_semantic_checker_proxy_not_human_gold",
      checker_models: checkerModels,
    },
    selection: quoteFramingOnly
      ? "semantic framing claim sharing evidence with a deterministically verified exact quotation; selected without reading verdict or signal"
      : "label_blind_diverse_round_robin",
    quote_framing: quoteFramingOnly
      ? {
          candidate_claims: matrix.length,
          checked_claims: deduped.length,
          distinct_cells: new Set(matrix.map((row) => row.cell_id)).size,
          distinct_cases: new Set(matrix.map((row) => row.case_id)).size,
          by_split: tally(matrix.map((row) => row.split)),
          by_suite: tally(matrix.map((row) => row.suite)),
          fixed_risk_orientation:
            !trainSelectLengthOrientation && !trainSelectAllOrientations,
          fixed_non_length_risk_orientation: !trainSelectAllOrientations,
          minimum_quote_words: minimumQuoteWords,
          length_orientation_selected_on_train: trainSelectLengthOrientation,
          all_orientations_selected_on_train: trainSelectAllOrientations,
          forced_shorter_length_risk: forceShorterLengthRisk,
          frozen_length_maxima: frozenLengthMaxima,
          target_unsupported_recall: targetRecall,
        }
      : null,
    all_cells: summarizeRows(joined),
    deduplicated_units: summarizeRows(deduped),
    duplicate_cells_removed: joined.length - deduped.length,
    invalid_or_abstain: deduped.filter((row) => row.label === null).length,
    checker_cost: {
      calls: selectedReceipts.length,
      latency_ms: {
        median: quantile(latencies, 0.5),
        p95: quantile(latencies, 0.95),
        max: quantile(latencies, 1),
      },
      input_tokens: total("inputTokens"),
      output_tokens: total("outputTokens"),
      reasoning_tokens: total("reasoningTokens"),
    },
    holistic_proxy_agreement: {
      n: proxyComparable.length,
      agreement: proxyComparable.length
        ? proxyComparable.filter(
            (row) => row.label === row.matrix.cell_proxy_label,
          ).length / proxyComparable.length
        : null,
      caveat: "The holistic proxy is answer-level and repeated over claims.",
    },
    signals: signalReports,
    limitations: [
      `These verdicts measure agreement with ${checkerModels.join(", ")} semantic checking, not human gold.`,
      Object.keys(frozenLengthMaxima).length
        ? "Supplied length thresholds and directions were frozen on the earlier discovery dev split; this holdout does not refit them."
        : "Thresholds use validation checker labels only; test and external rows do not fit transforms or thresholds.",
      "Case-grouped bootstrap intervals address repeated arms, and exact claim-plus-passage duplicates are removed.",
      quoteFramingOnly
        ? "The exact quotation is deterministic; the support label applies only to the separate framing claim sharing its evidence."
        : "A cheap signal may prioritize review but cannot safely clear a non-verbatim legal claim on this evidence.",
    ],
  };
  const out = flag("out", "");
  if (out) writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

function selfTest() {
  if (auc([{ label: 0, score: 0 }, { label: 1, score: 1 }]) !== 1)
    throw new Error("AUC self-test failed");
  const threshold = fitThresholdForFpr([0, 1, 2, 3, 4], 0.2);
  if (threshold !== 4) throw new Error("threshold self-test failed");
  const recallThreshold = fitThresholdForRecall(
    [
      { label: 0, score: 1 },
      { label: 0, score: 2 },
      { label: 1, score: 3 },
      { label: 1, score: 4 },
    ],
    1,
  );
  if (recallThreshold !== 3)
    throw new Error("recall threshold self-test failed");
  const result = operating(
    [
      { label: 0, score: 0 },
      { label: 1, score: 1 },
    ],
    0.5,
  );
  if (result.recall_unsupported !== 1 || result.false_positive_rate !== 0)
    throw new Error("operating-point self-test failed");
  if (
    quoteOperatorRisk(
      "The rule must always apply.",
      "The rule may apply in this case.",
    ) !== 1
  ) {
    throw new Error("quote operator self-test failed");
  }
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else main();
