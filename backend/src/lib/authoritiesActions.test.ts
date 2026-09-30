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
  it("resizes a whole citation across a neighbour and preserves the neighbour's outside text", () => {
    const original = add(add(bodyDraft(), 'Bhasin v Hrynew, 2014 SCC 71 at para 33'), 'R v Jordan, 2016 SCC 27');
    const [id] = original.units[0].occurrenceIds;
    const start = TEXT.indexOf('Bhasin'), end = TEXT.indexOf('Jordan');
    const changed = applyAuthoritiesUserAction(original, decodeAuthoritiesUserAction({
      type: 'set-citation-range', occurrenceId: id, start, end,
    }));
    const parts = changed.units[0].occurrenceIds.map(id => changed.occurrences[id]);
    expect(parts.map(part => part.text)).toEqual([
      TEXT.slice(start, end).trim(), 'Jordan, 2016 SCC 27',
    ]);
    expect(parts[0].id).toBe(id);
    expect(parts[0].pinpoints).toContainEqual({ kind: 'paragraph', text: '33' });
    expect(parts[1].authorityId).toBe(original.occurrences[original.units[0].occurrenceIds[1]].authorityId);
    expect(parts[0].end).toBeLessThanOrEqual(parts[1].start);
    expect(original.units[0].occurrenceIds).toHaveLength(2);
    expect(original.occurrences[id].text).toBe('Bhasin v Hrynew, 2014 SCC 71 at para 33');
    expect(() => applyAuthoritiesUserAction(original, { type: 'set-citation-range', occurrenceId: id,
      start: -1, end })).toThrow();
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

  it("keeps a reviewer's pinpoint through range edits it survives and resets to the parser's", () => {
    const auto = add(bodyDraft(), "Bhasin v Hrynew, 2014 SCC 71 at para 33");
    const [id] = auto.units[0].occurrenceIds, parsed = auto.occurrences[id];
    const act = (draft: AuthoritiesDraft, action: object) => applyAuthoritiesUserAction(draft,
      decodeAuthoritiesUserAction({ occurrenceId: id, ...action }));
    const manual = act(auto, { type: "set-pinpoint-span", ...at("33") });
    expect(manual.occurrences[id]).toMatchObject({ pinpointManual: true, pinpointSpan: { text: "33" } });
    const kept = act(manual, { type: "set-citation-range", ...at("Hrynew, 2014 SCC 71 at para 33") });
    expect(kept.occurrences[id]).toMatchObject({ pinpointManual: true, pinpointSpan: { text: "33" } });
    const reset = act(manual, { type: "reset-pinpoint" }).occurrences[id];
    expect(reset.pinpointManual).toBeUndefined();
    expect([reset.pinpointSpan, reset.pinpoints]).toEqual([parsed.pinpointSpan, parsed.pinpoints]);
    const outside = act(manual, { type: "set-citation-range", ...at("Bhasin v Hrynew, 2014 SCC 71") });
    expect(outside.occurrences[id]).toMatchObject({ pinpointSpan: null, pinpoints: [] });
    expect(outside.occurrences[id].pinpointManual).toBeUndefined();
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
