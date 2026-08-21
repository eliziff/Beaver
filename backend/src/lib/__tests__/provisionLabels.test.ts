import { describe, expect, it } from "vitest";
import { collapseProvisionLabels } from "../provisionLabels";

describe("collapseProvisionLabels", () => {
  it("drops provisions nested under a present parent and pairs endpoints", () => {
    expect(
      collapseProvisionLabels(
        ["49(1)", "49(2)", "49(2)(a)", "49(2)(b)", "49(3)", "49(4)"],
        "section",
      ),
    ).toEqual(["49(1)\u201349(4)"]);
  });

  it("keeps the full Divorce Act ladder as one outer range", () => {
    expect(
      collapseProvisionLabels(
        [
          "17(1)", "17(1)(a)", "17(1)(b)", "17(1)(b)(i)",
          "17(2)", "17(2.1)", "17(3)", "17(4)", "17(4.1)", "17(5)",
          "17(6)", "17(7)", "17(8)", "17(9)", "17(10)", "17(11)",
        ],
        "section",
      ),
    ).toEqual(["17(1)\u201317(11)"]);
  });

  it("renders different root sections as separate groups", () => {
    expect(
      collapseProvisionLabels(
        ["48(1)", "48(2)", "49(1)", "49(2)(a)", "49(3)"],
        "section",
      ),
    ).toEqual(["48(1)\u201348(2)", "49(1)\u201349(3)"]);
  });

  it("pairs a dashed range label back onto itself", () => {
    expect(
      collapseProvisionLabels(["49(1)\u201349(4)"], "section"),
    ).toEqual(["49(1)\u201349(4)"]);
  });

  it("run-lengths consecutive paragraphs and keeps gaps visible", () => {
    expect(collapseProvisionLabels(["1", "2", "3"], "paragraph")).toEqual([
      "1\u20133",
    ]);
    expect(collapseProvisionLabels(["1", "4"], "paragraph")).toEqual([
      "1",
      "4",
    ]);
    expect(
      collapseProvisionLabels(["29", "30", "33", "36"], "paragraph"),
    ).toEqual(["29\u201330", "33", "36"]);
  });

  it("returns null for labels outside the kind grammar", () => {
    expect(collapseProvisionLabels(["Damages"], "section")).toBeNull();
    expect(collapseProvisionLabels(["par254"], "paragraph")).toBeNull();
    expect(collapseProvisionLabels([], "section")).toBeNull();
    expect(collapseProvisionLabels(["8"], "page")).toBeNull();
  });
});
