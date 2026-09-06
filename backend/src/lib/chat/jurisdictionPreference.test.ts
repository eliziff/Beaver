import { describe, expect, it } from "vitest";
import {
  jurisdictionPreferencePrompt,
} from "./prompts";

describe("standing jurisdiction preference", () => {
  it("keeps presumed research within the selected regions", () => {
    const prompt = jurisdictionPreferencePrompt({
      mode: "presume",
      jurisdictions: ["Alberta, Canada", "Ontario, Canada"],
    });

    expect(prompt).toContain("Alberta, Canada; Ontario, Canada");
    expect(prompt).not.toBe(jurisdictionPreferencePrompt(null));
  });

  it("uses the Canadian default for an unset or ask preference", () => {
    const prompt = jurisdictionPreferencePrompt({ mode: "ask", jurisdictions: [] });
    expect(prompt).toContain("Canada");
    expect(jurisdictionPreferencePrompt(null)).toBe(prompt);
    expect(jurisdictionPreferencePrompt({ mode: "ask", jurisdictions: ["England"] })).toBe(prompt);
  });
});
