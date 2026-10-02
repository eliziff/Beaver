import { describe, expect, it, vi } from "vitest";
import { applyAuthoritiesUserAction, folderPdfAuthority } from "./authoritiesActions";
import { authorityPassageTargets } from "./authoritiesBuild";
import { decodeAuthoritiesUserAction } from "./authoritiesActionContract";
import { authorityCitationForms, createAuthoritiesDraft, reduceAuthoritiesDraft,
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
    expect(parts[0].pinpoints).toContainEqual(expect.objectContaining({ kind: 'paragraph', text: '33' }));
    expect(parts[1].authorityId).toBe(original.occurrences[original.units[0].occurrenceIds[1]].authorityId);
    expect(parts[0].end).toBeLessThanOrEqual(parts[1].start);
    expect(original.units[0].occurrenceIds).toHaveLength(2);
    expect(original.occurrences[id].text).toBe('Bhasin v Hrynew, 2014 SCC 71 at para 33');
    expect(() => applyAuthoritiesUserAction(original, { type: 'set-citation-range', occurrenceId: id,
      start: -1, end })).toThrow();
  });
  it("clears a pinpoint attached to the wrong citation, and the citation keeps its range", () => {
    const whole = add(bodyDraft(), TEXT.slice(TEXT.indexOf("Bhasin")));
    const split = applyAuthoritiesUserAction(whole, { type: "split-occurrence",
      occurrenceId: whole.units[0].occurrenceIds[0], cursor: TEXT.indexOf("R v Jordan") });
    const [id] = split.units[0].occurrenceIds;
    expect(split.occurrences[id].pinpointSpan).not.toBeNull();

    const cleared = applyAuthoritiesUserAction(split, { type: "clear-pinpoint", occurrenceId: id });
    const occurrence = cleared.occurrences[id];
    expect(occurrence).toMatchObject({ pinpointSpan: null, pinpoints: [], reviewed: true, pinpointManual: true,
      start: split.occurrences[id].start, end: split.occurrences[id].end });
    expect(occurrence.authoritySpan).toEqual(split.occurrences[id].authoritySpan);
    expect(() => applyAuthoritiesUserAction(cleared,
      { type: "clear-pinpoint", occurrenceId: id })).toThrow(/no pinpoint/u);
    expect(() => applyAuthoritiesUserAction(cleared,
      { type: "clear-pinpoint", occurrenceId: "missing" })).toThrow(/not found/u);
  });

  it("keeps a citation's pinpoints wherever they lie, and never moves its range for them", () => {
    const auto = add(bodyDraft(), "Bhasin v Hrynew, 2014 SCC 71 at para 33");
    const [id] = auto.units[0].occurrenceIds, parsed = auto.occurrences[id];
    expect(parsed).toMatchObject({ pinpointSpan: { text: "33" }, pinpointPhrase: { text: "at para 33" },
      pinpoints: [{ kind: "paragraph", text: "33", ...at("33") }] });
    const act = (draft: AuthoritiesDraft, action: object) => applyAuthoritiesUserAction(draft,
      decodeAuthoritiesUserAction({ occurrenceId: id, ...action }));
    // A range that leaves the written pinpoint out keeps it, outside the range.
    const outside = act(auto, { type: "set-citation-range", ...at("Bhasin v Hrynew, 2014 SCC 71") }).occurrences[id];
    expect(outside).toMatchObject({ ...at("Bhasin v Hrynew, 2014 SCC 71"), pinpoints: parsed.pinpoints,
      pinpointSpan: parsed.pinpointSpan });
    // The assistant's pinpoint edit leaves the range as it is, as does the authority's.
    const pinned = act(act(auto, { type: "set-citation-range", ...at("Bhasin v Hrynew, 2014 SCC 71") }),
      { type: "set-pinpoint-span", ...at("at para 33") }).occurrences[id];
    expect(pinned).toMatchObject({ ...at("Bhasin v Hrynew, 2014 SCC 71"), pinpointManual: true,
      pinpoints: [{ kind: "paragraph", text: "33", ...at("33") }] });
    const respanned = act(auto, { type: "set-authority-span", ...at("Bhasin v Hrynew, 2014 SCC 71") }).occurrences[id];
    expect(respanned).toMatchObject({ ...at("Bhasin v Hrynew, 2014 SCC 71"), pinpoints: parsed.pinpoints });
    expect(() => act(auto, { type: "set-pinpoint-span", ...at("applied in") })).toThrow(/complete pinpoint/u);
  });

  it("sets pinpoints by place: a kind cycled, one removed, one added anywhere in the unit", () => {
    const text = "Thus Alpha v Beta, 2019 SCC 5 at paras 82, 91; and see Gamma v Delta, 2020 SCC 7 at para 4. " +
      "The Court later added (at para 120) that s 14 applies.";
    const cite = "Alpha v Beta, 2019 SCC 5 at paras 82, 91";
    const span = (needle: string, from = 0) => ({ start: text.indexOf(needle, from), end: text.indexOf(needle, from) + needle.length });
    const draft = applyAuthoritiesUserAction({ ...bodyDraft(), units: [{ ...bodyDraft().units[0], text }] },
      { type: "add-occurrence", unitId: "body:7", ...span(cite) });
    const [id] = draft.units[0].occurrenceIds, parsed = draft.occurrences[id];
    expect(parsed.pinpoints).toEqual([{ kind: "paragraph", text: "82", ...span("82") },
      { kind: "paragraph", text: "91", ...span("91") }]);
    const act = (from: AuthoritiesDraft, action: object) => applyAuthoritiesUserAction(from,
      decodeAuthoritiesUserAction({ occurrenceId: id, ...action }));
    const set = (from: AuthoritiesDraft, pinpoints: object[]) => act(from, { type: "set-pinpoints", pinpoints });

    // The first's kind changed, then a pinpoint written later in the paragraph added: its kind is
    // read from the words before it, and the citation's range stays as it was.
    const added = set(draft, [{ ...span("82"), kind: "page" }, span("91"), span("120")]).occurrences[id];
    expect(added).toMatchObject({ text: cite, ...span(cite), pinpointManual: true, reviewed: true,
      pinpoints: [{ kind: "page", text: "82" }, { kind: "paragraph", text: "91" }, { kind: "paragraph", text: "120", ...span("120") }],
      pinpointSpan: { start: span("82").start, end: span("120").end } });
    const edited = { ...draft, occurrences: { ...draft.occurrences, [id]: added } };
    expect(authorityPassageTargets(edited, parsed.authorityId!).map(({ locatorKind, locator }) => `${locatorKind} ${locator}`))
      .toEqual(["page 82", "paragraph 91", "paragraph 120"]);
    expect(set(draft, [span("14")]).occurrences[id].pinpoints).toEqual([{ kind: "section", text: "14", ...span("14") }]);
    // At most three, never over the authority, and none overlapping.
    expect(() => set(edited, [span("82"), span("91"), span("120"), span("14")])).toThrow(/at most three/u);
    expect(() => set(draft, [span("2019")])).toThrow(/without the authority/u);
    expect(() => set(draft, [span("82"), { start: span("82").start, end: span("91").end }])).toThrow(/overlap/u);
    // One removed; then a range edit keeps the reviewer's pinpoints, and an emptied list stays empty.
    const removed = set(edited, [span("91"), span("120")]);
    expect(removed.occurrences[id].pinpoints.map(({ text }) => text)).toEqual(["91", "120"]);
    const narrowed = act(removed, { type: "set-citation-range", ...span("Alpha v Beta, 2019 SCC 5") }).occurrences[id];
    expect(narrowed).toMatchObject({ text: "Alpha v Beta, 2019 SCC 5", pinpoints: removed.occurrences[id].pinpoints });
    const empty = act(set(removed, []), { type: "set-citation-range", ...span(cite) }).occurrences[id];
    expect(empty).toMatchObject({ pinpoints: [], pinpointSpan: null, pinpointManual: true });
    expect(() => act(draft, { type: "set-pinpoints" })).toThrow();
    expect(() => set(draft, [{ ...span("82"), kind: "chapter" }])).toThrow();
  });

  it("finds the pinpoint a citation added without it goes on to write", () => {
    const text = "See Gamma v Delta, 2020 SCC 7 at para 4; and Ibid at 9.";
    const span = (needle: string) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
    const draft = applyAuthoritiesUserAction({ ...bodyDraft(), units: [{ ...bodyDraft().units[0], text }] },
      { type: "add-occurrence", unitId: "body:7", ...span("Gamma v Delta, 2020 SCC 7") });
    const [id] = draft.units[0].occurrenceIds;
    expect(draft.occurrences[id]).toMatchObject({ text: "Gamma v Delta, 2020 SCC 7",
      pinpoints: [{ kind: "paragraph", text: "4", ...span("4") }], pinpointPhrase: { text: "at para 4" } });
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

describe("a PDF found in the watched folder", () => {
  // Invented decisions: two the brief cites, and their opening pages as a reader's browser reads them.
  const cases = { harbour: ["Harbour Paddlers Co-operative v Canada (Attorney General)", "2031 FC 212"],
    lakeshore: ["Lakeshore Rowing Club v Marsh Harbour Board", "2030 ABKB 417"] } as const;
  const draft = () => Object.entries(cases).reduce((current, [id, [name, citation]]) =>
    reduceAuthoritiesDraft(current, { type: "add-authority", authority: { id, key: id, kind: "case", citation, name,
      displayName: null, excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" } } }), createAuthoritiesDraft({ kind: "manual" }));
  /** The draft once one case has a PDF built from its source text. */
  const rebuilt = () => { const state = draft(); state.authorities.harbour.source = { kind: "attached", sources: [{
    bindingRole: "harbour", filename: "h.pdf", sourceSha256: "a".repeat(64), sourceUrl: null,
    origin: "reconstructed", language: "en" }] }; return state; };
  const reasons = (subject: string) => Array.from({ length: 30 }, (_, index) =>
    `the ${subject} board weighed notice number ${index} against the launch season and the river levels it recorded`).join(" ");
  const opening = (heading: string, body: string) => [`${heading}\n[1] ${body.slice(0, 900)}`, body.slice(900, 2400)];
  const references: Record<string, string> = { harbour: reasons("harbour"), lakeshore: reasons("lakeshore") };
  const match = (filename: string, pages: string[], state = draft()) =>
    folderPdfAuthority(state, { filename, pages }, async ({ id }) => references[id] ?? "");

  it("is the case still without a PDF that its opening citation names, whatever the file is called", async () => {
    const heading = `Federal Court\nCitation: ${cases.harbour.join(", ")}\nDate: 20310304`;
    await expect(match("document.do.pdf", opening(heading, reasons("unrelated")))).resolves.toBe("harbour");
    // Another case's citation leaves the file unbound, as does a case that already has its PDF.
    await expect(match("document.pdf", opening("Federal Court\nCitation: Hill v Shore, 2031 FC 9", reasons("harbour"))))
      .resolves.toBeNull();
    await expect(match("document.do.pdf", opening(heading, reasons("unrelated")), rebuilt())).resolves.toBeNull();
  });

  it("falls back to agreeing exactly with the A2AJ text of one case, and abstains when two agree", async () => {
    await expect(match("judgment.pdf", opening("Reasons for Judgment", references.lakeshore))).resolves.toBe("lakeshore");
    references.harbour = references.lakeshore;
    try { await expect(match("judgment.pdf", opening("Reasons for Judgment", references.lakeshore))).resolves.toBeNull(); }
    finally { references.harbour = reasons("harbour"); }
  });

  it("takes a scan by its CanLII file name alone, and nothing else by name", async () => {
    await expect(match("2030abkb417 (1).pdf", ["", ""])).resolves.toBe("lakeshore");
    await expect(match("scan.pdf", ["", ""])).resolves.toBeNull();
  });
});
