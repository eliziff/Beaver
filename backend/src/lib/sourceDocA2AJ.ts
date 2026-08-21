import type { SourceDoc } from "./sourceDoc";

export type CompileInput = {
  citation: string;
  docType: "cases" | "laws";
  text: string;
  id?: string;
  structureDocumentId?: string;
  url?: string | null;
  dataset?: string | null;
  name?: string | null;
  alternateCitation?: string | null;
  sectionMap?: Record<string, string> | null;
};

export type A2AJStructureSummary = {
  status: "usable" | "unavailable";
  source: "flat_text" | "section_map";
  counts: { paragraph: number; page: number; section: number };
};

export function summarizeA2AJSourceDoc(doc: SourceDoc): A2AJStructureSummary {
  return {
    status: doc.status,
    source: doc.blocks.some(({ origin }) => origin === "native")
      ? "section_map"
      : "flat_text",
    counts: {
      paragraph: doc.ranges.paragraph.count,
      page: doc.ranges.page.count,
      section: doc.ranges.section.count,
    },
  };
}
