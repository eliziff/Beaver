import { describe, expect, it } from "vitest";

import { crossReferenceGraph } from "../legalCrossReference";
import {
  nodeLinks,
  nodeNeighbourhood,
  pageAt,
  pageLabel,
  pageMapFromMarkers,
  pageMapFromSourceDoc,
  pageSections,
  resolvePage,
  referenceHubs,
  selectPages,
} from "../legalDocumentNavigator";
import { compileAgreementSkeleton } from "../legalTextSkeleton";

/**
 * Front matter numbered separately from the body is the case that decides
 * the page contract: "iv" is a printed label, not a position, and a table of
 * contents cites the label.
 */
const AGREEMENT = [
  "[page 1]",
  "",
  "ARTICLE I — DEFINITIONS",
  "",
  '1.01 Definitions. As used herein, "Agreement" means this agreement.',
  "",
  "[page 2]",
  "",
  "ARTICLE II — TERM",
  "",
  "2.01 Term. This Agreement continues until terminated under Section 3.02.",
  "",
  "2.02 Renewal. Subject to Section 2.01, the term renews annually.",
  "",
  "[page iv]",
  "",
  "ARTICLE III — TERMINATION",
  "",
  "3.01 Events. Either party may terminate for cause.",
  "",
  "3.02 Effect. On termination, Section 2.01 ceases to apply.",
  "",
].join("\n");

const skeletonOf = (text: string) => compileAgreementSkeleton(text, "fixture");

/**
 * An artifact-derived map, built the way `compileLegalPdfSourceDoc` builds
 * it: `anchor` carries the PDF page, `aliases` the printed label. Front
 * matter printed "i" makes PDF page 2 the sheet printed "1" — the offset a
 * table of contents silently assumes.
 */
function offsetPagedDoc() {
  const parts = [
    { printed: "i", body: "Front matter." },
    { printed: "1", body: "Body one, first numbered page." },
    { printed: "2", body: "Body two, and more." },
  ];
  let text = "";
  const blocks: Array<{
    kind: string;
    label: string;
    start: number;
    end: number;
    anchor?: string;
    aliases?: string[];
  }> = [];
  for (const [index, part] of parts.entries()) {
    const start = text.length;
    text += `[page ${part.printed}]\n${part.body}\n\n`;
    blocks.push({
      kind: "page",
      label: `page${part.printed}`,
      start,
      end: text.length,
      anchor: `page=${index + 1}`,
      aliases: [String(index + 1), part.printed],
    });
  }
  return { text, doc: { blocks } };
}

describe("pageMapFromMarkers", () => {
  it("reads the printed markers and covers the document contiguously", () => {
    const map = pageMapFromMarkers(AGREEMENT);
    expect(map.source).toBe("markers");
    expect(map.pages.map((page) => page.printedLabel)).toEqual(["1", "2", "iv"]);
    expect(map.pages[0].start).toBe(0);
    expect(map.pages[2].end).toBe(AGREEMENT.length);
    for (const [index, page] of map.pages.entries()) {
      if (index) expect(page.start).toBe(map.pages[index - 1].end);
    }
  });

  /**
   * The renderer prints `printed || physical`, so a bare "2" recovered from
   * text genuinely is both readings at once. Claiming one would invent
   * provenance the text does not carry.
   */
  it("carries a numeric marker under both readings, and a roman one under neither", () => {
    const map = pageMapFromMarkers(AGREEMENT);
    expect(map.pages[1]).toMatchObject({ pdfPage: 2, printedLabel: "2" });
    expect(map.pages[2]).toMatchObject({ pdfPage: null, printedLabel: "iv" });
  });

  it("is our own printed format, not a pattern found in prose", () => {
    expect(
      pageMapFromMarkers("The parties agree that [page 9] is a citation form."),
    ).toEqual({ pages: [], source: "unpaginated" });
  });
});

