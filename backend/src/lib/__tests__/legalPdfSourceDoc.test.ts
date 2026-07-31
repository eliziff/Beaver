import { describe, expect, it } from "vitest";

import { lookupSourceDoc } from "../sourceDoc";
import {
  compileLegalPdfSourceDoc,
  LEGAL_PDF_DOCUMENT_SCHEMA,
  LOCAL_PDF_SOURCE_SCHEMA,
} from "../legalPdfSourceDoc";

const rows = {
  manifest: {
    schema_version: LEGAL_PDF_DOCUMENT_SCHEMA,
    document_id: "pdf-1",
  },
  pages: [
    { id: "page-1", index: 0, number: 1, printed_label: "101" },
    { id: "page-2", index: 1, number: 2, printed_label: "102" },
  ],
  paragraphs: [
    {
      id: "paragraph-1",
      page_index: 0,
      text: "Section 7 — Rights",
    },
    {
      id: "paragraph-2",
      page_index: 0,
      text: "The first body paragraph.",
    },
    {
      id: "paragraph-3",
      page_index: 1,
      text: "The second body paragraph. ⟦FN:pair-1⟧",
    },
  ],
  sections: [
    {
      id: "section-7",
      heading_paragraph_id: "paragraph-1",
      locator: "7",
      aliases: ["section 7", "Section 7 — Rights"],
      paragraph_ids: ["paragraph-1", "paragraph-2", "paragraph-3"],
      provenance: "heading-region",
    },
  ],
  footnotes: [
    {
      pair_id: "pair-1",
      label: "1",
      body: "The paired note body.",
    },
  ],
};

describe("legal PDF SourceDoc adapter", () => {
  it("uses the engine's paragraph, page, section, and note records once", () => {
    const doc = compileLegalPdfSourceDoc(rows);

    expect(doc.text).toContain("[page 101]");
    expect(doc.text).toContain("[page 102]");
    expect(doc.text).not.toContain("⟦FN:");
    expect(lookupSourceDoc(doc, "section", "7")).toMatchObject({
      status: "found",
      block: {
        anchor: "section-7",
        text: expect.stringContaining("The second body paragraph."),
      },
    });
    expect(lookupSourceDoc(doc, "page", "101")).toMatchObject({
      status: "found",
      block: { anchor: "page=1" },
    });
    expect(lookupSourceDoc(doc, "footnote", "1")).toMatchObject({
      status: "found",
      block: { anchor: "pair-1", text: "The paired note body." },
    });
  });

  it("refuses an obsolete artifact instead of silently reparsing it", () => {
    expect(() =>
      compileLegalPdfSourceDoc({
        ...rows,
        manifest: { ...rows.manifest, schema_version: "legalpdf.document.v1" },
      }),
    ).toThrow("Unsupported legal PDF artifact schema");
  });

  it("accepts Beaver's compact durable PDF source", () => {
    const doc = compileLegalPdfSourceDoc({
      ...rows,
      manifest: {
        ...rows.manifest,
        schema_version: LOCAL_PDF_SOURCE_SCHEMA,
        engine_schema_version: LEGAL_PDF_DOCUMENT_SCHEMA,
        artifact_profile: "compact-source",
      },
    });

    expect(lookupSourceDoc(doc, "page", "102")).toMatchObject({
      status: "found",
      block: { anchor: "page=2" },
    });
  });
});
