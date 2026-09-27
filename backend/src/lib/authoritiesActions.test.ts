import { describe, expect, it } from "vitest";
import { applyAuthoritiesUserAction } from "./authoritiesActions";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";
import { createAuthoritiesDraft,
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
