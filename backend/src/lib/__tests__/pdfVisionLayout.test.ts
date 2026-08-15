import { describe, expect, it } from "vitest";
import { normalizePageLayout } from "../pdfVisionLayout";

const page = {
  index: 2,
  number: 3,
  width: 600,
  height: 800,
  lines: [
    { id: "a", text: "Reasons for Judgment", bbox: [10, 10, 300, 30] as [number, number, number, number] },
    { id: "b", text: "The court concludes...", bbox: [10, 40, 500, 60] as [number, number, number, number] },
  ],
};

describe("PDF vision layout contract", () => {
  it("keeps submitted regions and safely covers omitted lines as text", () => {
    expect(
      normalizePageLayout(
        {
          id: "call-1",
          name: "submit_page_layout",
          input: {
            page_index: 2,
            regions: [
              { type: "paragraph_title", reading_order: 1, line_ids: ["a"] },
            ],
          },
        },
        page,
      ),
    ).toEqual({
      page_index: 2,
      regions: [
        { type: "paragraph_title", reading_order: 1, line_ids: ["a"] },
        { type: "text", reading_order: 2, line_ids: ["b"] },
      ],
    });
  });

  it("rejects hallucinated or repeated line IDs", () => {
    expect(() =>
      normalizePageLayout(
        {
          id: "call-1",
          name: "submit_page_layout",
          input: {
            page_index: 2,
            regions: [{ type: "text", reading_order: 1, line_ids: ["missing"] }],
          },
        },
        page,
      ),
    ).toThrow(/invalid line ID/u);
  });
});
