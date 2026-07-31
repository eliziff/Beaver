/**
 * Benchmark case construction for the legal-grounding experiment family.
 *
 * PROVISIONAL, BENCHMARK-TESTED ONLY. Lifted out of
 * `scripts/legal-grounding-experiment.ts` unchanged when the
 * checker-family crossing needed the SAME question text the banked runs
 * composed against: run receipts store the answer and the evidence but not
 * the prompt, so a re-check has to rebuild the item. A second copy of these
 * builders would silently drift from the runs it is re-checking, which is
 * exactly the class of defect this program keeps finding.
 *
 * Reads public benchmark files in place; downloads and vendors nothing.
 */
import { readFileSync } from "node:fs";

import JSZip from "jszip";

import type {
  LegalEvidenceReceipt,
  LegalSourceClass,
} from "./chat/legalEvidenceExperiment";

export type Suite = "cslb" | "clerc" | "housing";

export type EvidenceSpec = {
  stableSourceId: string;
  sourceText: string;
  spanText: string;
  citation: string;
  name?: string | null;
  dataset: string;
  version?: string | null;
  externalUrl?: string | null;
  locatorKind?: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabel: string;
};

export type BenchmarkCase = {
  id: string;
  suite: Suite;
  jurisdiction: "CA" | "US";
  sourceClass: LegalSourceClass;
  prompt: string;
  target: string;
  expectedAnswer?: "yes" | "no";
  adversarial: boolean;
  goldKind:
    | "benchmark_target"
    | "benchmark_adversarial_target"
    | "opinion_derived_continuation"
    | "expert_annotated_answer";
  referenceExpectation?: "sufficient" | "insufficient";
  evidence: EvidenceSpec[];
};

export function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

type CslbRow = {
  id: string;
  task: string;
  split: string;
  input_context: string;
  target_text: string;
  is_adversarial: boolean;
  source_citation: string;
  metadata: {
    seed_example_id?: string;
    source_type?: "case_law" | "legislation";
    a2aj_dataset?: string;
    document_name?: string;
    document_date?: string;
    source_url?: string;
    anchor_kind?: "paragraph" | "section";
    anchor_id?: string;
  };
};

export function cslbCases(
  file: string,
  split: string,
  perSource: number,
): BenchmarkCase[] {
  const all = readJsonl<CslbRow>(file);
  const byId = new Map(all.map((row) => [row.id, row]));
  const rows = all.filter(
    (row) =>
      row.split === split &&
      row.task === "pinpoint_summarization_similarity",
  );
  const ordinary = (sourceType: CslbRow["metadata"]["source_type"]) =>
    rows
      .filter(
        (row) =>
          !row.is_adversarial && row.metadata.source_type === sourceType,
      )
      .slice(0, perSource);
  const selected = [
    ...ordinary("case_law"),
    ...ordinary("legislation"),
    ...rows.filter((row) => row.is_adversarial).slice(0, perSource),
  ];
  return selected.map((row) => {
    const source =
      (row.metadata.seed_example_id &&
        byId.get(row.metadata.seed_example_id)) ||
      row;
    const metadata = source.metadata;
    const sourceClass =
      metadata.source_type === "legislation" ? "legislation" : "case";
    if (
      !metadata.a2aj_dataset ||
      !metadata.anchor_kind ||
      !metadata.anchor_id
    ) {
      throw new Error(`CSLB ${row.id} has no exact source anchor`);
    }
    return {
      id: `cslb:${row.id}`,
      suite: "cslb",
      jurisdiction: "CA",
      sourceClass,
      prompt: row.input_context,
      target: row.target_text,
      adversarial: row.is_adversarial,
      goldKind: row.is_adversarial
        ? "benchmark_adversarial_target"
        : "benchmark_target",
      evidence: [
        {
          stableSourceId: `cslb:${source.id}`,
          sourceText: source.target_text,
          spanText: source.target_text,
          citation: row.source_citation,
          name: metadata.document_name,
          dataset: `CSLB/${metadata.a2aj_dataset}`,
          version: metadata.document_date,
          externalUrl: metadata.source_url,
          locatorKind: metadata.anchor_kind,
          locatorLabel: metadata.anchor_id,
        },
      ],
    };
  });
}

