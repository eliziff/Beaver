import { describe, expect, it } from "vitest";
import { COURTS, COURT_JURISDICTIONS, COURT_LEVELS } from "./courtRegistry";

describe("court registry", () => {
  it("covers every Canadian jurisdiction and keeps every court relationship valid", () => {
    expect(COURT_JURISDICTIONS.filter(({ id }) => id !== "general").map(({ id }) => id).sort())
      .toEqual(["ab", "bc", "ca", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt"]);
    const jurisdictions = new Set(COURT_JURISDICTIONS.map(({ id }) => id));
    const levels = new Set(COURT_LEVELS.map(({ id }) => id));
    for (const court of COURTS) {
      expect(jurisdictions.has(court.jurisdictionId), court.id).toBe(true);
      expect(levels.has(court.levelId), court.id).toBe(true);
    }
  });
});
