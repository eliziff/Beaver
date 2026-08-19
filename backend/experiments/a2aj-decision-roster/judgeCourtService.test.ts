import { describe, expect, it } from "vitest";
import {
  createJudgeCourtServiceResolver,
  validateJudgeCourtRegistryData,
  type JudgeCourtRegistryData,
} from "./judgeCourtService";

const claim = (sourceQuote: string) => [{ sourceId: "official", sourceQuote }];

const data: JudgeCourtRegistryData = {
  version: 1,
  generatedAt: "2026-08-19T00:00:00Z",
  sources: [{
    id: "official",
    url: "https://example.test/judges",
    retrievedAt: "2026-08-19T00:00:00Z",
    sha256: "a".repeat(64),
  }],
  people: [
    { id: "lee", canonicalName: "Alexandra Lee", aliases: ["Lee J.", "Lee J.A."] },
    { id: "smith-1", canonicalName: "Jordan Smith", aliases: ["J. Smith"] },
    { id: "smith-2", canonicalName: "Jamie Smith", aliases: ["J. Smith"] },
    { id: "quinn", canonicalName: "Morgan Quinn", aliases: ["Quinn J."] },
  ],
  courts: [
    {
      id: "trial",
      canonicalName: "Example Superior Court",
      aliases: ["ESC"],
      datasetAliases: ["example_sc"],
    },
    {
      id: "appeal",
      canonicalName: "Example Court of Appeal",
      aliases: ["ECA"],
      datasetAliases: ["example_ca"],
    },
  ],
  positions: [
    {
      id: "lee-trial-justice",
      personId: "lee",
      courtId: "trial",
      dateStart: { value: "2010", precision: "year" },
      dateTermination: { value: "2015", precision: "year" },
      positionType: "justice",
      role: "Justice",
      assignmentType: "permanent",
      evidence: claim("Alexandra Lee — appointed 2010"),
    },
    {
      id: "lee-appeal-justice",
      personId: "lee",
      courtId: "appeal",
      dateStart: { value: "2016", precision: "year" },
      dateTermination: null,
      positionType: "justice_of_appeal",
      role: "Justice of Appeal",
      assignmentType: "permanent",
      evidence: [
        ...claim("Alexandra Lee — appointed 2016"),
        { sourceId: "official", sourceQuote: " Current members: Alexandra Lee " },
      ],
    },
    ...["smith-1", "smith-2"].map((personId) => ({
      id: `${personId}-appeal-justice`,
      personId,
      courtId: "appeal",
      dateStart: { value: "2012-01-01", precision: "day" } as const,
      dateTermination: null,
      positionType: "justice_of_appeal",
      role: "Justice of Appeal",
      assignmentType: "permanent" as const,
      evidence: claim(`${personId} — appointed 2012`),
    })),
  ],
  rosterObservations: [{
    id: "quinn-trial-justice-observed-2026-08-19",
    personId: "quinn",
    courtId: "trial",
    observedOn: "2026-08-19",
    positionType: "justice",
    role: "Justice",
    evidence: claim("Current judges: Morgan Quinn"),
  }],
};

describe("judge court registry", () => {
  const resolve = createJudgeCourtServiceResolver(data);

  it("resolves aliases across positions and preserves uncertain year boundaries", () => {
    const trial = resolve({
      displayedName: "The Honourable Justice Lee J.",
      court: "ESC",
      decisionDate: "2014-06-01",
    });
    expect(trial.status).toBe("unique");
    expect(trial.displayedName).toBe("The Honourable Justice Lee J.");
    expect(trial.candidates[0]).toMatchObject({
      person: { id: "lee" },
      evidence: [{ temporalMatch: "certain", position: { id: "lee-trial-justice" } }],
    });

    const promoted = resolve({
      displayedName: "LEE J.A.",
      dataset: "example_ca",
      decisionDate: "2016-04-10",
    });
    expect(promoted.candidates[0].evidence[0]).toMatchObject({
      kind: "position",
      temporalMatch: "possible",
      position: { id: "lee-appeal-justice" },
      matchedCourtBy: ["dataset"],
    });
  });

  it("reports shared aliases as ambiguous and missing positions as non-exclusionary", () => {
    expect(resolve({
      displayedName: "J. Smith",
      court: "ECA",
      decisionDate: "2020-01-01",
    }).status).toBe("ambiguous");

    expect(resolve({
      displayedName: "Lee J.",
      court: "ECA",
      decisionDate: "2015-06-01",
    })).toMatchObject({ status: "no_match", noMatchMayBeUnrecordedAssignment: true });
  });

  it("does not turn a current roster observation into historical service", () => {
    expect(resolve({
      displayedName: "Quinn J.",
      dataset: "example_sc",
      decisionDate: "2026-08-19",
    }).candidates[0].evidence[0]).toMatchObject({
      kind: "roster_observation",
      observation: { id: "quinn-trial-justice-observed-2026-08-19" },
    });
    expect(resolve({
      displayedName: "Quinn J.",
      dataset: "example_sc",
      decisionDate: "2025-08-19",
    }).status).toBe("no_match");
  });

  it("returns the dated court roster and retains exact evidence text", () => {
    expect(resolve.serving({
      dataset: "example_ca",
      decisionDate: "2020-01-01",
    })).toMatchObject({
      status: "unique_court",
      candidates: expect.arrayContaining([
        expect.objectContaining({ person: expect.objectContaining({ id: "lee" }) }),
      ]),
    });
    expect(validateJudgeCourtRegistryData(data).positions[1].evidence[1].sourceQuote)
      .toBe(" Current members: Alexandra Lee ");
  });

  it("rejects malformed or dangling claims before decision processing", () => {
    expect(() => validateJudgeCourtRegistryData({
      ...data,
      positions: [{
        ...data.positions[0],
        evidence: [{ sourceId: "missing", sourceQuote: "support" }],
      }],
    })).toThrow(/references missing source/u);
    expect(() => validateJudgeCourtRegistryData({
      ...data,
      positions: [{ ...data.positions[0], positionType: "Justice of Appeal" }],
    })).toThrow(/lowercase snake-case/u);
    expect(() => validateJudgeCourtRegistryData({
      ...data,
      rosterObservations: [{ ...data.rosterObservations[0], observedOn: "2026-02-30" }],
    })).toThrow(/calendar day/u);
    expect(() => validateJudgeCourtRegistryData({
      ...data,
      positions: [{ ...data.positions[0], dateStart: null, dateTermination: null }],
    })).toThrow(/no temporal bound/u);
  });
});
