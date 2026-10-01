import { describe, expect, it, vi } from "vitest";
import { applyAuthoritiesUserAction } from "./authoritiesActions";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";
import { authorityCitationForms, createAuthoritiesDraft,
  type AuthoritiesDraft } from "./authoritiesDomain";
import { authoritySourceServices, resolveAuthoritiesSources,
  type SourceServices } from "./authoritiesSourceResolution";
import { A2AJUnavailable } from "./legalSources/a2aj";

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

/** A string cite: two citations, the first with a pinpoint and a short form, joined by a signal. */
const JORDAN = "R v Jordan, 2016 SCC 27 at para 105 [Jordan]", BHASIN = "Bhasin v Hrynew, 2014 SCC 71";
const STRING = `As the Court held, ${JORDAN}; see e.g. ${BHASIN}.`;
const near = (needle: string) => ({ start: STRING.indexOf(needle), end: STRING.indexOf(needle) + needle.length });
const stringCite = () => [JORDAN, BHASIN].reduce((draft, needle) => applyAuthoritiesUserAction(draft,
  { type: "add-occurrence", unitId: "body:7", ...near(needle) }), { ...bodyDraft(),
  units: [{ ...bodyDraft().units[0], text: STRING }] } as AuthoritiesDraft);

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

  it("gives an added citation its pinpoint as written, and derives it again on every range edit", () => {
    const auto = add(bodyDraft(), "Bhasin v Hrynew, 2014 SCC 71 at para 33");
    const [id] = auto.units[0].occurrenceIds, parsed = auto.occurrences[id];
    expect(parsed).toMatchObject({ pinpointSpan: { text: "33" }, pinpointPhrase: { text: "at para 33" },
      pinpoints: [{ kind: "paragraph", text: "33" }] });
    const act = (draft: AuthoritiesDraft, action: object) => applyAuthoritiesUserAction(draft,
      decodeAuthoritiesUserAction({ occurrenceId: id, ...action }));
    expect(() => decodeAuthoritiesUserAction({ occurrenceId: id, type: "reset-pinpoint" })).toThrow();
    // A pinpoint placed by hand gives way to the parser's at the next range edit.
    const manual = act(auto, { type: "set-pinpoint-span", ...at("33") });
    expect(manual.occurrences[id]).toMatchObject({ pinpointManual: true, pinpointPhrase: { text: "at para 33" } });
    const kept = act(manual, { type: "set-citation-range", ...at("Hrynew, 2014 SCC 71 at para 33") }).occurrences[id];
    expect(kept.pinpointManual).toBeUndefined();
    expect([kept.pinpointSpan, kept.pinpointPhrase, kept.pinpoints])
      .toEqual([parsed.pinpointSpan, parsed.pinpointPhrase, parsed.pinpoints]);
    const outside = act(manual, { type: "set-citation-range", ...at("Bhasin v Hrynew, 2014 SCC 71") });
    expect(outside.occurrences[id]).toMatchObject({ pinpointSpan: null, pinpoints: [] });
    expect(outside.occurrences[id].pinpointManual).toBeUndefined();
    expect(outside.occurrences[id].pinpointPhrase).toBeUndefined();
    const back = act(outside, { type: "set-citation-range", ...at("Bhasin v Hrynew, 2014 SCC 71 at para 33") });
    expect(back.occurrences[id].pinpointPhrase?.text).toBe("at para 33");
    const cleared = act(back, { type: "clear-pinpoint" }).occurrences[id];
    expect([cleared.pinpointSpan, cleared.pinpointPhrase]).toEqual([null, undefined]);
  });

  it("places a supra or ibid's pinpoint after its reference, and lets a reviewer set it by hand", () => {
    const text = "Bhasin v Hrynew, 2014 SCC 71. See ibid at para 48.", ibid = "ibid at para 48";
    const span = (needle: string) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
    const draft = applyAuthoritiesUserAction({ ...bodyDraft(), units: [{ ...bodyDraft().units[0], text }] },
      { type: "add-occurrence", unitId: "body:7", ...span(ibid) });
    const [id] = draft.units[0].occurrenceIds;
    expect(draft.occurrences[id]).toMatchObject({ kind: "reference", authoritySpan: { text: "ibid" } });
    expect(draft.occurrences[id].pinpointSpan?.text).toContain("48");
    const pinned = applyAuthoritiesUserAction(draft, { type: "set-pinpoint-span", occurrenceId: id, ...span("48") });
    expect(pinned.occurrences[id]).toMatchObject({ text: ibid, pinpointManual: true, pinpointSpan: { text: "48" },
      pinpoints: [{ kind: "paragraph", text: "48" }] });
  });

  it("keeps the citation's range when a pinpoint is set, and records no dismissal for range edits", () => {
    const draft = stringCite(), [jordan] = draft.units[0].occurrenceIds;
    const pinned = applyAuthoritiesUserAction(draft, { type: "set-pinpoint-span", occurrenceId: jordan, ...near("105") });
    expect(pinned.occurrences[jordan]).toMatchObject({ text: JORDAN, pinpointManual: true,
      pinpointSpan: { text: "105" } });
    const edits = [{ type: "set-citation-range", ...near("R v Jordan, 2016 SCC 27") },
      { type: "set-citation-range", ...near(JORDAN) },
      { type: "set-pinpoint-span", ...near("105") }] as const;
    let state = pinned;
    for (const edit of edits) state = applyAuthoritiesUserAction(state, { occurrenceId: jordan, ...edit });
    expect(state.occurrences[jordan].text).toBe(JORDAN);
    expect(state.dismissedOccurrences ?? {}).toEqual({});
    expect(Object.values(state.discrepancyDecisions)).not.toContain("ignore");
  });

  it("splits at the separator and merges back to the range it split", () => {
    const draft = stringCite(), [jordan, bhasin] = draft.units[0].occurrenceIds;
    const merged = applyAuthoritiesUserAction(draft, { type: "merge-occurrence", occurrenceId: bhasin });
    const [whole] = merged.units[0].occurrenceIds;
    expect(merged.occurrences[whole].text).toBe(STRING.slice(STRING.indexOf("R v"), STRING.indexOf(".", STRING.indexOf("71"))));
    // The reviewer splits at either word gap between the two: after the semicolon or after the signal.
    for (const cursor of [STRING.indexOf("see e.g."), STRING.indexOf("Bhasin")]) {
      const split = applyAuthoritiesUserAction(merged, { type: "split-occurrence", occurrenceId: whole, cursor });
      const parts = split.units[0].occurrenceIds.map(id => split.occurrences[id]);
      expect(parts.map(({ text }) => text)).toEqual([JORDAN, BHASIN]);
      expect(parts.map(({ authorityId }) => authorityId)).toEqual(
        [draft.occurrences[jordan].authorityId, draft.occurrences[bhasin].authorityId]);
      const again = applyAuthoritiesUserAction(split, { type: "merge-occurrence", occurrenceId: parts[1].id });
      expect(again.units[0].occurrenceIds.map(id => again.occurrences[id].text)).toEqual([merged.occurrences[whole].text]);
    }
    const halves = applyAuthoritiesUserAction(draft, { type: "split-occurrence", occurrenceId: jordan,
      cursor: STRING.indexOf("[Jordan]") });
    const second = halves.units[0].occurrenceIds[1];
    const rejoined = applyAuthoritiesUserAction(halves, { type: "merge-occurrence", occurrenceId: second });
    expect(rejoined.units[0].occurrenceIds.map(id => rejoined.occurrences[id].text)).toEqual([JORDAN, BHASIN]);
  });

  it("never gives a supra split out of another citation that citation's authority", () => {
    const text = "R v Jordan, 2016 SCC 27 at paras 46-48; Oakes, supra note 2 at 135.";
    const draft = applyAuthoritiesUserAction({ ...bodyDraft(), units: [{ ...bodyDraft().units[0], text }] },
      { type: "add-occurrence", unitId: "body:7", start: 0, end: text.length - 1 });
    const [whole] = draft.units[0].occurrenceIds;
    expect(draft.occurrences[whole].authorityId).not.toBeNull();
    const split = applyAuthoritiesUserAction(draft, { type: "split-occurrence", occurrenceId: whole,
      cursor: text.indexOf("Oakes") });
    const [jordan, supra] = split.units[0].occurrenceIds.map((id) => split.occurrences[id]);
    expect(jordan.authorityId).toBe(draft.occurrences[whole].authorityId);
    expect(supra).toMatchObject({ kind: "reference", authorityId: null, reference: null });
  });

  it("relinks a citation without letting it take over or remove the authority it now names", async () => {
    const draft = { ...stringCite(), outputMode: "table" as const }, [jordan, bhasin] = draft.units[0].occurrenceIds;
    const [jordanAuthority, bhasinAuthority] = [jordan, bhasin].map(id => draft.occurrences[id].authorityId!);
    const relinked = applyAuthoritiesUserAction(draft, { type: "relink-occurrence", occurrenceId: jordan,
      authorityId: bhasinAuthority });
    expect(Object.keys(relinked.authorities).sort()).toEqual(Object.keys(draft.authorities).sort());
    expect(authorityCitationForms(relinked, bhasinAuthority)).not.toContain("2016 SCC 27");
    // Bhasin's own citation finds nothing; only Jordan's would find a source, which is Jordan's.
    const resolve = vi.fn(async (citation: string) => citation === "2016 SCC 27" ? {
      citation, alternateCitation: null, name: "R v Jordan", date: "2016-07-08", url: "https://example.test/jordan",
      publisherUrl: null, dataset: "SCC", language: "en" as const, searchText: "", verifiedPdf: null, native: {},
    } : null);
    const { draft: resolved } = await resolveAuthoritiesSources(relinked, { ...authoritySourceServices,
      resolve, resolveForeign: async () => null, revision: () => "a".repeat(64) } as unknown as SourceServices);
    expect(Object.keys(resolved.authorities).sort()).toEqual([bhasinAuthority, jordanAuthority].sort());
    expect([jordan, bhasin].map(id => resolved.occurrences[id].authorityId)).toEqual([bhasinAuthority, bhasinAuthority]);
    expect(resolved.authorities[bhasinAuthority].sourceIdentity).toBeNull();
    expect(resolved.authorities[jordanAuthority].sourceIdentity?.stableSourceId).toBe("a2aj:en:scc:2016 scc 27");
  });

  it("keeps looking up after one authority's lookup fails, and names a defect of its own as one", async () => {
    const draft = { ...stringCite(), outputMode: "table" as const };
    const [jordan, bhasin] = draft.units[0].occurrenceIds.map(id => draft.occurrences[id].authorityId!);
    const found = (citation: string) => ({ citation, alternateCitation: null, name: "R v Jordan",
      date: "2016-07-08", url: "https://example.test/jordan", publisherUrl: null, dataset: "SCC",
      language: "en" as const, searchText: "", verifiedPdf: null, native: {} });
    for (const [thrown, failure] of [
      [new A2AJUnavailable("timeout"), { reason: "timeout", retryAfter: null }],
      [new TypeError("Cannot read properties of undefined (reading 'dataset')"), { reason: "defect",
        retryAfter: null, detail: "Cannot read properties of undefined (reading 'dataset')" }],
    ] as const) {
      const resolve = vi.fn(async (citation: string) => {
        if (citation === "2016 SCC 27") return found(citation);
        throw thrown;
      });
      const services = { ...authoritySourceServices, resolve, resolveForeign: async () => null,
        revision: () => "a".repeat(64) } as unknown as SourceServices;
      const { draft: resolved } = await resolveAuthoritiesSources(draft, services);
      expect(resolved.authorities[jordan].sourceIdentity?.stableSourceId).toBe("a2aj:en:scc:2016 scc 27");
      expect(resolved.authorities[bhasin].sourceLookupFailure).toEqual(failure);
    }
  });

  it("records which lookups A2AJ left unanswered and retries them only after its window", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2020, 0, 1) });
    try {
      const draft = { ...stringCite(), outputMode: "table" as const };
      const [jordan, bhasin] = draft.units[0].occurrenceIds.map(id => draft.occurrences[id].authorityId!);
      const until = Date.now() + 90_000;
      let limit = true;
      const resolve = vi.fn(async (citation: string) => {
        if (citation === "2016 SCC 27") return { citation, alternateCitation: null, name: "R v Jordan",
          date: "2016-07-08", url: "https://example.test/jordan", publisherUrl: null, dataset: "SCC",
          language: "en" as const, searchText: "", verifiedPdf: null, native: {} };
        if (limit) throw new A2AJUnavailable("rate-limited", until);
        return null;
      });
      const services = { ...authoritySourceServices, resolve, resolveForeign: async () => null,
        revision: () => "a".repeat(64) } as unknown as SourceServices;
      const { draft: partial } = await resolveAuthoritiesSources(draft, services);
      // One authority found, the other named as unchecked with A2AJ's own retry time.
      expect(partial.authorities[jordan].sourceIdentity?.stableSourceId).toBe("a2aj:en:scc:2016 scc 27");
      expect(partial.authorities[jordan].sourceLookupFailure).toBeUndefined();
      expect(partial.authorities[bhasin].sourceLookupFailure).toEqual({ reason: "rate-limited",
        retryAfter: new Date(until).toISOString() });
      // Its other citation forms are not asked during the outage.
      expect(resolve.mock.calls.filter(([citation]) => citation !== "2016 SCC 27")).toHaveLength(1);

      // A retry inside the window asks nothing and keeps the reason.
      resolve.mockClear();
      const { draft: early } = await resolveAuthoritiesSources(partial, services, undefined, bhasin);
      expect(resolve).not.toHaveBeenCalled();
      expect(early.authorities[bhasin].sourceLookupFailure?.reason).toBe("rate-limited");
      // After it, only the unanswered lookup is asked again; a definite miss clears the failure.
      vi.setSystemTime(until + 1000); limit = false;
      const { draft: retried } = await resolveAuthoritiesSources(early, services, undefined, bhasin);
      expect(resolve.mock.calls.every(([citation]) => citation !== "2016 SCC 27")).toBe(true);
      expect(resolve).toHaveBeenCalled();
      expect(retried.authorities[bhasin].sourceLookupFailure).toBeUndefined();
      await expect(resolveAuthoritiesSources(retried, services, undefined, bhasin)).rejects.toMatchObject({ status: 409 });
    } finally { vi.useRealTimers(); }
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
