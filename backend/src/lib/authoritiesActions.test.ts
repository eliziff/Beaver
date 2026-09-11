import { describe, expect, it } from "vitest";
import { applyAuthoritiesUserAction } from "./authoritiesActions";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";
import { createAuthoritiesDraft, reduceAuthoritiesDraft,
  type AuthoritiesDraft } from "./authoritiesDomain";

/** A body sentence carrying two citations and one pinpoint, as the scan leaves it. */
const TEXT = "The duty of honest performance was recognized in Bhasin v Hrynew, 2014 SCC 71 " +
  "at para 33, and applied in R v Jordan, 2016 SCC 27.";
const bodyDraft = (): AuthoritiesDraft => ({
  ...createAuthoritiesDraft({ kind: "manual" }),
  units: [{ id: "body:7", kind: "body", ordinal: 7, footnoteId: null, footnoteRefs: [],
    pageNumbers: [3], text: TEXT, occurrenceIds: [] }],
});
const at = (needle: string) => ({ start: TEXT.indexOf(needle),
  end: TEXT.indexOf(needle) + needle.length });
const add = (draft: AuthoritiesDraft, needle: string) => applyAuthoritiesUserAction(draft,
  { type: "add-occurrence", unitId: "body:7", ...at(needle) });

describe("Authorities citation boundary actions", () => {
  it("creates citations the scan missed, in reading order, over free text only", () => {
    const draft = add(add(bodyDraft(), "R v Jordan, 2016 SCC 27"), "Bhasin v Hrynew, 2014 SCC 71");
    expect(draft.units[0].occurrenceIds.map((id) => draft.occurrences[id].citation))
      .toEqual(["2014 SCC 71", "2016 SCC 27"]);
    expect(draft.units[0].occurrenceIds.map((id) => draft.occurrences[id])).toEqual([
      expect.objectContaining({ kind: "case", authorityId: "2014scc71", reviewed: true,
        authoritySpan: { ...at("Bhasin v Hrynew, 2014 SCC 71"),
          text: "Bhasin v Hrynew, 2014 SCC 71" } }),
      expect.objectContaining({ kind: "case", authorityId: "2016scc27" }),
    ]);
    expect(draft.authorities["2014scc71"]).toMatchObject({ citation: "2014 SCC 71",
      name: "Bhasin v Hrynew", scanOnly: true });
    expect(() => add(draft, "2014 SCC 71 at para 33")).toThrow(/free text/u);
    expect(() => applyAuthoritiesUserAction(draft,
      { type: "add-occurrence", unitId: "body:9", start: 0, end: 5 })).toThrow(/citation unit/u);
    expect(() => applyAuthoritiesUserAction(draft,
      { type: "add-occurrence", unitId: "body:7", start: 0, end: TEXT.length + 1 }))
      .toThrow(/citation unit/u);
  });

  it("lists one authority for a citation however its style of cause introduces it", () => {
    const styled = applyAuthoritiesUserAction(bodyDraft(),
      { type: "add-authority", kind: "case", citation: "Bhasin v Hrynew, 2014 SCC 71" });
    expect(styled.authorityOrder).toEqual(["2014scc71"]);
    expect(applyAuthoritiesUserAction(styled,
      { type: "add-authority", kind: "case", citation: "2014 SCC 71" }).authorityOrder)
      .toEqual(["2014scc71"]);

    const added = add(styled, "Bhasin v Hrynew, 2014 SCC 71");
    expect(added.authorityOrder).toEqual(["2014scc71"]);
    expect(added.occurrences[added.units[0].occurrenceIds[0]])
      .toMatchObject({ citation: "2014 SCC 71", authorityId: "2014scc71" });

    // A draft already listing the citation under its styled key links to it too,
    // rather than minting the scan's key beside it.
    const legacy = reduceAuthoritiesDraft(bodyDraft(), { type: "add-authority", authority: {
      id: "bhasinvhrynew2014scc71", key: "bhasinvhrynew2014scc71", kind: "case",
      citation: "Bhasin v Hrynew, 2014 SCC 71", name: "Bhasin v Hrynew", displayName: null,
      excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" }, userAdded: true } });
    const linked = add(legacy, "Bhasin v Hrynew, 2014 SCC 71");
    expect(linked.authorityOrder).toEqual(["bhasinvhrynew2014scc71"]);
    expect(linked.occurrences[linked.units[0].occurrenceIds[0]].authorityId)
      .toBe("bhasinvhrynew2014scc71");
  });

  it("splits and merges citations in a body unit, not only in a footnote", () => {
    const whole = add(bodyDraft(), TEXT.slice(TEXT.indexOf("Bhasin")));
    const [wholeId] = whole.units[0].occurrenceIds;
    // Two citations read as one: the manual span parses as neither case.
    expect(whole.occurrences[wholeId]).toMatchObject({ kind: "other", authorityId: null });

    const split = applyAuthoritiesUserAction(whole,
      { type: "split-occurrence", occurrenceId: wholeId, cursor: TEXT.indexOf("R v Jordan") });
    const [left, right] = split.units[0].occurrenceIds.map((id) => split.occurrences[id]);
    expect(left).toMatchObject({ citation: "2014 SCC 71", authorityId: "2014scc71",
      pinpoints: [{ kind: "paragraph", text: "33" }] });
    expect(right).toMatchObject({ citation: "2016 SCC 27", authorityId: "2016scc27" });
    expect([...split.authorityOrder].sort()).toEqual(["2014scc71", "2016scc27"]);
    expect(() => applyAuthoritiesUserAction(split,
      { type: "merge-occurrence", occurrenceId: left.id })).toThrow(/first citation/u);

    const merged = applyAuthoritiesUserAction(split,
      { type: "merge-occurrence", occurrenceId: right.id });
    expect(merged.units[0].occurrenceIds).toHaveLength(1);
    expect(merged.occurrences[merged.units[0].occurrenceIds[0]])
      .toMatchObject({ start: whole.occurrences[wholeId].start, end: right.end });
  });

  it("clears a pinpoint attached to the wrong citation", () => {
    const whole = add(bodyDraft(), TEXT.slice(TEXT.indexOf("Bhasin")));
    const split = applyAuthoritiesUserAction(whole, { type: "split-occurrence",
      occurrenceId: whole.units[0].occurrenceIds[0], cursor: TEXT.indexOf("R v Jordan") });
    const [id] = split.units[0].occurrenceIds;
    expect(split.occurrences[id].pinpointSpan).not.toBeNull();

    const cleared = applyAuthoritiesUserAction(split, { type: "clear-pinpoint", occurrenceId: id });
    const occurrence = cleared.occurrences[id];
    expect(occurrence).toMatchObject({ pinpointSpan: null, pinpoints: [], reviewed: true,
      ...at("Bhasin v Hrynew, 2014 SCC 71"), text: "Bhasin v Hrynew, 2014 SCC 71" });
    expect(occurrence.authoritySpan).toEqual(split.occurrences[id].authoritySpan);
    expect(() => applyAuthoritiesUserAction(cleared,
      { type: "clear-pinpoint", occurrenceId: id })).toThrow(/no pinpoint/u);
    expect(() => applyAuthoritiesUserAction(cleared,
      { type: "clear-pinpoint", occurrenceId: "missing" })).toThrow(/not found/u);
  });

  it("decodes the boundary actions the assistant sends", () => {
    expect(decodeAuthoritiesUserAction({ type: "clear-pinpoint", occurrenceId: "occ-1" }))
      .toEqual({ type: "clear-pinpoint", occurrenceId: "occ-1" });
    expect(decodeAuthoritiesUserAction({ type: "add-occurrence", unitId: "body:7",
      start: 49, end: 77 })).toEqual({ type: "add-occurrence", unitId: "body:7",
      start: 49, end: 77 });
    expect(() => decodeAuthoritiesUserAction({ type: "clear-pinpoint" })).toThrow();
    expect(() => decodeAuthoritiesUserAction({ type: "add-occurrence", start: 0, end: 5 })).toThrow();
    expect(() => decodeAuthoritiesUserAction({ type: "add-occurrence", unitId: "body:7",
      start: 5, end: 0 })).toThrow();
  });
});
