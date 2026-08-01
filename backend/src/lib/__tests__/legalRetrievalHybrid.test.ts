import { describe, expect, it } from "vitest";

import { crossReferenceGraph } from "../legalCrossReference";
import type { PageMap } from "../legalDocumentNavigator";
import { documentMap, referenceImpact } from "../legalRetrievalHybrid";
import {
  compileAgreementSkeleton,
  type TableCellSpan,
} from "../legalTextSkeleton";

const TABLE_TEXT = [
  "ARTICLE I",
  "AUTHORITY",
  "",
  "Section 1.01 Signing limits.",
  "Officer",
  "$10,000",
  "Secretary",
  "$20,000",
  "",
  "Section 1.02 Notices.",
  "Notice shall be written.",
].join("\n");

function cell(
  table: number,
  row: number,
  column: number,
  value: string,
): TableCellSpan {
  const start = TABLE_TEXT.indexOf(value);
  return { table, row, column, start, end: start + value.length };
}

const TABLE_CELLS = [
  cell(1, 1, 1, "Officer"),
  cell(1, 1, 2, "$10,000"),
  cell(1, 2, 1, "Secretary"),
  cell(1, 2, 2, "$20,000"),
];

const AGREEMENT = [
  "ARTICLE VIII",
  "INDEMNITIES",
  "",
  "8.01 Vendor Indemnity. Recovery is subject to the limitations in Section 8.05.",
  "",
  "8.02 Purchaser Indemnity. This obsolete provision shall be deleted.",
  "",
  "8.03 Notice of Claim. The Vendor shall give notice promptly.",
  "",
  "8.04 Defence of Third Party Claims. A party notified under Section 8.03 may defend.",
  "",
  "8.05 Limitations. Recovery under Section 8.04 is capped.",
  "",
  "8.06 Survival. Section 8.01 survives Closing.",
].join("\n");

describe("documentMap", () => {
  const skeleton = compileAgreementSkeleton(TABLE_TEXT, "table-map", {
    recoverExtraction: false,
    tableCells: TABLE_CELLS,
  });
  const split = TABLE_TEXT.indexOf("Section 1.02");
  const pageMap: PageMap = {
    source: "artifact",
    pages: [
      {
        ordinal: 1,
        pdfPage: 1,
        printedLabel: "i",
        start: 0,
        end: split,
      },
      {
        ordinal: 2,
        pdfPage: 2,
        printedLabel: "1",
        start: split,
        end: TABLE_TEXT.length,
      },
    ],
  };

  it("returns round-tripping table, row, and cell Read recipes", () => {
    const result = documentMap({
      text: TABLE_TEXT,
      skeleton,
      pageMap,
      focus: "tables",
    });

    expect(result.failures).toEqual([]);
    expect(result.rows.map((row) => row.label)).toEqual([
      "table:1",
      "table:1/row:1",
      "table:1/row:1/col:1",
      "table:1/row:1/col:2",
      "table:1/row:2",
      "table:1/row:2/col:1",
      "table:1/row:2/col:2",
    ]);
    expect(result.rows.every((row) => "section" in row.read)).toBe(true);
  });

  it("maps both page-number senses to exact line windows", () => {
    const result = documentMap({
      text: TABLE_TEXT,
      skeleton,
      pageMap,
      focus: "pages",
    });

    expect(result.rows).toEqual([
      expect.objectContaining({
        label: "pdf:1",
        pdf: "pdf:1",
        printed: "printed:i",
        read: { offset: 1, limit: 8 },
      }),
      expect.objectContaining({
        label: "pdf:2",
        pdf: "pdf:2",
        printed: "printed:1",
        read: { offset: 10, limit: 2 },
      }),
    ]);
  });

  it("filters deterministically, caps rows, and falls back from bad handles", () => {
    const queried = documentMap({
      text: TABLE_TEXT,
      skeleton,
      pageMap,
      focus: "provisions",
      query: "notices",
      maxResults: 1,
    });
    expect(queried.rows).toEqual([
      expect.objectContaining({ label: "sec1.02", read: { section: "sec1.02" } }),
    ]);

    const broken = {
      ...skeleton,
      nodes: skeleton.nodes.map((node) =>
        node.label === "sec1.02" ? { ...node, label: "sec9.99" } : node,
      ),
    };
    const fallback = documentMap({
      text: TABLE_TEXT,
      skeleton: broken,
      pageMap,
      focus: "provisions",
      query: "notices",
    });
    expect(fallback.rows).toEqual([
      expect.objectContaining({ label: "sec9.99", read: { offset: 10, limit: 2 } }),
    ]);
    expect(JSON.stringify(fallback).length).toBeLessThanOrEqual(4_000);
  });

  it("refuses mismatched coordinate planes and absent pages", () => {
    expect(
      documentMap({
        text: `${TABLE_TEXT}!`,
        skeleton,
        pageMap,
        focus: "tables",
      }).failures,
    ).toEqual([{ code: "text_skeleton_mismatch" }]);
    expect(
      documentMap({
        text: TABLE_TEXT,
        skeleton,
        pageMap: { pages: [], source: "unpaginated" },
        focus: "pages",
      }).failures,
    ).toEqual([{ code: "pages_unavailable" }]);
  });
});

