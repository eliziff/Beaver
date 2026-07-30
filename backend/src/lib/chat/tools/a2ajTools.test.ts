import { describe, expect, it } from "vitest";
import { a2ajActivityLabel } from "./a2ajTools";

describe("a2ajActivityLabel", () => {
  it.each([
    [
      "a2aj_search",
      {
        query: "retroactive support",
        dataset: "BCCA",
        doc_type: "cases",
      },
      "Searching BCCA cases for “retroactive support”",
    ],
    [
      "a2aj_search",
      { query: "  child   support\n guidelines  ", doc_type: "laws" },
      "Searching Canadian legislation for “child support guidelines”",
    ],
    [
      "a2aj_fetch",
      { citation: "RSC 1985, c C-46", doc_type: "laws", section: "718.2" },
      "Reading RSC 1985, c C-46, s. 718.2",
    ],
    [
      "a2aj_lookup",
      {
        citation: "2022 SCC 32",
        locator_type: "paragraph",
        locator: "57",
      },
      "Looking up 2022 SCC 32, para. 57",
    ],
    [
      "a2aj_lookup",
      {
        citation: "2010 BCCA 170",
        locator_type: "paragraph",
        locator: "10",
        end_locator: "12",
      },
      "Looking up 2010 BCCA 170, para. 10\u201312",
    ],
  ])("describes %s calls", (name, args, expected) => {
    expect(a2ajActivityLabel(name, args)).toBe(expected);
  });

  it("leaves unrelated tools alone", () => {
    expect(a2ajActivityLabel("read_document", {})).toBeUndefined();
  });
});
