import { describe, expect, it } from "vitest";

import { crossReferenceGraph } from "../../src/lib/legalCrossReference";
import { pageMapFromMarkers } from "../../src/lib/legalDocumentNavigator";
import { compileAgreementSkeleton } from "../../src/lib/legalTextSkeleton";
import {
  nodeLinks,
  nodeNeighbourhood,
  pageAt,
  pageSchemes,
  pageSections,
  referenceHubs,
} from "./navigationViews";

const TEXT = [
  "[page 1]",
  "ARTICLE I DEFINITIONS",
  "Section 1.01 Definitions. See Section 2.01.",
  "[page 2]",
  "ARTICLE II TERM",
  "Section 2.01 Term. See Section 3.01.",
  "Section 2.02 Renewal. See Section 2.01.",
  "[page iv]",
  "ARTICLE III TERMINATION",
  "Section 3.01 Termination. See Section 2.01.",
].join("\n\n");

describe("experimental navigation views", () => {
  const pages = pageMapFromMarkers(TEXT);
  const skeleton = compileAgreementSkeleton(TEXT, "fixture");
  const graph = crossReferenceGraph(TEXT, "fixture", { skeleton });

  it("joins offsets and pages back to structural handles", () => {
    expect(pageSchemes(pages)).toEqual({ pdfPages: true, printedLabels: true });
    expect(pageAt(pages, TEXT.indexOf("2.02 Renewal"))?.ordinal).toBe(2);
    expect(pageSections(skeleton, pages.pages[1]).starts.map(({ label }) => label))
      .toEqual(["art2", "sec2.01", "sec2.02"]);
  });

  it("summarizes tree and graph relationships without changing them", () => {
    expect(nodeNeighbourhood(skeleton, "sec2.01")?.siblings.map(({ label }) => label))
      .toEqual(["sec2.02"]);
    expect(nodeLinks(graph, "sec2.01").incoming).toHaveLength(3);
    expect(referenceHubs(graph)[0]).toEqual({ label: "sec2.01", incoming: 3 });
  });
});
