import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deleteProvisionAndRenumberSiblings } from "../structureNative";

describe("deleteProvisionAndRenumberSiblings", () => {
  const agreement = [
    "ARTICLE VIII",
    "INDEMNITIES",
    "",
    "8.01 Vendor Indemnity. Recovery is subject to the limitations in Section 8.05.",
    "",
    "8.02 Purchaser Indemnity. The Purchaser shall indemnify the Vendor.",
    "",
    "8.03 Notice of Claim. The Vendor shall give notice promptly.",
    "",
    "8.04 Defence of Third Party Claims. A party notified under Section 8.03 may defend.",
    "",
    "8.05 Limitations. Aggregate liability is capped.",
    "",
    "8.06 Survival. Section 8.01 survives Closing.",
    "",
    "ARTICLE XI",
    "TAX",
    "",
    "11.01 Tax Indemnity. Recovery is subject to Section 8.05.",
    "",
    "11.02 Tax Contests. Notice shall be prompt.",
    "",
    "11.03 Cooperation. Each party shall cooperate.",
  ].join("\n");

  it("deletes a clause and updates its siblings and references atomically", async () => {
    const result = await deleteProvisionAndRenumberSiblings(agreement, "8.02");
    expect(result.failures).toEqual([]);
    expect(result.mapping).toEqual([
      { from: "sec8.03", to: "sec8.02" },
      { from: "sec8.04", to: "sec8.03" },
      { from: "sec8.05", to: "sec8.04" },
      { from: "sec8.06", to: "sec8.05" },
    ]);
    expect(result.text).not.toContain("Purchaser Indemnity");
    expect(result.text).toContain("8.02 Notice of Claim.");
    expect(result.text).toContain("notified under Section 8.02");
    expect(result.text.match(/subject to (?:the limitations in )?Section 8\.04/gu))
      .toHaveLength(2);
    expect(result.verification).toEqual({
      headingsRenumbered: 4,
      referencesUpdated: 3,
    });
  });

  it("satisfies the frozen Sunrise benchmark", async () => {
    const source = readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "benchmarks", "docx_edit",
        "fixtures", "prose", "sunrise-spa.md"),
      "utf8",
    );
    const result = await deleteProvisionAndRenumberSiblings(source, "8.02");
    expect(result.failures).toEqual([]);
    expect(result.mapping).toHaveLength(4);
    expect(result.text).not.toContain("Purchaser Indemnity");
    expect(result.text).toContain("8.05 Survival.");
    expect(result.text).not.toContain("8.06");
    expect(result.verification).toEqual({
      headingsRenumbered: 4,
      referencesUpdated: 5,
    });
  });

  it.each([
    ["reference_to_deleted_target", "\nSection 11.03 is subject to Section 8.02."],
    ["unresolved_reference", "\nSection 11.03 is subject to Section 8.99."],
    ["external_reference", "\nSection 11.03 is subject to Section 8.05 of the Income Tax Act."],
  ])("refuses %s without a partial edit", async (code, extra) => {
    const source = agreement + extra;
    const result = await deleteProvisionAndRenumberSiblings(source, "8.02");
    expect(result.failures.map((failure) => failure.code)).toContain(code);
    expect(result.text).toBe(source);
    expect(result.applied).toEqual([]);
  });

  it("refuses an ambiguous target", async () => {
    const source = [
      "Section 1.01 First Covenant. The Borrower shall pay.",
      "",
      "Section 1.01 Duplicate Covenant. The Borrower shall report.",
      "",
      "Section 1.02 Second Covenant. The Borrower shall notify.",
    ].join("\n");
    const result = await deleteProvisionAndRenumberSiblings(source, "1.01");
    expect(result.failures).toEqual([
      expect.objectContaining({ code: "target_ambiguous" }),
    ]);
    expect(result.text).toBe(source);
  });
});
