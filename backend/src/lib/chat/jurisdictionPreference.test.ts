import { describe, expect, it } from "vitest";
import {
  jurisdictionPreferencePrompt,
  parseJurisdictionPreference,
} from "./prompts";

describe("standing jurisdiction preference", () => {
  it("normalizes and bounds browser-supplied jurisdictions", () => {
    expect(
      parseJurisdictionPreference({
        mode: "presume",
        jurisdictions: [
          " Alberta, Canada ",
          "Alberta, Canada",
          42,
          "",
        ],
      }),
    ).toEqual({
      mode: "presume",
      jurisdictions: ["Alberta, Canada"],
    });
  });

  it("keeps the preference advisory and lets an explicit request override it", () => {
    const prompt = jurisdictionPreferencePrompt({
      mode: "presume",
      jurisdictions: ["Alberta, Canada", "Ontario, Canada"],
    });

    expect(prompt).toContain("Alberta, Canada; Ontario, Canada");
    expect(prompt).toContain("An explicit jurisdiction overrides");
    expect(prompt).toContain("not a restriction on research sources");
  });

  it("asks only when a user with no default needs a material jurisdiction", () => {
    expect(
      jurisdictionPreferencePrompt({ mode: "ask", jurisdictions: [] }),
    ).toContain(
      "Ask only when jurisdiction is material and cannot be reliably inferred",
    );
  });
});
