import {
  fetchLocalA2AJDocument,
  getLocalA2AJStructure,
} from "../../backend/src/lib/a2ajLocalBulk";
import { a2ajLegalSourceProvider } from "../../backend/src/lib/legalSources/a2aj";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
} from "../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";

const CASES: Array<{ citation: string; dataset: string }> = [
  { citation: "2006 BCCA 127", dataset: "BCCA" },
  { citation: "2008 FCA 24", dataset: "FCA" },
  { citation: "2021 SCC 46", dataset: "SCC" },
  { citation: "2021 SCC 47", dataset: "SCC" },
  { citation: "2003 BCCA 332", dataset: "BCCA" },
  { citation: "2015 BCCA 52", dataset: "BCCA" },
  { citation: "2007 BCCA 308", dataset: "BCCA" },
];

for (const { citation, dataset } of CASES) {
  const document = fetchLocalA2AJDocument({
    citation,
    dataset,
    docType: "cases",
    language: "en",
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!document) {
    console.log(`${citation}: not found`);
    continue;
  }
  const source = getLocalA2AJStructure(document) ?? a2ajLegalSourceProvider.source(document);
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const structure = analyzeOpinionStructure({
    text: source.text,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const numbers = paragraphs
    .flatMap((block) => {
      const match = /^par(\d+)$/iu.exec(block.label);
      return match ? [Number(match[1])] : [];
    })
    .sort((a, b) => a - b);
  const partition = partitionOpinionStructure(structure, numbers);
  const summary = {
    status: structure.status,
    refusals: structure.refusals,
    panel: structure.panel,
    bindings: structure.bindings.map((b) => ({
      role: b.role,
      names: b.names,
      concurred: b.concurred,
      range: b.from !== null || b.to !== null ? [b.from, b.to] : null,
      page: b.page,
      line: b.line,
      bodyStart: b.bodyStart,
    })),
    markers: structure.bodyMarkers.slice(0, 10),
    partition: {
      status: partition.status,
      note: partition.note,
      judges: partition.judges,
      spans: partition.spans,
    },
  };
  console.log(`\n===== ${citation} (pars ${numbers[0] ?? "-"}..${numbers.at(-1) ?? "-"}, n=${numbers.length}) =====`);
  console.log(JSON.stringify(summary, null, 1));
}
