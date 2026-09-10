/**
 * Runner for the authorities-split benchmark.
 *
 *   cd backend && npx tsx ../benchmarks/authorities-split/run.ts
 *
 * Scores Beaver's deterministic native splitter (no model) against the ALR
 * quote-verifier footnote gold, and its pinpoint grammar against the ALR
 * field gold. Writes benchmarks/authorities-split/report.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  alrRoot, charNeutrality, endpointNormalized, goldPinpoints, loadPinpointGold,
  loadSplitGold, nativePinpoints, sameSet, scoreParts, spanOverlap,
  splitFootnote, type GoldRow,
} from "./bench";
import { structureNative } from "../../backend/src/lib/structureNative";

const argument = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const here = __dirname;
const goldFiles = argument("--gold",
  "fast_split_manual_gold.jsonl,fast_split_gold_all.jsonl").split(",");
const limit = Number(argument("--limit", "0"));
const reportPath = argument("--report", path.join(here, "report.md"));
const detailsDir = argument("--details", path.join(here, "runs"));

type Detail = ReturnType<typeof scoreParts> & ReturnType<typeof charNeutrality> & {
  id: string; sourceDoc: string; tags: string[]; text: string;
  expected: string[]; actual: string[]; truePositives: number;
};

function runSplit(rows: GoldRow[]): Detail[] {
  return rows.map((row) => {
    const actual = splitFootnote(row.text);
    const overlap = spanOverlap(row.expected, actual);
    return {
      id: row.id, sourceDoc: row.sourceDoc, tags: row.tags, text: row.text,
      expected: row.expected, actual, truePositives: overlap.truePositives,
      ...scoreParts(row.expected, actual, row.acceptable),
      ...charNeutrality(row.text, actual),
    };
  });
}

const rate = (count: number, total: number) => total ? (count / total) : 0;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function summarize(details: Detail[]) {
  const total = details.length;
  const count = (predicate: (detail: Detail) => boolean) => details.filter(predicate).length;
  const goldParts = details.reduce((sum, detail) => sum + detail.canonical.length, 0);
  const producedParts = details.reduce((sum, detail) => sum + detail.actualNorm.length, 0);
  const truePositives = details.reduce((sum, detail) => sum + detail.truePositives, 0);
  const precision = rate(truePositives, producedParts), recall = rate(truePositives, goldParts);
  return {
    cases: total,
    strictExact: rate(count((detail) => detail.strictExactMatch), total),
    tolerantExact: rate(count((detail) =>
      detail.tolerantPartitionMatch && detail.coreLossGainNeutral), total),
    countAccuracy: rate(count((detail) => detail.countMatch), total),
    underSplits: count((detail) => detail.underSplit),
    overSplits: count((detail) => detail.overSplit),
    precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    goldParts, producedParts, truePositives,
    charNeutral: rate(count((detail) => detail.charCountNeutral), total),
    coreLossGainNeutral: rate(count((detail) => detail.coreLossGainNeutral), total),
    coreLossCases: count((detail) => detail.coreLossChars > 0),
    coreGainCases: count((detail) => detail.coreGainChars > 0),
  };
}

function pinpointLane() {
  const rows = loadPinpointGold();
  const scored = rows.map((row) => {
    const native = nativePinpoints(row.partText);
    const gold = goldPinpoints(row);
    const fragmentKinds = new Set(["paragraph", "section"]);
    const goldFragments = gold.filter((pin) => fragmentKinds.has(pin.kind));
    const nativeFragments = native.filter((pin) => fragmentKinds.has(pin.kind));
    const key = (pin: { kind: string; value: string }) => `${pin.kind}:${pin.value}`;
    return {
      id: row.id, kind: row.kind, partText: row.partText,
      gold, native,
      fragmentFirstMatch: (goldFragments[0] ? key(goldFragments[0]) : "") ===
        (nativeFragments[0] ? key(nativeFragments[0]) : ""),
      pagesMatch: sameSet(
        endpointNormalized(gold.filter((pin) => pin.kind === "page")),
        endpointNormalized(native.filter((pin) => pin.kind === "page"))),
      allMatch: sameSet(endpointNormalized(gold), endpointNormalized(native)),
      hasGold: gold.length > 0, hasNative: native.length > 0,
    };
  });
  const total = scored.length;
  const withGold = scored.filter((row) => row.hasGold);
  return {
    scored,
    summary: {
      parts: total,
      partsWithGoldPinpoints: withGold.length,
      fragmentFirstMatch: rate(scored.filter((row) => row.fragmentFirstMatch).length, total),
      pagesMatch: rate(scored.filter((row) => row.pagesMatch).length, total),
      endpointExact: rate(scored.filter((row) => row.allMatch).length, total),
      recallOnGoldPinpoints: rate(withGold.filter((row) => row.hasNative).length, withGold.length),
      falsePositiveParts: scored.filter((row) => !row.hasGold && row.hasNative).length,
    },
  };
}

/**
 * Per-authority detection coverage: does the native detector anchor at all on a
 * single gold citation? Grouped by the ALR field gold's `kind`, this separates
 * "the splitter cut in the wrong place" from "this authority family is invisible".
 */
