import { describe, expect, it } from "vitest";

import { collapseProvisionLabels } from "./provisionLabels";

describe("collapseProvisionLabels", () => {
  it.each([
    ["paragraph", ["par12", "par13", "par13", "par14"], ["12–14"]],
    ["page", ["page60", "page61", "page62", "page63"], ["60–63"]],
    ["footnote", ["fn8", "fn9", "fn11"], ["8–9", "11"]],
    ["paragraph", ["par8", "par7", "par11"], ["7–8", "11"]],
    ["section", ["sec49(1)", "sec49(2)", "sec49(3)", "sec49(4)"], ["49(1)–49(4)"]],
  ] as const)("deduplicates and collapses %s locators", (kind, labels, expected) => {
    expect(collapseProvisionLabels(labels, kind)).toEqual(expected);
  });
});
