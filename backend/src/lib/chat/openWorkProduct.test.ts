import { describe, expect, it } from "vitest";
import { openWorkProductPrompt } from "./prompts";

// Live regression: an Authorities dock turn ("see if there are any cite
// boundaries that need fixing") came back as a legal analysis of Hansman v
// Neufeld, because the open draft only bound a tool and never reached the
// system prompt. The dock is a workflow surface, not a research chat.
describe("open work-product scoping", () => {
  it("points the turn at the draft instead of legal analysis", () => {
    for (const kind of ["authorities", "court-record"] as const) {
      const prompt = openWorkProductPrompt(kind);
      expect(prompt).toContain("update_work_product");
      expect(prompt).toContain("Do not reply with legal analysis");
      expect(prompt).toContain("do not edit unrelated documents");
    }
  });

  it("names the draft the user actually has open", () => {
    expect(openWorkProductPrompt("authorities")).toContain("OPEN AUTHORITIES DRAFT");
    expect(openWorkProductPrompt("court-record")).toContain("OPEN COURT RECORD DRAFT");
    expect(openWorkProductPrompt("authorities"))
      .not.toBe(openWorkProductPrompt("court-record"));
  });
});