function coverageByKind() {
  const native = structureNative();
  const buckets = new Map<string, { total: number; citation: number; reference: number }>();
  for (const row of loadPinpointGold()) {
    const bucket = buckets.get(row.kind) ?? { total: 0, citation: 0, reference: 0 };
    bucket.total += 1;
    if (native.citationOccurrencesInText(row.partText).length) bucket.citation += 1;
    else if (native.authorityReferencesInText(row.partText).length) bucket.reference += 1;
    buckets.set(row.kind, bucket);
  }
  return [...buckets].sort((left, right) => right[1].total - left[1].total);
}

/** Split the failures into the ones the detector caused and the ones the cut rule caused. */
function taxonomy(details: Detail[]) {
  const misses = details.filter((detail) => !detail.strictExactMatch);
  const rows: Array<[string, number]> = [
    ["exact", details.length - misses.length],
    ["collapsed to one part (no second anchor found)",
      misses.filter((detail) => detail.actualCount === 1 && detail.expectedCount > 1).length],
    ["partial undersplit (some anchors found)",
      misses.filter((detail) => detail.actualCount > 1 && detail.underSplit).length],
    ["oversplit", misses.filter((detail) => detail.overSplit).length],
    ["right part count, wrong boundary",
      misses.filter((detail) => !detail.underSplit && !detail.overSplit).length],
  ];
  return rows.map(([label, count]) =>
    `| ${label} | ${count} | ${percent(rate(count, details.length))} |`);
}

const clip = (value: string, width = 150) =>
  (value.length > width ? `${value.slice(0, width)}…` : value).replace(/\|/gu, "\\|");

function missReport(details: Detail[], top: number) {
  const failures = details.filter((detail) => !detail.tolerantPartitionMatch ||
    !detail.coreLossGainNeutral);
  const ranked = [...failures].sort((left, right) =>
    (right.coreLossChars + right.coreGainChars) - (left.coreLossChars + left.coreGainChars) ||
    Math.abs(right.expectedCount - right.actualCount) -
      Math.abs(left.expectedCount - left.actualCount));
  return ranked.slice(0, top).map((detail, index) => [
    `### ${index + 1}. ${detail.id} (${detail.sourceDoc || "seed"})`,
    `- expected ${detail.expectedCount} part(s), produced ${detail.actualCount}` +
      `${detail.underSplit ? " — **undersplit**" : detail.overSplit ? " — **oversplit**" : ""}` +
      `; core loss ${detail.coreLossChars}, gain ${detail.coreGainChars}` +
      `${detail.tags.length ? `; tags: ${detail.tags.join(", ")}` : ""}`,
    `- footnote: \`${clip(detail.text, 320)}\``,
    ...detail.canonical.map((part, order) => `- gold[${order}]: \`${clip(part)}\``),
    ...detail.actualNorm.map((part, order) => `- beaver[${order}]: \`${clip(part)}\``),
    "",
  ].join("\n"));
}

const scorecardRow = (name: string, summary: ReturnType<typeof summarize>) =>
  `| ${name} | ${summary.cases} | ${percent(summary.strictExact)} | ` +
  `${percent(summary.tolerantExact)} | ${percent(summary.countAccuracy)} | ` +
  `${summary.underSplits} | ${summary.overSplits} | ${percent(summary.precision)} | ` +
  `${percent(summary.recall)} | ${percent(summary.f1)} | ` +
  `${percent(summary.coreLossGainNeutral)} |`;

