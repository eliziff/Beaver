import { describe, expect, it } from "vitest";
import {
  researchLabelPath,
  sourceMatchesLabel,
  type ResearchSource,
} from "./researchSets";

const labels = {
  root: { id: "root", name: "Administrative law", parentId: null, color: null },
  child: { id: "child", name: "Fairness", parentId: "root", color: "#991b1b" },
};

const source: ResearchSource = {
  id: "source",
  reference: { provider: "a2aj", id: "case", kind: "case" },
  labelIds: ["child"],
  note: "",
};

describe("research set views", () => {
  it("computes nested label paths and ancestor filters without stored copies", () => {
    expect(researchLabelPath(labels, "child").map(({ name }) => name))
      .toEqual(["Administrative law", "Fairness"]);
    expect(sourceMatchesLabel(source, "root", labels)).toBe(true);
  });

  it("stops safely when malformed label data contains a cycle", () => {
    const cyclic = {
      a: { id: "a", name: "A", parentId: "b", color: null },
      b: { id: "b", name: "B", parentId: "a", color: null },
    };
    expect(researchLabelPath(cyclic, "a")).toHaveLength(2);
  });
});
