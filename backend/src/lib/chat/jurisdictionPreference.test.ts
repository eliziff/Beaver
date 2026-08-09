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

  it("keeps presumed research within the selected regions", () => {
    const prompt = jurisdictionPreferencePrompt({
      mode: "presume",
      jurisdictions: ["Alberta, Canada", "Ontario, Canada"],
    });

    expect(prompt).toContain("Alberta, Canada; Ontario, Canada");
    expect(prompt).toContain("An explicit jurisdiction overrides");
    expect(prompt).toContain("Keep research and delegated reading within");
  });

  it("uses Canada as the default and excludes unsolicited US and UK law", () => {
    const prompt = jurisdictionPreferencePrompt({ mode: "ask", jurisdictions: [] });
    expect(prompt).toContain("FALLBACK: Canada");
    expect(prompt).toContain(
      "Ask only when jurisdiction is material and cannot be reliably inferred",
    );
    expect(prompt).toContain("United States or United Kingdom law");
    expect(jurisdictionPreferencePrompt(null)).toBe(prompt);
    expect(prompt).toContain("multiple Canadian jurisdictions");
  });
});