describe("pageMapFromSourceDoc", () => {
  it("keeps both numbers the engine recorded", () => {
    const { doc } = offsetPagedDoc();
    const map = pageMapFromSourceDoc(doc);
    expect(map.source).toBe("artifact");
    expect(
      map.pages.map((page) => [page.pdfPage, page.printedLabel]),
    ).toEqual([
      [1, "i"],
      [2, "1"],
      [3, "2"],
    ]);
  });

  it("renders a page so the two numbers are never confusable", () => {
    const { doc } = offsetPagedDoc();
    const map = pageMapFromSourceDoc(doc);
    expect(pageLabel(map.pages[1])).toBe('PDF page 2 (printed "1")');
  });
});

describe("resolvePage", () => {
  it("matches the printed label, including roman front matter", () => {
    const found = resolvePage(pageMapFromMarkers(AGREEMENT), AGREEMENT, "iv");
    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.page.ordinal).toBe(3);
    expect(found.text).toContain("ARTICLE III");
    expect(found.text).not.toContain("ARTICLE II —");
  });

  /**
   * THE case this exists for. In a document whose front matter is printed
   * "i", "1" names two different sheets, and a table of contents means the
   * second. Answering with either silently would hand back the wrong page.
   */
  it("refuses a request that names two different sheets", () => {
    const { text, doc } = offsetPagedDoc();
    const map = pageMapFromSourceDoc(doc);
    const lookup = resolvePage(map, text, "1");
    expect(lookup.status).toBe("ambiguous");
    if (lookup.status !== "ambiguous") return;
    expect(lookup.asPdfPage.printedLabel).toBe("i");
    expect(lookup.asPrintedLabel.pdfPage).toBe(2);
  });

  it("takes a qualifier to settle it, in either direction", () => {
    const { text, doc } = offsetPagedDoc();
    const map = pageMapFromSourceDoc(doc);
    const printed = resolvePage(map, text, "printed:1");
    expect(printed.status === "found" && printed.page.pdfPage).toBe(2);
    expect(printed.status === "found" && printed.matchedOn).toBe("printed");
    const pdf = resolvePage(map, text, "pdf:1");
    expect(pdf.status === "found" && pdf.page.printedLabel).toBe("i");
    expect(pdf.status === "found" && pdf.matchedOn).toBe("pdf");
  });

  it("refuses an absent label and reports the range that exists", () => {
    const missing = resolvePage(pageMapFromMarkers(AGREEMENT), AGREEMENT, "9");
    expect(missing).toMatchObject({
      status: "not_found",
      requested: "9",
      count: 3,
    });
  });

  it("separates 'no pages here' from 'no such page'", () => {
    const plain = "1.01 Term. One year.";
    expect(resolvePage(pageMapFromMarkers(plain), plain, "1")).toEqual({
      status: "no_pages",
    });
  });
});

describe("selectPages", () => {
  it("takes a single page, a list and a numeric range", () => {
    const map = pageMapFromMarkers(AGREEMENT);
    const one = selectPages(map, AGREEMENT, "2");
    expect(one.status === "ok" && one.pages.map((page) => page.ordinal)).toEqual([2]);
    const list = selectPages(map, AGREEMENT, "1, iv");
    expect(list.status === "ok" && list.pages.map((page) => page.ordinal)).toEqual([1, 3]);
    const range = selectPages(map, AGREEMENT, "1-2");
    expect(range.status === "ok" && range.pages.map((page) => page.ordinal)).toEqual([1, 2]);
  });

  /**
   * A range across a numbering change cannot be arithmetic on either label,
   * so the endpoints resolve independently and the span is taken by
   * position.
   */
  it("spans a range whose endpoints are not comparable as numbers", () => {
    const { text, doc } = offsetPagedDoc();
    const map = pageMapFromSourceDoc(doc);
    const span = selectPages(map, text, "printed:i - printed:2");
    expect(span.status === "ok" && span.pages.map((page) => page.pdfPage)).toEqual([
      1, 2, 3,
    ]);
  });

  it("propagates an endpoint refusal rather than dropping it", () => {
    const { text, doc } = offsetPagedDoc();
    const failed = selectPages(pageMapFromSourceDoc(doc), text, "1");
    expect(failed.status).toBe("failed");
    if (failed.status !== "failed") return;
    expect(failed.lookup.status).toBe("ambiguous");
  });
});