function main() {
  const sections: string[] = [];
  const scorecard: string[] = [];
  const allDetails: Array<{ file: string; details: Detail[] }> = [];
  for (const file of goldFiles) {
    const rows = loadSplitGold(file);
    const details = runSplit(limit ? rows.slice(0, limit) : rows);
    allDetails.push({ file, details });
    scorecard.push(scorecardRow(file, summarize(details)));
  }
  const pinpoints = pinpointLane();
  const headline = allDetails[0];
  const summary = summarize(headline.details);

  sections.push("# Authorities split benchmark — Beaver native splitter vs ALR gold", "",
    `Run ${new Date().toISOString().slice(0, 19)}Z · gold root \`${alrRoot()}\` · ` +
    "lane: deterministic (native addon, no model).", "",
    "## Scorecard", "",
    "| gold file | cases | strict exact | tolerant exact | count | undersplit | " +
    "oversplit | span P | span R | span F1 | char-neutral |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scorecard, "",
    "`strict exact` = produced partition equals the canonical gold partition after " +
    "whitespace/trailing-semicolon normalization. `tolerant exact` additionally accepts " +
    "any `acceptable_partitions` entry, but only when the split is character-neutral " +
    "(ALR's rule). `span P/R/F1` matches produced parts against gold parts as multisets " +
    "of normalized text. `char-neutral` is ALR's `core_loss_gain_neutral`.", "",
    "## Pinpoint lane (`field_gold_provisional.jsonl`)", "",
    "| metric | value |", "| --- | --- |",
    `| gold parts scored | ${pinpoints.summary.parts} |`,
    `| parts whose gold has pinpoints | ${pinpoints.summary.partsWithGoldPinpoints} |`,
    `| first paragraph/section fragment matches | ${percent(pinpoints.summary.fragmentFirstMatch)} |`,
    `| page pinpoints match (range endpoints) | ${percent(pinpoints.summary.pagesMatch)} |`,
    `| all pinpoints match (range endpoints) | ${percent(pinpoints.summary.endpointExact)} |`,
    `| parts with gold pinpoints where Beaver found any | ${percent(pinpoints.summary.recallOnGoldPinpoints)} |`,
    `| parts with no gold pinpoint where Beaver emitted one | ${pinpoints.summary.falsePositiveParts} |`,
    "", `## Failure taxonomy (${headline.file})`, "",
    "| outcome | cases | share |", "| --- | --- | --- |", ...taxonomy(headline.details), "",
    "## Detection coverage per authority family", "",
    "One gold citation in, does the native detector anchor on it at all? " +
    "Families at 0% cannot be split apart from their neighbours at any boundary rule.", "",
    "| kind (ALR field gold) | gold parts | citation hit | supra/ibid only | anchored |",
    "| --- | --- | --- | --- | --- |",
    ...coverageByKind().map(([kind, bucket]) =>
      `| ${kind || "(unlabelled)"} | ${bucket.total} | ${bucket.citation} | ` +
      `${bucket.reference} | ${percent(rate(bucket.citation + bucket.reference, bucket.total))} |`),
    "", `## Worst 20 misses (${headline.file})`, "",
    ...missReport(headline.details, 20));

  mkdirSync(detailsDir, { recursive: true });
  for (const { file, details } of allDetails) {
    writeFileSync(path.join(detailsDir, `${file.replace(/\.jsonl$/u, "")}.details.jsonl`),
      details.map((detail) => JSON.stringify({ ...detail, text: undefined })).join("\n"));
  }
  writeFileSync(path.join(detailsDir, "pinpoints.details.jsonl"),
    pinpoints.scored.map((row) => JSON.stringify(row)).join("\n"));
  writeFileSync(reportPath, `${sections.join("\r\n")}\r\n`);

  console.log(`${headline.file}: cases=${summary.cases} strict=${percent(summary.strictExact)} ` +
    `tolerant=${percent(summary.tolerantExact)} count=${percent(summary.countAccuracy)} ` +
    `under=${summary.underSplits} over=${summary.overSplits} ` +
    `P=${percent(summary.precision)} R=${percent(summary.recall)} F1=${percent(summary.f1)} ` +
    `charNeutral=${percent(summary.coreLossGainNeutral)}`);
  console.log(`pinpoints: parts=${pinpoints.summary.parts} ` +
    `fragment1=${percent(pinpoints.summary.fragmentFirstMatch)} ` +
    `pages=${percent(pinpoints.summary.pagesMatch)} ` +
    `all=${percent(pinpoints.summary.endpointExact)}`);
  console.log(`report: ${reportPath}`);
}

main();
