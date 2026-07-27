/**
 * Hot-path benchmark for the pinpoint-link stack (master plan P1.1a stage 3).
 *
 * Measures the three paths the performance audit flagged, on real captured
 * A2AJ fixtures compiled by the production compiler:
 *
 *   A1 buildDirective       - one verified text fragment per quote
 *   A2 automaticQuote       - one verified quote per DOCX evidence handle
 *   A3 appendPinpointLinks  - link attachment across N blocks of one document
 *
 *   npx tsx scripts/bench-pinpoint.ts --label before
 *   npx tsx scripts/bench-pinpoint.ts --label after
 *
 * Each case is timed `--runs` times (default 7) and reported by median. When a
 * previous label is present the table prints the speedup, so the same script
 * proves the before/after claim rather than a prose assertion.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendLegalSourcePinpointLinks,
  automaticPinpointQuote,
  buildLegalSourcePinpointUrl,
} from "../src/lib/legalSourceLinks";
import { sourceDocBlockText, type SourceDoc } from "../src/lib/sourceDoc";
import { compileA2AJSourceDoc } from "../src/lib/sourceDocA2AJ";

const FIXTURES = path.join(
  __dirname,
  "..",
  "src",
  "lib",
  "__tests__",
  "fixtures",
  "sourcedoc",
);
const OUTPUT_DIR = path.join(__dirname, "..", "..", "benchmarks", "sourcedoc");

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const LABEL = argument("label", "current");
const RUNS = Math.max(5, Number(argument("runs", "7")));

type Fixture = {
  citation: string;
  docType: "cases" | "laws";
  dataset: string;
  name: string | null;
  url: string;
  text: string;
};

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
  ) as Fixture;
}

function compile(source: Fixture, text = source.text): SourceDoc {
  return compileA2AJSourceDoc({
    citation: source.citation,
    docType: source.docType,
    text,
    url: source.url,
    dataset: source.dataset,
    name: source.name,
  });
}

/**
 * The real Criminal Code is ~2.26 MB; the committed fixture is a trimmed
 * excerpt of it. Repeat the excerpt with unique section numbers to benchmark
 * at the size the live corpus actually has.
 */
function largeStatute(repetitions: number) {
  const excerpt = fixture("a2aj-laws-fed-criminalcode-s231").text;
  const parts: string[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    parts.push(excerpt.replace("**231**", `**${1000 + index * 10}**`));
  }
  return parts.join("\n\n");
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

type Case = {
  name: string;
  unit: string;
  units: number;
  bytes: number;
  run: () => void;
};

/** Words 3..18 of a block: long enough to be quotable, short enough to be real. */
function blockQuote(text: string, from = 3, length = 15) {
  return text
    .trim()
    .replace(/\s+/gu, " ")
    .split(" ")
    .slice(from, from + length)
    .join(" ");
}

function cases(): Case[] {
  const list: Case[] = [];

  const caseSource = fixture("a2aj-case-scc-2026scc16-toc");
  const caseDoc = compile(caseSource);
  const caseBlocks = caseDoc.blocks
    .filter((block) => block.kind === "paragraph")
    .map((block) => sourceDocBlockText(caseDoc, block))
    .filter((text) => text.split(/\s+/u).length > 40);

  const statuteSource = fixture("a2aj-laws-fed-criminalcode-s231");
  const statuteText = largeStatute(640);
  const statuteDoc = compile(statuteSource, statuteText);
  const statuteBlocks = statuteDoc.blocks
    .filter((block) => !block.label.includes("("))
    .map((block) => sourceDocBlockText(statuteDoc, block))
    .filter((text) => text.split(/\s+/u).length > 40)
    .slice(0, 8);

  for (const [name, doc, blocks] of [
    ["case-41kb", caseDoc, caseBlocks],
    ["statute-2.3mb", statuteDoc, statuteBlocks],
  ] as const) {
    const quotes = blocks.slice(0, 20).map((text) => blockQuote(text));
    list.push({
      name: `A1 buildDirective/${name}`,
      unit: "quote",
      units: quotes.length,
      bytes: doc.text.length,
      run: () => {
        quotes.forEach((quote, index) => {
          buildLegalSourcePinpointUrl(
            {
              url: "https://example.test/doc",
              blockText: blocks[index],
              documentText: doc.text,
            },
            [quote],
          );
        });
      },
    });

    const handles = blocks.slice(0, 8);
    list.push({
      name: `A2 automaticQuote/${name}`,
      unit: "handle",
      units: handles.length,
      bytes: doc.text.length,
      run: () => {
        for (const blockText of handles) {
          automaticPinpointQuote({
            url: "https://example.test/doc",
            blockText,
            documentText: doc.text,
          });
        }
      },
    });

    const sources = blocks.slice(0, 16).map((blockText, index) => ({
      key: `block-${index}`,
      label: `Fixture, block ${index}`,
      evidence: {
        url: "https://example.test/doc",
        blockText,
        documentText: doc.text,
      },
    }));
    // Quotes start at the head of the block (where the provision number or
    // paragraph mark sits) so each one is assignable to exactly one source -
    // the case that actually builds links.
    const answer = sources
      .slice(0, 6)
      .map(
        (source) => `As held, “${blockQuote(source.evidence.blockText, 0)}”.`,
      )
      .join("\n\n");
    list.push({
      name: `A3 appendPinpointLinks/${name}`,
      unit: "source",
      units: sources.length,
      bytes: doc.text.length,
      run: () => {
        appendLegalSourcePinpointLinks(answer, sources);
      },
    });
  }

  return list;
}

type Measurement = {
  name: string;
  unit: string;
  units: number;
  bytes: number;
  medianMs: number;
  perUnitMs: number;
  runsMs: number[];
};

function measure(testCase: Case): Measurement {
  testCase.run(); // warm the compiled artifacts and JIT
  const runs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    testCase.run();
    runs.push(performance.now() - started);
  }
  const value = median(runs);
  return {
    name: testCase.name,
    unit: testCase.unit,
    units: testCase.units,
    bytes: testCase.bytes,
    medianMs: value,
    perUnitMs: value / testCase.units,
    runsMs: runs.map((item) => Number(item.toFixed(2))),
  };
}

function previous(label: string): Measurement[] | null {
  try {
    return JSON.parse(
      readFileSync(path.join(OUTPUT_DIR, `bench-pinpoint-${label}.json`), "utf8"),
    ).measurements as Measurement[];
  } catch {
    return null;
  }
}

const measurements = cases().map(measure);
const baseline =
  LABEL === "before" ? null : (previous("before") ?? previous("current"));

const width = Math.max(...measurements.map(({ name }) => name.length));
console.log(
  `${"case".padEnd(width)}  ${"ms/unit".padStart(9)}  ${"total ms".padStart(9)}  ${"vs before".padStart(10)}`,
);
for (const item of measurements) {
  const before = baseline?.find((entry) => entry.name === item.name);
  const speedup = before ? `${(before.perUnitMs / item.perUnitMs).toFixed(1)}x` : "-";
  console.log(
    `${item.name.padEnd(width)}  ${item.perUnitMs.toFixed(3).padStart(9)}  ${item.medianMs.toFixed(1).padStart(9)}  ${speedup.padStart(10)}`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const output = path.join(OUTPUT_DIR, `bench-pinpoint-${LABEL}.json`);
writeFileSync(
  output,
  `${JSON.stringify(
    {
      label: LABEL,
      runs: RUNS,
      node: process.version,
      capturedAt: new Date().toISOString(),
      measurements,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`\nwrote ${output}`);
if (!readdirSync(OUTPUT_DIR).length) process.exitCode = 1;
