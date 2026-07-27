/**
 * Emit the pinpoint URLs Beaver actually produces for the frozen SourceDoc
 * fixtures, for the Playwright deep-link gate (scripts/deeplink-gate.mjs).
 *
 * One row per host class per locator kind. Every URL is built by the real
 * production link builder from a real compiled block and a quote taken
 * verbatim out of that block - nothing here is hand-written.
 *
 *   npx tsx scripts/build-sourcedoc-gate-urls.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "../src/lib/legalSourceLinks";
import { lookupSourceDoc, sourceDocBlockText } from "../src/lib/sourceDoc";
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
const OUTPUT = path.join(
  __dirname,
  "..",
  "..",
  "benchmarks",
  "sourcedoc",
  "gate-urls.json",
);

type Row = {
  host_class: string;
  locator_kind: string;
  url: string;
  expected_anchor: string | null;
  expected_text: string | null;
  fixture: string;
  block_label: string;
  note?: string;
};

function fixture(name: string) {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
  ) as {
    citation: string;
    docType: "cases" | "laws";
    dataset: string;
    name: string | null;
    url: string;
    text: string;
  };
}

function row(args: {
  hostClass: string;
  fixtureName: string;
  kind: "paragraph" | "section";
  locator: string;
  quote: string | null;
  anchor?: string;
  note?: string;
}): Row {
  const source = fixture(args.fixtureName);
  const doc = compileA2AJSourceDoc({
    citation: source.citation,
    docType: source.docType,
    text: source.text,
    url: source.url,
    dataset: source.dataset,
    name: source.name,
  });
  const found = lookupSourceDoc(doc, args.kind, args.locator);
  if (found.status !== "found" || !found.block) {
    throw new Error(`${args.fixtureName}: ${args.locator} did not resolve`);
  }
  const blockText = sourceDocBlockText(doc, found.block);
  if (args.quote && !blockText.includes(args.quote)) {
    throw new Error(`${args.fixtureName}: quote is not in ${args.locator}`);
  }
  const url = buildLegalSourcePinpointUrl(
    {
      url: source.url,
      anchor: args.anchor,
      blockText,
      documentText: doc.text,
    },
    args.quote ? [args.quote] : [],
  );
  if (!url) throw new Error(`${args.fixtureName}: no URL`);
  return {
    host_class: args.hostClass,
    locator_kind: args.kind,
    url,
    expected_anchor: args.anchor ?? null,
    expected_text: args.quote,
    fixture: args.fixtureName,
    block_label: found.block.label,
    ...(args.note ? { note: args.note } : {}),
  };
}

const rows: Row[] = [
  row({
    hostClass: "decisia",
    fixtureName: "a2aj-case-scc-2026scc16-toc",
    kind: "paragraph",
    locator: "26",
    quote: null,
    anchor: "par26",
    note: "Native Decisia paragraph anchor, no text fragment.",
  }),
  row({
    hostClass: "decisia",
    fixtureName: "a2aj-case-scc-2026scc16-toc",
    kind: "paragraph",
    locator: "26",
    quote:
      "they were married in India on November 28, 1999",
    anchor: "par26",
    note: "Decisia paragraph anchor plus a verified text fragment.",
  }),
  row({
    hostClass: "decisia",
    fixtureName: "a2aj-case-scc-2001scc1-bare",
    kind: "paragraph",
    locator: "6",
    quote: "The appellant, Robert Latimer, farmed in Wilkie, Saskatchewan",
    anchor: "par6",
    note: "Bare-numbered paragraph spine on the same host class.",
  }),
  row({
    hostClass: "laws-lois-xml",
    fixtureName: "a2aj-laws-fed-criminalcode-s231",
    kind: "section",
    locator: "231(4)(a)",
    quote: "acting in the course of his duties",
    note:
      "EXPECTED FAIL. A2AJ's source_url for federal statutes is the raw XML " +
      "file, which renders no anchors and no text fragments. The human page " +
      "is laws-lois.justice.gc.ca/eng/acts/C-46/section-231.html; deriving it " +
      "belongs to the host/anchor table in stage 3.",
  }),
  row({
    hostClass: "laws-lois-xml",
    fixtureName: "a2aj-regs-fed-crc870-a01",
    kind: "section",
    locator: "A.01.001",
    quote: "cited as the Food and Drug Regulations",
    note:
      "EXPECTED FAIL, same cause. Newly indexable now that alphanumeric " +
      "regulation sections compile.",
  }),
  row({
    hostClass: "ontario-ca-api",
    fixtureName: "a2aj-laws-on-occupiers-liability",
    kind: "section",
    locator: "3(1)",
    quote:
      "owes a duty to take such care as in all the circumstances of the case is reasonable",
    note:
      "EXPECTED FAIL. A2AJ's source_url for Ontario laws is the doc-search " +
      "JSON API, not the ontario.ca/laws/statute/90o02 page.",
  }),
  row({
    hostClass: "ontario-ca-api",
    fixtureName: "a2aj-regs-on-oreg267-03",
    kind: "section",
    locator: "5.1",
    quote: null,
    note: "EXPECTED FAIL, same cause; Ontario regulation section spine.",
  }),
];

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`wrote ${rows.length} rows to ${OUTPUT}`);
