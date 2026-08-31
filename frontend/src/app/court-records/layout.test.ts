import { describe, expect, it } from "vitest";
import { INDEX_ROWS_PER_PAGE, indexChunks, indexPageCount } from "./layout";

describe("court record index layout", () => {
  it("counts group headings as rows and repeats the heading after a page break", () => {
    const items = Array.from({ length: INDEX_ROWS_PER_PAGE }, (_, index) => ({
      id: String(index),
      group: index < 12 ? "Part 1" : "Part 2",
    }));

    const chunks = indexChunks(items);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(23);
    expect(chunks[1]).toHaveLength(2);
    expect(chunks[1][0].group).toBe("Part 2");
    expect(indexPageCount(items)).toBe(2);
  });

  it("always produces one index page for an empty generated record", () => {
    expect(indexChunks([])).toEqual([[]]);
    expect(indexPageCount([])).toBe(1);
  });
});