describe("pageAt", () => {
  it("labels an offset with the page it falls on", () => {
    const map = pageMapFromMarkers(AGREEMENT);
    expect(pageAt(map, AGREEMENT.indexOf("2.02 Renewal"))?.printedLabel).toBe("2");
  });
});

describe("pageSections", () => {
  it("returns the provisions printed on a page, in reading order", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const page = pageMapFromMarkers(AGREEMENT).pages[1];
    expect(pageSections(skeleton, page).starts.map((node) => node.label)).toEqual([
      "art2",
      "sec2.01",
      "sec2.02",
    ]);
  });

  /**
   * A node's span runs to the next heading, so Section 1.01 laps onto page 2
   * by the marker line alone. It is what the page continues FROM, and must
   * never be listed as printed on it.
   */
  it("does not report a section that merely laps over the page boundary", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const page = pageMapFromMarkers(AGREEMENT).pages[1];
    const sections = pageSections(skeleton, page);
    expect(sections.starts.map((node) => node.label)).not.toContain("sec1.01");
    expect(sections.continuedFrom.map((node) => node.label)).toEqual([
      "sec1.01",
      "art1",
    ]);
  });

  it("has nothing to continue from on the first page", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const first = pageMapFromMarkers(AGREEMENT).pages[0];
    expect(pageSections(skeleton, first).continuedFrom).toEqual([]);
  });
});

describe("nodeNeighbourhood", () => {
  it("gives the parent chain, the siblings and the children", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const around = nodeNeighbourhood(skeleton, "sec2.01");
    expect(around).not.toBeNull();
    expect(around!.ancestors.map((node) => node.label)).toEqual(["art2"]);
    expect(around!.siblings.map((node) => node.label)).toEqual(["sec2.02"]);
    expect(around!.children).toEqual([]);

    const article = nodeNeighbourhood(skeleton, "art2");
    expect(article!.children.map((node) => node.label)).toEqual([
      "sec2.01",
      "sec2.02",
    ]);
    // Top-level nodes share an absent parent; siblings stay same-kind so an
    // Article's siblings are Articles rather than every unparented node.
    expect(article!.siblings.map((node) => node.label)).toEqual(["art1", "art3"]);
  });

  it("returns null for a label the skeleton does not carry", () => {
    expect(nodeNeighbourhood(skeletonOf(AGREEMENT), "sec9.99")).toBeNull();
  });
});

describe("nodeLinks", () => {
  it("separates what a provision points at from what points at it", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const graph = crossReferenceGraph(AGREEMENT, "fixture", { skeleton });
    const links = nodeLinks(graph, "sec2.01");
    expect(links.outgoing.map((edge) => edge.targetLabel)).toEqual(["sec3.02"]);
    expect(links.incoming.map((edge) => edge.sourceLabel).sort()).toEqual([
      "sec2.02",
      "sec3.02",
    ]);
  });

  it("never counts a self-reference as an inbound edge", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const graph = crossReferenceGraph(AGREEMENT, "fixture", { skeleton });
    expect(graph.edges.some((edge) => edge.selfLoop)).toBe(true);
    for (const label of ["art1", "art2", "art3"]) {
      expect(nodeLinks(graph, label).incoming).toEqual([]);
    }
  });
});

describe("referenceHubs", () => {
  it("ranks the provisions the document points at most", () => {
    const skeleton = skeletonOf(AGREEMENT);
    const graph = crossReferenceGraph(AGREEMENT, "fixture", { skeleton });
    expect(referenceHubs(graph)[0]).toEqual({ label: "sec2.01", incoming: 2 });
  });
});
