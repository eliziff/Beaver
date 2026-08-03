/**
 * Human-label-first citation-grounding benchmark.
 *
 * Queue:
 *   node ... --prepare-canlegal <queries.jsonl> --out queue.jsonl
 *   node ... --prepare-cslb <a2aj_benchmark.jsonl> --split validation --out pairs.jsonl
 *
 * Score reviewed JSONL:
 *   node ... --score reviewed.jsonl --train-split dev --eval-split test
 *
 * Rows are deliberately claim-level. Existing Luna/checker verdicts are not
 * accepted as labels. `evidence_texts` and `label` must be filled by review.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { corpusAlienness, contentWordCount } from "../src/lib/legalClaimLint";
import { cslbCases, type BenchmarkCase } from "../src/lib/legalGroundingBenchmarks";

type Label = "supported" | "partially_supported" | "unsupported";
type Row = {
  id: string;
  source: string;
  source_class?: "case" | "legislation";
  split: "dev" | "test" | "external" | "annotation";
  doc_id: string;
  case_id?: string;
  judge_id?: string | null;
  claim: string;
  citation?: string | null;
  evidence_texts: string[];
  citation_count: number;
  label?: Label | null;
  source_sha256?: string;
  judge_index_path?: string | null;
  label_provenance?: "constructed" | "human" | "silver";
  parent_id?: string | null;
  mutation_type?: string | null;
  mutation_template_id?: string | null;
  mutation_receipt?: Record<string, number | string | null>;
  condition?: "positive" | "negative" | "author_attested";
};

type Features = {
  content_words: number;
  generic_alienness: number | null;
  judge_alienness: number | null;
  judge_delta: number | null;
  scope_mismatch: number;
  qualification_drift: number;
  evidence_overlap: number;
};

const QUALIFIER_GROUPS = [
  /\b(must|required|shall|will|always|never)\b/iu,
  /\b(may|might|could|possibly|likely)\b/iu,
  /\b(not|no|without|unless|except|excluding)\b/iu,
  /\b(if|only if|provided that|where|when)\b/iu,
  /\b(because|therefore|thus|as a result|consequently)\b/iu,
  /\b(before|after|until|since|then|now|later)\b/iu,
  /\b(all|any|each|every|none|solely|merely)\b/iu,
];

function arg(name: string, required = true): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (required && !value) throw new Error(`missing --${name}`);
  return value;
}

function words(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().match(/[a-zÀ-ÿ0-9]+/gu) ?? []).filter((x) => x.length > 2));
}

function clauses(text: string): number {
  return Math.max(1, (text.match(/[,;:]|\b(?:and|but|while|because|although|unless)\b/giu) ?? []).length + 1);
}

function overlap(claim: string, evidence: string): number {
  const left = words(claim);
  const right = words(evidence);
  return left.size ? [...left].filter((word) => right.has(word)).length / left.size : 0;
}

function features(row: Row): Features {
  const evidence = row.evidence_texts.filter(Boolean).join(" ");
  const generic = corpusAlienness(row.claim);
  const judge = row.judge_index_path ? corpusAlienness(row.claim, { indexPath: row.judge_index_path }) : null;
  const genericValue = generic?.unattested ?? null;
  const judgeValue = judge?.unattested ?? null;
  let drift = 0;
  for (const group of QUALIFIER_GROUPS) {
    if (group.test(row.claim) && !group.test(evidence)) drift += 1;
  }
  const evidenceCount = Math.max(1, row.evidence_texts.filter(Boolean).length, row.citation_count);
  return {
    content_words: contentWordCount(row.claim),
    generic_alienness: genericValue,
    judge_alienness: judgeValue,
    judge_delta: genericValue !== null && judgeValue !== null ? genericValue - judgeValue : null,
    scope_mismatch: Math.max(0, clauses(row.claim) - evidenceCount),
    qualification_drift: drift,
    evidence_overlap: overlap(row.claim, evidence),
  };
}

function auc(rows: Array<{ label: boolean; score: number }>): number | null {
  const positives = rows.filter((row) => row.label).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score) end++;
    const meanRank = (rank + rank + end - index - 1) / 2;
    for (let at = index; at < end; at++) if (sorted[at].label) positiveRankSum += meanRank;
    rank += end - index;
    index = end;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function prAuc(rows: Array<{ label: boolean; score: number }>): number | null {
  const positives = rows.filter((row) => row.label).length;
  if (!positives || positives === rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  let seen = 0;
  let area = 0;
  let previousRecall = 0;
  for (const row of sorted) {
    if (row.label) seen++;
    const recall = seen / positives;
    if (row.label) area += (recall - previousRecall) * (seen / (sorted.indexOf(row) + 1));
    previousRecall = recall;
  }
  return area;
}

const signalDirection: Record<string, number> = {
  content_words: -1,
  generic_alienness: 1,
  judge_alienness: 1,
  judge_delta: 1,
  scope_mismatch: 1,
  qualification_drift: 1,
  evidence_overlap: -1,
};

const ARMS: Record<string, string[]> = {
  length_only: ["content_words"],
  generic_alienness: ["content_words", "generic_alienness"],
  scope_mismatch: ["content_words", "scope_mismatch"],
  qualification_drift: ["content_words", "qualification_drift"],
  evidence_overlap: ["content_words", "evidence_overlap"],
  judge_specific: ["content_words", "judge_delta"],
  cheap_all: ["content_words", "generic_alienness", "scope_mismatch", "qualification_drift", "evidence_overlap"],
  all_with_judge: ["content_words", "generic_alienness", "scope_mismatch", "qualification_drift", "judge_delta", "evidence_overlap"],
};

function groupedBootstrap(
  rows: Array<{ row: Row; score: number }>,
  iterations = 2000,
): { low: number | null; high: number | null } {
  const groups = [...new Set(rows.map((item) => item.row.doc_id))];
  if (groups.length < 2) return { low: null, high: null };
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed ^ (seed >>> 16), 2246822519) + 3266489917) >>> 0;
    return seed / 4294967296;
  };
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = groups.flatMap(() => {
      const group = groups[Math.floor(random() * groups.length)];
      return rows.filter((item) => item.row.doc_id === group);
    });
    const value = auc(sample.map((item) => ({ label: item.row.label !== "supported", score: item.score })));
    if (value !== null) values.push(value);
  }
  values.sort((a, b) => a - b);
  return {
    low: values[Math.floor(values.length * 0.025)] ?? null,
    high: values[Math.floor(values.length * 0.975)] ?? null,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sd(values: number[], average: number): number {
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2))) || 1;
}

function scoreArm(rows: Array<{ row: Row; features: Features }>, signals: string[], trainRows: Array<{ row: Row; features: Features }>) {
  const params = new Map<string, { average: number; deviation: number }>();
  for (const signal of signals) {
    const values = trainRows.map((item) => item.features[signal as keyof Features]).filter((value): value is number => value !== null && Number.isFinite(value));
    const average = mean(values);
    params.set(signal, { average, deviation: sd(values, average) });
  }
  const scoreRows = (items: Array<{ row: Row; features: Features }>) => items.map((item) => {
    const scores = signals.map((signal) => {
      const raw = item.features[signal as keyof Features];
      const value = raw === null ? NaN : Number(raw);
      const parameter = params.get(signal)!;
      return Number.isFinite(value) ? signalDirection[signal] * (value - parameter.average) / parameter.deviation : null;
    }).filter((value): value is number => value !== null);
    return { row: item.row, score: scores.length === signals.length ? mean(scores) : NaN };
  }).filter((item) => Number.isFinite(item.score));
  const scored = scoreRows(rows);
  const scoredTrain = scoreRows(trainRows);
  const scoredLabels = scored.filter((item) => item.row.label).map((item) => ({ label: item.row.label !== "supported", score: item.score }));
  const supportedTrainScores = scoredTrain
    .filter((item) => item.row.label === "supported")
    .map((item) => item.score)
    .sort((left, right) => left - right);
  const maxFalsePositiveRate = Number(arg("max-fpr", false) ?? "0.20");
  const thresholds = supportedTrainScores.length
    ? [
        ...new Set(supportedTrainScores),
        supportedTrainScores.at(-1)! + 1e-9,
      ].sort((left, right) => left - right)
    : [];
  const threshold =
    thresholds.find(
      (candidate) =>
        supportedTrainScores.filter((score) => score >= candidate).length /
          supportedTrainScores.length <=
        maxFalsePositiveRate,
    ) ?? null;
  const operating = (items: typeof scored) => {
    const labelled = items.filter((item) => item.row.label);
    const unsupported = labelled.filter((item) => item.row.label !== "supported");
    const severe = labelled.filter((item) => item.row.label === "unsupported");
    const supported = labelled.filter((item) => item.row.label === "supported");
    const flagged = (item: (typeof labelled)[number]) =>
      threshold !== null && item.score >= threshold;
    return {
      n: labelled.length,
      supported: supported.length,
      unsupported: unsupported.length,
      threshold,
      false_negatives: unsupported.filter((item) => !flagged(item)).length,
      false_negative_rate: unsupported.length
        ? unsupported.filter((item) => !flagged(item)).length / unsupported.length
        : null,
      recall_any_unsupported: unsupported.length
        ? unsupported.filter(flagged).length / unsupported.length
        : null,
      recall_severe_unsupported: severe.length
        ? severe.filter(flagged).length / severe.length
        : null,
      false_positive_rate: supported.length
        ? supported.filter(flagged).length / supported.length
        : null,
      review_rate: labelled.length
        ? labelled.filter(flagged).length / labelled.length
        : null,
    };
  };
  return {
    requested_n: rows.length,
    n: scoredLabels.length,
    complete_feature_coverage: scoredLabels.length / Math.max(1, rows.length),
    positives: scoredLabels.filter((item) => item.label).length,
    auc: auc(scoredLabels),
    pr_auc: prAuc(scoredLabels),
    auc_grouped_bootstrap_95: groupedBootstrap(scored),
    operating_point: {
      threshold_fit_split: trainRows[0]?.row.split ?? null,
      target_max_false_positive_rate: maxFalsePositiveRate,
      train: operating(scoredTrain),
      eval: operating(scored),
      by_mutation: Object.fromEntries(
        [...new Set(scored.map((item) => item.row.mutation_type ?? "unmutated"))]
          .sort()
          .map((mutation) => [
            mutation,
            operating(
              scored.filter(
                (item) => (item.row.mutation_type ?? "unmutated") === mutation,
              ),
            ),
          ]),
      ),
    },
  };
}

function readRows(file: string): Row[] {
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const row = JSON.parse(line) as Row;
    if (!row.id || !row.doc_id || !row.claim || !Array.isArray(row.evidence_texts)) throw new Error(`invalid row ${file}:${index + 1}`);
    return row;
  });
}

function prepareCanLegal(input: string, output: string) {
  const rows: Row[] = [];
  for (const [lineNumber, line] of readFileSync(input, "utf8").split(/\r?\n/u).filter(Boolean).entries()) {
    const item = JSON.parse(line) as { query_id: number; answer: string; ground_truth_citations?: string[]; province?: string };
    const citations = item.ground_truth_citations ?? [];
    const paragraphs = item.answer.split(/\n\s*\n/u).map((text) => text.trim()).filter(Boolean);
    const claims = paragraphs.flatMap((paragraph) => paragraph
      .replace(/^\d+\.\s+[^\n]+\n/u, "")
      .split(/(?<=[.!?])\s+(?=[A-Z"(])/u)
      .map((text) => text.trim())
      .filter(Boolean));
    claims.forEach((claim, paragraph) => {
      const found = citations.filter((citation) => claim.toLocaleLowerCase().includes(citation.toLocaleLowerCase()));
      if (!found.length) return;
      rows.push({
        id: `canlegal:${item.query_id}:${paragraph}`,
        source: "canlegalragbench",
        split: "annotation",
        doc_id: `canlegal:${item.query_id}`,
        case_id: String(item.query_id),
        judge_id: null,
        claim,
        citation: found.join("; "),
        evidence_texts: [],
        citation_count: found.length,
        label: null,
        source_sha256: createHash("sha256").update(item.answer, "utf8").digest("hex"),
      });
    });
    if (!paragraphs.length) throw new Error(`empty answer at source line ${lineNumber + 1}`);
  }
  writeFileSync(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(JSON.stringify({ mode: "prepare-canlegal", input, output, rows: rows.length, status: "needs_human_evidence_and_labels" }, null, 2));
}

function deterministicHash(value: string): number {
  return Number.parseInt(createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8), 16);
}

function closestDonor(item: BenchmarkCase, pool: BenchmarkCase[]): BenchmarkCase {
  const candidates = pool.filter((candidate) => candidate.id !== item.id && candidate.sourceClass === item.sourceClass);
  if (!candidates.length) throw new Error(`no same-class donor for ${item.id}`);
  const lowOverlap = candidates.filter(
    (candidate) => overlap(item.target, candidate.evidence[0].spanText) < 0.2,
  );
  return [...(lowOverlap.length ? lowOverlap : candidates)].sort((left, right) => {
    const leftDistance = Math.abs(left.evidence[0].spanText.length - item.evidence[0].spanText.length);
    const rightDistance = Math.abs(right.evidence[0].spanText.length - item.evidence[0].spanText.length);
    const leftOverlap = overlap(item.target, left.evidence[0].spanText);
    const rightOverlap = overlap(item.target, right.evidence[0].spanText);
    return leftDistance - rightDistance || leftOverlap - rightOverlap || deterministicHash(`${item.id}:${left.id}`) - deterministicHash(`${item.id}:${right.id}`);
  })[0];
}

function cslbRow(args: {
  item: BenchmarkCase;
  split: "dev" | "test";
  label: Label;
  claim: string;
  evidence: string;
  citation: string;
  parentId: string;
  mutation: string;
  mutationTemplate?: string | null;
  mutationReceipt?: Row["mutation_receipt"];
  condition: "positive" | "negative";
}): Row {
  return {
    id: `${args.parentId}:${args.mutation}`,
    source: "cslb-constructed",
    source_class: args.item.sourceClass,
    split: args.split,
    doc_id: args.item.id,
    case_id: args.item.id,
    judge_id: null,
    claim: args.claim,
    citation: args.citation,
    evidence_texts: [args.evidence],
    citation_count: 1,
    label: args.label,
    label_provenance: "constructed",
    parent_id: args.parentId,
    mutation_type: args.mutation,
    mutation_template_id: args.mutationTemplate ?? null,
    mutation_receipt: args.mutationReceipt,
    condition: args.condition,
    source_sha256: createHash("sha256").update(args.evidence, "utf8").digest("hex"),
  };
}

function prepareCslb(input: string, output: string) {
  const requestedSplit = arg("split", false) ?? "validation";
  if (!["validation", "test", "all"].includes(requestedSplit)) throw new Error("--split must be validation, test, or all");
  const repoRoot = path.resolve(__dirname, "../..");
  const sourceSplits = requestedSplit === "all" ? ["validation", "test"] : [requestedSplit];
  const casesBySplit = sourceSplits.map((sourceSplit) => ({
    sourceSplit,
    cases: cslbCases(input, sourceSplit, Number(arg("per-source", false) ?? "10000")),
  }));
  if (casesBySplit.some(({ cases }) => !cases.length)) throw new Error(`no CSLB cases in requested split ${requestedSplit}`);
  const rows: Row[] = [];
  for (const { sourceSplit, cases } of casesBySplit) for (const item of cases) {
    const split = sourceSplit === "test" ? "test" : "dev";
    const parentId = `cslb:${item.id}`;
    const gold = item.evidence[0];
    rows.push(cslbRow({ item, split, label: "supported", claim: item.target, evidence: gold.spanText, citation: gold.citation, parentId, mutation: "gold", condition: "positive" }));
    const donor = closestDonor(item, cases);
    const qualifier = split === "dev"
      ? "This rule applies in every circumstance, regardless of the facts."
      : "No factual qualification can limit this rule.";
    rows.push(cslbRow({ item, split, label: "unsupported", claim: item.target, evidence: donor.evidence[0].spanText, citation: donor.evidence[0].citation, parentId, mutation: "same_class_wrong_passage", condition: "negative", mutationReceipt: { donor_case_id: donor.id, target_donor_evidence_overlap: overlap(item.target, donor.evidence[0].spanText) } }));
    rows.push(cslbRow({ item, split, label: "unsupported", claim: `${item.target} ${qualifier}`, evidence: gold.spanText, citation: gold.citation, parentId, mutation: "unsupported_qualifier", condition: "negative", mutationTemplate: split === "dev" ? "qualifier_dev_v1" : "qualifier_test_v1" }));
    rows.push(cslbRow({ item, split, label: "unsupported", claim: `${item.target} ${donor.target}`, evidence: gold.spanText, citation: gold.citation, parentId, mutation: "unsupported_clause", condition: "negative", mutationReceipt: { donor_case_id: donor.id, target_donor_claim_overlap: overlap(item.target, donor.target) } }));
  }
  writeFileSync(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(JSON.stringify({ mode: "prepare-cslb", input, output, repoRoot, source_split: requestedSplit, rows: rows.length, positives: rows.filter((row) => row.condition === "positive").length, negatives: rows.filter((row) => row.condition === "negative").length }, null, 2));
}

function score(input: string) {
  const rows = readRows(input);
  const invalid = rows.filter((row) => !row.label || !row.evidence_texts.length || row.split === "annotation");
  if (invalid.length) throw new Error(`${invalid.length} rows lack reviewed label/evidence or are still annotation rows`);
  const prepared = rows.map((row) => ({ row, features: features(row) }));
  const trainSplit = arg("train-split", false) ?? "dev";
  const evalSplit = arg("eval-split", false) ?? "test";
  const train = prepared.filter((item) => item.row.split === trainSplit);
  const evalRows = prepared.filter((item) => item.row.split === evalSplit);
  if (!train.length || !evalRows.length) throw new Error(`need non-empty train=${trainSplit} and eval=${evalSplit}`);
  const output = {
    benchmark: "legal-grounding-honest-v1",
    input,
    rows: rows.length,
    train: train.length,
    eval: evalRows.length,
    labels: Object.fromEntries(["supported", "partially_supported", "unsupported"].map((label) => [label, rows.filter((row) => row.label === label).length])),
    arms: Object.fromEntries(Object.entries(ARMS).map(([name, signals]) => [name, scoreArm(evalRows, signals, train)])),
    limitations: [
      "Human labels and source passages are required; Luna/checker verdicts are not accepted as gold.",
      "CSLB rows are constructed regression labels, not human gold; report them separately from editorial or expert benchmarks.",
      "Rows are grouped by doc_id in the input manifest; this scorer does not invent a random split.",
      "Every threshold and feature transform is fit on the named training split only; incomplete-feature rows are excluded, not imputed.",
      "A judge-specific score is unavailable unless judge_index_path is supplied and leave-one-document-out construction was recorded.",
    ],
  };
  const outputPath = arg("out", false);
  if (outputPath) writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
}

function selfTest() {
  const rows: Row[] = [
    { id: "a", source: "test", split: "dev", doc_id: "d1", claim: "The court may grant relief.", evidence_texts: ["The court may grant relief."], citation_count: 1, label: "supported" },
    { id: "b", source: "test", split: "dev", doc_id: "d2", claim: "The court must always grant relief because of this rule.", evidence_texts: ["The court may consider the application."], citation_count: 1, label: "unsupported" },
  ];
  if (clauses(rows[1].claim) <= 1 || overlap(rows[0].claim, rows[0].evidence_texts[0]) <= 0.5) throw new Error("feature self-test failed");
  if (auc([{ label: false, score: 0 }, { label: true, score: 1 }]) !== 1) throw new Error("auc self-test failed");
  const train = [
    { row: { ...rows[0], id: "train-a", split: "dev" as const }, features: { content_words: 20, generic_alienness: 0.2, judge_alienness: null, judge_delta: null, scope_mismatch: 0, qualification_drift: 0, evidence_overlap: 1 } },
    { row: { ...rows[1], id: "train-b", split: "dev" as const }, features: { content_words: 5, generic_alienness: 0.9, judge_alienness: null, judge_delta: null, scope_mismatch: 2, qualification_drift: 2, evidence_overlap: 0.2 } },
  ];
  const scored = scoreArm(train, ["content_words"], train);
  if (scored.n !== 2 || scored.auc === null) throw new Error("arm self-test failed");
  console.log("ok");
}

const input = arg("score", false);
if (process.argv.includes("--self-test")) selfTest();
else if (arg("prepare-canlegal", false)) prepareCanLegal(arg("prepare-canlegal")!, arg("out")!);
else if (arg("prepare-cslb", false)) prepareCslb(arg("prepare-cslb")!, arg("out")!);
else if (input) score(input);
else throw new Error("use --prepare-canlegal/--prepare-cslb <file> --out <file>, --score <file>, or --self-test");
