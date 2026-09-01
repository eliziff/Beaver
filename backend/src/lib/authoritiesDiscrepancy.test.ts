import { describe, expect, it } from "vitest";

import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { findAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";

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
      kind: "quote_mismatch", proposition: `The court wrote "${phrase}"`,
      authoredQuote: phrase, footnoteId: 2, found: null,
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

  it("reports one unique exact match outside the cited locator as a wrong pinpoint", () => {
    const findings = findAuthoritiesDiscrepancies(draft(`The court wrote "${phrase}"`),
      source("Paragraph seven says something else.", [{ label: "9", text: phrase }]));
    expect(findings).toEqual([expect.objectContaining({
      kind: "wrong_pinpoint", authoredPinpoint: { kind: "paragraph", text: "7" },
      found: { locator: { kind: "paragraph", label: "9" }, text: phrase },
    })]);
  });

  it("suppresses ambiguous matches and footnotes with more than one source", () => {
    const body = `The court wrote "${phrase}"`;
    expect(findAuthoritiesDiscrepancies(draft(body), source("No match.", [
      { label: "8", text: phrase }, { label: "9", text: phrase },
    ]))).toEqual([]);
    expect(findAuthoritiesDiscrepancies(draft(body, [occurrence(), occurrence("other", "other")]),
      source("No match."))).toEqual([]);
    expect(findAuthoritiesDiscrepancies(draft(body, [occurrence("citation", "case", false)]),
      source("No match."))).toEqual([expect.objectContaining({ kind: "quote_mismatch" })]);
  });
});