describe("referenceImpact", () => {
  const skeleton = compileAgreementSkeleton(AGREEMENT, "impact", {
    recoverExtraction: false,
  });
  const graph = crossReferenceGraph(AGREEMENT, "impact", { skeleton });

  it("returns literal inbound and outbound pointer locations", () => {
    const inbound = referenceImpact({
      text: AGREEMENT,
      skeleton,
      graph,
      targets: ["8.03"],
      operation: "inbound",
    });
    expect(inbound.failures).toEqual([]);
    expect(inbound.rows).toContainEqual(
      expect.objectContaining({
        kind: "inbound",
        target: "sec8.03",
        from: "sec8.04",
        to: "sec8.03",
        read: expect.objectContaining({ offset: expect.any(Number), limit: 1 }),
      }),
    );

    const outbound = referenceImpact({
      text: AGREEMENT,
      skeleton,
      graph,
      targets: ["8.04"],
      operation: "outbound",
    });
    expect(outbound.failures).toEqual([]);
    expect(outbound.rows).toContainEqual(
      expect.objectContaining({
        kind: "outbound",
        target: "sec8.04",
        from: "sec8.04",
        to: "sec8.03",
        read: expect.objectContaining({ offset: expect.any(Number), limit: 1 }),
      }),
    );
  });

  it("projects atomic delete-and-close-gap receipts without returning text", () => {
    const result = referenceImpact({
      text: AGREEMENT,
      skeleton,
      graph,
      targets: ["8.02"],
      operation: "delete_and_close_gap",
    });

    expect(result.failures).toEqual([]);
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        kind: "target",
        target: "sec8.02",
        read: { section: "sec8.02" },
      }),
    );
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        kind: "affected_sibling",
        from: "sec8.03",
        to: "sec8.02",
      }),
    );
    expect(result.rows).toContainEqual(
      expect.objectContaining({
        kind: "inbound",
        from: "sec8.03",
        to: "sec8.02",
      }),
    );
    expect(result).not.toHaveProperty("text");
  });

  it("passes through typed planning failures and bounds large impact sets", () => {
    const unsafeText = `${AGREEMENT}\n\n11.01 Other. Recovery is subject to Section 8.02.`;
    const unsafeSkeleton = compileAgreementSkeleton(unsafeText, "unsafe", {
      recoverExtraction: false,
    });
    const unsafeGraph = crossReferenceGraph(unsafeText, "unsafe", {
      skeleton: unsafeSkeleton,
    });
    const unsafe = referenceImpact({
      text: unsafeText,
      skeleton: unsafeSkeleton,
      graph: unsafeGraph,
      targets: ["8.02"],
      operation: "delete_and_close_gap",
    });
    expect(unsafe.failures.map((failure) => failure.code)).toContain(
      "reference_to_deleted_target",
    );

    const manyText = [
      "ARTICLE I",
      "GENERAL",
      ...Array.from({ length: 80 }, (_, index) => {
        const label = `1.${String(index + 1).padStart(2, "0")}`;
        return label === "1.40"
          ? `${label} Hub. This is the hub.`
          : `${label} Pointer. See Section 1.40.`;
      }),
    ].join("\n\n");
    const manySkeleton = compileAgreementSkeleton(manyText, "many", {
      recoverExtraction: false,
    });
    const many = referenceImpact({
      text: manyText,
      skeleton: manySkeleton,
      graph: crossReferenceGraph(manyText, "many", { skeleton: manySkeleton }),
      targets: ["1.40"],
      operation: "inbound",
    });
    expect(many.rows.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(many).length).toBeLessThanOrEqual(4_000);
    expect(many.truncated).toBe(true);
  });

  it("fails closed for unknown targets and mismatched graphs", () => {
    expect(
      referenceImpact({
        text: AGREEMENT,
        skeleton,
        graph,
        targets: ["99.99"],
        operation: "inbound",
      }).failures,
    ).toEqual([{ code: "target_not_found", target: "99.99" }]);

    const otherSkeleton = compileAgreementSkeleton(TABLE_TEXT, "other", {
      recoverExtraction: false,
    });
    expect(
      referenceImpact({
        text: AGREEMENT,
        skeleton,
        graph: crossReferenceGraph(TABLE_TEXT, "other", {
          skeleton: otherSkeleton,
        }),
        targets: ["8.03"],
        operation: "inbound",
      }).failures,
    ).toEqual([{ code: "graph_skeleton_mismatch" }]);
  });
});
