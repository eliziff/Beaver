import { describe, expect, it } from "vitest";

import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { authoritiesDiscrepancyCorrection, editorialQuote, findAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";

const phrase = "The deadline is seven business days.";

function occurrence(id = "citation", authorityId: string | null = "case",
  reviewed = true): AuthorityOccurrence {
  const text = "2020 SCC 1 at para 7";
  return { id, unitId: "footnote:1", start: 0, end: text.length, text,
    authoritySpan: { start: 0, end: text.length, text },
    coreSpan: { start: 0, end: 10, text: "2020 SCC 1" },
    pinpointSpan: { start: 19, end: 20, text: "7" }, kind: "case",
    citation: "2020 SCC 1", authorityId, reference: null,
    pinpoints: [{ kind: "paragraph", text: "7" }], evidenceIds: [],
    sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed };
}

function draft(body: string, occurrences = [occurrence()],
  refs: Array<[number, number]> = [[1, body.length]]):
  Pick<AuthoritiesDraft, "units" | "occurrences"> {
  return { units: [
    { id: "body:1", kind: "body" as const, ordinal: 1, footnoteId: null,
      footnoteRefs: refs, pageNumbers: [], text: body, occurrenceIds: [] },
    { id: "footnote:1", kind: "footnote" as const, ordinal: 1, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [], text: occurrences.map(({ text }) => text).join("; "),
      occurrenceIds: occurrences.map(({ id }) => id) },
  ], occurrences: Object.fromEntries(occurrences.map((item) => [item.id, item])) };
}

const source = (cited: string, alternatives: Array<{ label: string; text: string }> = []) => [{
  occurrenceId: "citation",
  sourceVersion: "b".repeat(64),
  cited: { locator: { kind: "paragraph" as const, label: "7" }, text: cited },
  alternatives: alternatives.map(({ label, text }) => ({
    locator: { kind: "paragraph" as const, label }, text,
  })),
}];

describe("authorities discrepancy review", () => {
  it("uses the historical preceding-footnote proposition and reports a bounded mismatch", () => {
    const first = "An earlier proposition without a quotation.";
    const second = ` The court wrote "${phrase}"`;
    const state = draft(`${first}${second}`, [occurrence()], [[1, first.length], [2, first.length + second.length]]);
    state.units[1].footnoteId = 2;
    state.occurrences.citation.unitId = "footnote:1";
    const findings = findAuthoritiesDiscrepancies(state, source("The cited paragraph says something else."));
    expect(findings).toEqual([expect.objectContaining({
      kind: "quote_unlocated", proposition: `The court wrote "${phrase}"`,
      authoredQuote: phrase, footnoteId: 2, found: null,
      id: expect.stringMatching(/^[a-f0-9]{64}$/u), actions: ["ignore"],
    })]);
  });

  it("accepts exact and bounded editorial quotations through the existing verifier", () => {
    expect(findAuthoritiesDiscrepancies(draft(`The court wrote "${phrase}"`),
      source(`Reasons: ${phrase}`))).toEqual([]);
    expect(findAuthoritiesDiscrepancies(
      draft('The court wrote "[T]he deadline is seven business days."'),
      source("Reasons: the deadline is seven business days."),
    )).toEqual([]);
  });

  it("does not flag nested quotation marks, marked omissions or bracketed edits", () => {
    const wording = "An individual’s reputation is not to be treated as regrettable but unavoidable road kill on the highway of public controversy, but nor should an overly solicitous regard for personal reputation be permitted to ‘chill’ freewheeling debate on matters of public interest.";
    const original = wording.replace("‘chill’", "“chill”");
    expect(findAuthoritiesDiscrepancies(draft(`The court wrote “${wording}”`), source(original))).toEqual([]);
    for (const omission of ["...", "…", ". . ."]) {
      expect(findAuthoritiesDiscrepancies(draft(`The court wrote "[T]he deadline is ${omission} [seven] business days."`),
        source("the deadline is not less than five business days."))).toEqual([]);
    }
    expect(findAuthoritiesDiscrepancies(draft('The court wrote "[T]he deadline is seven business days."'),
      source("the deadline is five business days."))).toHaveLength(1);
    expect(findAuthoritiesDiscrepancies(draft('The court wrote "The worker’s rights are protected by this rule."'),
      source("The workers rights are protected by this rule."))).toHaveLength(1);
  });

  it("reports one unique exact match outside the cited locator as a wrong pinpoint", () => {
    const findings = findAuthoritiesDiscrepancies(draft(`The court wrote "${phrase}"`),
      source("Paragraph seven says something else.", [{ label: "9", text: phrase }]));
    expect(findings).toEqual([expect.objectContaining({
      kind: "wrong_pinpoint", authoredPinpoint: { kind: "paragraph", text: "7" },
      found: { locator: { kind: "paragraph", label: "9" }, text: phrase },
      actions: ["ignore", "pinpoint"],
    })]);
    expect(findAuthoritiesDiscrepancies(draft(`The court wrote "${phrase}"`),
      source("No match.", [{ label: "9", text: phrase }]))[0].id).toBe(findings[0].id);
  });

  it("suppresses ambiguous matches and footnotes with more than one source", () => {
    const body = `The court wrote "${phrase}"`;
    expect(findAuthoritiesDiscrepancies(draft(body), source("No match.", [
      { label: "8", text: phrase }, { label: "9", text: phrase },
    ]))).toEqual([]);
    expect(findAuthoritiesDiscrepancies(draft(body, [occurrence(), occurrence("other", "other")]),
      source("No match."))).toEqual([]);
    expect(findAuthoritiesDiscrepancies(draft(body, [occurrence("citation", "case", false)]),
      source("No match."))).toEqual([expect.objectContaining({ kind: "quote_unlocated" })]);
  });

  it("returns a bounded source repair and the pinned oracle's editorial wording", () => {
    const authored = "the landlord may deliver a written notice to terminate the lease within seven calendar days";
    const cited = "If rent is unpaid, the landlord may deliver a written notice to terminate the lease " +
      "not less than seven business days after receipt of the notice by the tenant.";
    const finding = findAuthoritiesDiscrepancies(draft(`The court wrote "${authored}"`),
      source(cited))[0];
    expect(finding).toMatchObject({ kind: "quote_mismatch",
      actions: ["ignore", "quote_exact", "quote_editorial"],
      found: { text: expect.stringContaining("not less than seven") } });
    expect(finding.found!.text.length).toBeLessThan(cited.length);
    expect(finding.found!.text).toBe("the landlord may deliver a written notice to terminate the lease not less than seven business days");
    expect(editorialQuote("This and that", "This long passage and another"))
      .toBe("This ... and [that]");
    expect([
      editorialQuote("The test applies", "the test applies"),
      editorialQuote("court", "courts"),
      editorialQuote("alpha gamma", "alpha beta gamma"),
      editorialQuote("A, B", "A B"),
    ]).toEqual(["[T]he test applies", "[court]", "alpha ... gamma", "A, B"]);
  });
});

describe("quotation review safety", () => {
  it("classifies an unrelated source as unlocated and cannot apply a fabricated repair", () => {
    const state = draft(`The court wrote "${phrase}"`);
    const [finding] = findAuthoritiesDiscrepancies(state, source("Municipal liability concerns the design of public roads."));
    expect(finding).toMatchObject({ kind: "quote_unlocated", found: null, actions: ["ignore"] });
    expect(authoritiesDiscrepancyCorrection(state, { ...finding, kind: "quote_mismatch",
      actions: ["quote_exact"], found: finding.cited }, "quote_exact")).toBeNull();
  });
  it("does not resurrect a decision on an unrelated document revision", () => {
    const state = draft(`The court wrote "${phrase}"`), evidence = source("The deadline is five business days.");
    const [before] = findAuthoritiesDiscrepancies(state, evidence);
    state.occurrences.citation.id = "reimported-citation-id";
    state.occurrences.citation.sourceTextSha256 = "c".repeat(64);
    // IDs and whole-document hashes are implementation details, not decision identity.
    const changed = structuredClone(state);
    changed.occurrences.citation.id = "citation";
    const [after] = findAuthoritiesDiscrepancies(changed, evidence);
    expect(after.id).toBe(before.id);
    const revisedEvidence = structuredClone(evidence); revisedEvidence[0].sourceVersion = "d".repeat(64);
    expect(findAuthoritiesDiscrepancies(changed, revisedEvidence)[0].id).not.toBe(before.id);
  });
  it("will not edit a different copy when a quotation repeats in the same context", () => {
    const state = draft(`"${phrase}" and again "${phrase}"`);
    const [finding] = findAuthoritiesDiscrepancies(state, source("The deadline is five business days."));
    expect(finding.actions).toEqual(["ignore"]);
  });
  it("does not borrow quotes from another footnote or ignore an unresolved second citation", () => {
    const state = draft(`"${phrase}" First note. A separate proposition.`, [occurrence()], [[2, phrase.length + 2], [1, phrase.length + 41]]);
    expect(findAuthoritiesDiscrepancies(state, source("Other evidence."))).toEqual([]);
    const ambiguous = draft(`"${phrase}"`, [occurrence(), occurrence("unresolved", null)]);
    expect(findAuthoritiesDiscrepancies(ambiguous, source("Other evidence."))).toEqual([]);
  });
  it("does not accept a small common fragment of a much longer passage", () => {
    const [finding] = findAuthoritiesDiscrepancies(draft(`"${phrase}"`), source("The deadline is followed by a long discussion of entirely different substantive legal principles that cannot establish these quoted words."));
    expect(finding).toMatchObject({ kind: "quote_unlocated", actions: ["ignore"] });
  });
});

it("retains decisions when an earlier note renumbers the same Word footnote", () => {
  const state = draft(`The court wrote "${phrase}"`), evidence = source("The deadline is five business days.");
  const before = findAuthoritiesDiscrepancies(state, evidence)[0];
  state.units[1].footnoteId = 2; state.units[0].footnoteRefs[0][0] = 2;
  expect(findAuthoritiesDiscrepancies(state, evidence)[0].id).toBe(before.id);
});
it("does not rewrite a page number to a paragraph number", () => {
  const state = draft(`The court wrote "${phrase}"`), evidence = source("Other wording.", [{label:"9", text:phrase}]);
  evidence[0].alternatives[0].locator.kind = "section" as "paragraph";
  expect(findAuthoritiesDiscrepancies(state, evidence)[0]).toMatchObject({kind:"quote_unlocated",actions:["ignore"]});
});