type ClercRow = {
  docid: string;
  previous_text: string;
  gold_text: string;
  citations: [string, string][];
  short_citations: string[];
};

export function clercCases(file: string, count: number): BenchmarkCase[] {
  const selected: BenchmarkCase[] = [];
  for (const row of readJsonl<ClercRow>(file)) {
    if (
      selected.length >= count ||
      row.gold_text.length > 2_000 ||
      row.gold_text.length < 120 ||
      row.short_citations.length < 1 ||
      row.short_citations.length > 2
    ) {
      continue;
    }
    const fullByCitation = new Map(row.citations);
    const evidence = row.short_citations.flatMap((entry, index) => {
      const separator = entry.indexOf("\n\n");
      if (separator < 1) return [];
      const citation = entry.slice(0, separator).trim();
      const spanText = entry.slice(separator + 2).trim();
      const sourceText = fullByCitation.get(citation);
      if (!sourceText || spanText.length > 3_500) return [];
      return [
        {
          stableSourceId: `clerc:${row.docid}:${index}`,
          sourceText,
          spanText,
          citation,
          dataset: "CLERC/generation-test",
          locatorKind: "paragraph" as const,
          locatorLabel: "cited passage",
        },
      ];
    });
    if (evidence.length !== row.short_citations.length) continue;
    selected.push({
      id: `clerc:${row.docid}`,
      suite: "clerc",
      jurisdiction: "US",
      sourceClass: "case",
      prompt:
        "Continue this U.S. legal analysis using only the supplied authorities:\n\n" +
        row.previous_text.slice(-2_500),
      target: row.gold_text,
      adversarial: false,
      goldKind: "opinion_derived_continuation",
      evidence,
    });
  }
  return selected;
}

type HousingRow = {
  idx: number;
  state: string;
  question: string;
  answer: "Yes" | "No";
  statutes: Array<{
    statute_idx: number;
    citation: string;
    excerpt: string;
  }>;
};

export async function housingCases(
  file: string,
  ids: number[],
): Promise<BenchmarkCase[]> {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const member = zip.file("questions.json");
  if (!member) throw new Error("HousingQA zip has no questions.json");
  const rows = JSON.parse(await member.async("string")) as HousingRow[];
  const byId = new Map(rows.map((row) => [row.idx, row]));
  return ids
    .map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error(`HousingQA row not found: ${id}`);
      return row;
    })
    .filter((row) => {
      if (
        row.statutes.length >= 1 &&
        row.statutes.length <= 3 &&
        row.statutes.reduce(
          (total, statute) => total + statute.excerpt.length,
          0,
        ) <= 3_500
      ) {
        return true;
      }
      throw new Error(`HousingQA row ${row.idx} exceeds evidence limits`);
    })
    .map((row) => ({
      id: `housing:${row.idx}`,
      suite: "housing" as const,
      jurisdiction: "US" as const,
      sourceClass: "legislation" as const,
      prompt:
        `Consider statutory law for ${row.state} in 2021. ` +
        `${row.question} Answer yes or no, explain briefly, and cite the statute inline.`,
      target: row.answer,
      expectedAnswer: row.answer.toLowerCase() as "yes" | "no",
      adversarial: false,
      goldKind: "expert_annotated_answer" as const,
      // Row 163 directly states the seven-business-day condition. Row 0
      // supplies only a definition of "premises", which cannot establish the
      // benchmark's broader proposition that eviction law exists.
      referenceExpectation:
        row.idx === 0 ? ("insufficient" as const) : ("sufficient" as const),
      evidence: row.statutes.map((statute) => ({
        stableSourceId: `housing:${statute.statute_idx}`,
        sourceText: statute.excerpt,
        spanText: statute.excerpt,
        citation: statute.citation,
        dataset: "HousingQA/questions",
        version: "2021",
        locatorKind: "section" as const,
        locatorLabel: statute.citation,
      })),
    }));
}
