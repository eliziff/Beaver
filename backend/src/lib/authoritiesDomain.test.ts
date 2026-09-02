import { describe, expect, it, vi } from "vitest";

vi.mock("./structureNative", () => ({
  structureNative: () => { throw new Error("citation scan must not run"); },
}));

import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import {
  AuthoritiesDomainError,
  type AuthoritiesDraft,
  type AuthorityIdentity,
  type AuthorityOccurrence,
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  decodeAuthoritiesDraft,
  reduceAuthoritiesDraft,
  validateAuthoritiesDraft,
} from "./authoritiesDomain";

const snapshot = { documentId: "brief", versionId: "v1", sha256: "b".repeat(64) };
const sourceImport = {
  kind: "document" as const,
  bindingRole: "source" as const,
  filename: "Brief.docx",
  fileType: "docx" as const,
  snapshot,
};
const sourceBindings = {
  source: { kind: "document" as const, documentId: "brief", version: "latest" as const },
};

const receipt = (evidenceId: string, label: string): LegalEvidenceReceipt => ({
  evidence_id: evidenceId,
  provider: "a2aj",
  jurisdiction: "ca",
  source_class: "case",
  stable_source_id: "2009-scc-32",
  source_sha256: "c".repeat(64),
  scope: "passage",
  block_id: label,
  span_sha256: `${evidenceId}-sha`,
  span_text: "Evidence",
  citation: "2009 SCC 32",
  name: "R v Grant",
  dataset: "SCC",
  language: "en",
  version: "2009",
  external_url: "https://example.test/grant",
  locator: { kind: "paragraph", label },
  resolver_version: "a2aj-inline-v1",
});

const authority = (id: string, key = id): AuthorityIdentity => ({
  id, key, kind: "case", citation: id, name: id, displayName: null,
  tabLabel: null,
  evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
  source: { kind: "unresolved" },
});

const occurrence = (
  id: string,
  text: string,
  start: number,
  end: number,
  authorityId: string | null,
  localOrdinal = 0,
): AuthorityOccurrence => ({
  id, unitId: "footnote:1", start, end, text: text.slice(start, end), kind: "case",
  citation: text.slice(start, end), authorityId, reference: null, pinpoints: [],
  authoritySpan: { start, end, text: text.slice(start, end) },
  coreSpan: { start, end, text: text.slice(start, end) }, pinpointSpan: null,
  evidenceIds: [], sourceTextSha256: "unit-sha", localOrdinal, reviewed: false,
});

describe("authorities draft domain", () => {
  it("decodes canonical and rejects malformed nested durable state", () => {
    const canonical = createAuthoritiesDraft({ kind: "manual" });
    expect(decodeAuthoritiesDraft(canonical)).toEqual(canonical);
    const oldShape = structuredClone(canonical) as Partial<AuthoritiesDraft>;
    delete oldShape.settings; delete oldShape.bookParts;
    expect(decodeAuthoritiesDraft(oldShape)).toEqual(canonical);

    const stored = structuredClone({ ...canonical,
      bindings: { pdf: { kind: "document" as const, documentId: "pdf", version: "latest" as const } },
      authorities: { a: { ...authority("a"), source: { kind: "attached" as const,
        bindingRole: "pdf", filename: "a.pdf", sourceSha256: "a".repeat(64),
        sourceUrl: null } } }, authorityOrder: ["a"],
    }) as unknown as Partial<AuthoritiesDraft> & {
      authorities: Record<string, Record<string, unknown>>;
    };
    delete stored.settings; delete stored.bookParts; delete stored.authorities.a.tabLabel;
    expect(decodeAuthoritiesDraft(stored)).toMatchObject({ authorities: { a: {
      tabLabel: null, source: { origin: "manual" },
    } } });
    const incomplete = structuredClone(canonical) as Partial<AuthoritiesDraft>;
    delete incomplete.bookParts;
    expect(decodeAuthoritiesDraft(incomplete)).toBeNull();

    const malformedAuthority = structuredClone({
      ...canonical,
      authorities: { a: authority("a") },
      authorityOrder: ["a"],
    }) as unknown as { authorities: Record<string, Record<string, unknown>> };
    delete malformedAuthority.authorities.a.excluded;
    malformedAuthority.authorities.a.name = 42;
    expect(decodeAuthoritiesDraft(malformedAuthority)).toBeNull();

    expect(decodeAuthoritiesDraft({
      ...canonical,
      units: [{ id: "unit-1", kind: "alien", ordinal: "first", footnoteId: {},
        footnoteRefs: [], pageNumbers: [], text: "", occurrenceIds: [] }],
    })).toBeNull();

    expect(decodeAuthoritiesDraft({
      ...canonical,
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text: "x", occurrenceIds: ["occ-1"] }],
      occurrences: { "occ-1": { id: "occ-1", unitId: "footnote:1", start: 0,
        end: 1, text: "x", kind: "alien", citation: 42, authorityId: null,
        reference: null, pinpoints: "bad", evidenceIds: null, sourceTextSha256: "x",
        localOrdinal: 0, reviewed: "yes" } },
    })).toBeNull();

    expect(decodeAuthoritiesDraft({
      ...createAuthoritiesDraft(sourceImport, sourceBindings),
      ledger: { document: snapshot },
    })).toBeNull();
  });

  it("offers source-document output only for imported document drafts", () => {
    const source = createAuthoritiesDraft(sourceImport, sourceBindings);
    expect(reduceAuthoritiesDraft(source,
      { type: "set-document-output", enabled: true }).insertIntoDocument).toBe(true);
    const pdf = createAuthoritiesDraft({ ...sourceImport, filename: "Factum.pdf",
      fileType: "pdf" }, sourceBindings);
    expect(reduceAuthoritiesDraft(pdf,
      { type: "set-document-output", enabled: true }).insertIntoDocument).toBe(true);
    expect(() => reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "set-document-output", enabled: true }))
      .toThrowError(AuthoritiesDomainError);
  });

  it("applies data-backed court presets, locked output rules, and editable tabs", () => {
    const general = createAuthoritiesDraft({ kind: "manual" });
    expect(general).toMatchObject({ outputMode: "book", settings: {
      profileId: "general", sourceMode: "automatic", tableOrder: "alphabetical",
    } });
    const appeal = reduceAuthoritiesDraft(general,
      { type: "set-profile", profileId: "ab-court-of-appeal" });
    expect(appeal).toMatchObject({ outputMode: "table", settings: {
      tableDelivery: "linked-append", tableLocation: "pinpoints",
      tableOrder: "first-reference", passageMarking: "none", missingSourcePolicy: "omit",
    } });
    const appealDocument = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport,
      sourceBindings), { type: "set-profile", profileId: "ab-court-of-appeal" });
    expect(appealDocument.insertIntoDocument).toBe(true);
    expect(() => reduceAuthoritiesDraft(appeal,
      { type: "set-output-mode", outputMode: "book" })).toThrow(AuthoritiesDomainError);
    expect(() => reduceAuthoritiesDraft(appeal, { type: "set-settings",
      settings: { tableOrder: "alphabetical" } })).toThrow(AuthoritiesDomainError);
    for (const profileId of ["ab-court-of-kings-bench", "federal-court",
      "federal-court-of-appeal"] as const) {
      expect(reduceAuthoritiesDraft(general, { type: "set-profile", profileId }))
        .toMatchObject({ outputMode: "book", settings: {
          sourceMode: "automatic", scannedPdfPolicy: "full",
        } });
    }
    const kingsBench = reduceAuthoritiesDraft(general,
      { type: "set-profile", profileId: "ab-court-of-kings-bench" });
    expect(kingsBench.settings).toMatchObject({ missingSourcePolicy: "omit" });
    expect(reduceAuthoritiesDraft(kingsBench,
      { type: "set-output-mode", outputMode: "table" }).outputMode).toBe("table");
    expect(reduceAuthoritiesDraft(kingsBench,
      { type: "set-output-mode", outputMode: "both" }).outputMode).toBe("both");
    for (const court of [kingsBench, appeal]) expect(() => reduceAuthoritiesDraft(court, {
      type: "set-settings", settings: { missingSourcePolicy: "placeholder" },
    })).toThrow(AuthoritiesDomainError);
    const federal = reduceAuthoritiesDraft(general,
      { type: "set-profile", profileId: "federal-court" });
    expect(federal.settings).toMatchObject({ filingMedium: "electronic", bookRole: "applicant" });
    expect(reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { filingMedium: "paper", bookRole: "respondent" } }).settings)
      .toMatchObject({ filingMedium: "paper", bookRole: "respondent" });
    expect(reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { bookRole: "joint" } }).settings.bookRole).toBe("joint");
    const federalAppeal = reduceAuthoritiesDraft(general,
      { type: "set-profile", profileId: "federal-court-of-appeal" });
    expect(federalAppeal.settings).toMatchObject({ filingMedium: "electronic", bookRole: "joint" });
    for (const bookRole of ["appellant", "respondent", "intervener"] as const) {
      expect(reduceAuthoritiesDraft(federalAppeal,
        { type: "set-settings", settings: { bookRole } }).settings.bookRole).toBe(bookRole);
    }
    const added = reduceAuthoritiesDraft(general,
      { type: "add-authority", authority: authority("case") });
    expect(reduceAuthoritiesDraft(added, { type: "set-authority-tab",
      authorityId: "case", tabLabel: "  A-1  " }).authorities.case.tabLabel).toBe("A-1");
  });

  it("binds one cover, one index, and ordered supplemental PDFs", () => {
    const input = (name: string, digest: string) => ({ kind: "local-file" as const,
      handleId: `${name}-handle`, lastSeen: { name: `${name}.pdf`, size: 10,
        modified: 1, sha256: digest } });
    const pdf = (name: string, digest: string) => ({ bindingRole: `book:${name}`,
      filename: `${name}.pdf`, sourceSha256: digest });
    let draft = createAuthoritiesDraft({ kind: "manual" });
    draft = reduceAuthoritiesDraft(draft, { type: "set-book-part", slot: "cover",
      pdf: pdf("cover", "1".repeat(64)), binding: input("cover", "1".repeat(64)) });
    draft = reduceAuthoritiesDraft(draft, { type: "set-book-part", slot: "index",
      pdf: pdf("index", "2".repeat(64)), binding: input("index", "2".repeat(64)) });
    for (const [id, digest] of [["one", "3".repeat(64)], ["two", "4".repeat(64)]]) {
      draft = reduceAuthoritiesDraft(draft, { type: "set-book-supplement", supplement: {
        id, ...pdf(id, digest), title: `  Document ${id}  `, tab: `  Appendix ${id}  `,
      }, binding: input(id, digest) });
    }
    draft = reduceAuthoritiesDraft(draft, { type: "update-book-supplement", id: "two",
      title: "  Updated document  ", tab: "  Appendix B  " });
    draft = reduceAuthoritiesDraft(draft,
      { type: "reorder-book-supplements", ids: ["two", "one"] });
    expect(draft.bookParts).toMatchObject({ cover: { bindingRole: "book:cover" },
      index: { bindingRole: "book:index" }, supplements: [
        { id: "two", title: "Updated document", tab: "Appendix B" },
        { id: "one", title: "Document one", tab: "Appendix one" },
      ] });
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
    expect(decodeAuthoritiesDraft(draft)).toEqual(draft);

    const duplicateTab = structuredClone(draft);
    duplicateTab.bookParts.supplements[1].tab = "Appendix B";
    expect(decodeAuthoritiesDraft(duplicateTab)).toBeNull();
    expect(() => reduceAuthoritiesDraft(draft, { type: "set-book-part", slot: "index",
      pdf: pdf("cover", "1".repeat(64)), binding: input("cover", "1".repeat(64)) }))
      .toThrow("Binding is assigned more than once");

    draft = reduceAuthoritiesDraft(draft, { type: "clear-book-part", slot: "index" });
    draft = reduceAuthoritiesDraft(draft, { type: "remove-book-supplement", id: "one" });
    expect(Object.keys(draft.bindings).sort()).toEqual(["book:cover", "book:two"]);
  });

  it("keeps grounded identity orthogonal to unresolved review state", () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: authority("manual", "2024-abkb-1"),
    });
    draft.authorities.manual.sourceIdentity = { provider: "a2aj",
      stableSourceId: "2024-abkb-1", sourceSha256: "a".repeat(64),
      version: null, externalUrl: null };
    expect(validateAuthoritiesDraft(draft))
      .toContain("Unresolved authority has a grounded source identity: manual");
  });

  it("projects receipts and ingests their exact-version ledger without a citation scan", () => {
    const seed = authoritySeedFromReceipts("grant-key", [
      receipt("e2", "14"), receipt("e1", "12"), receipt("e1", "12"),
    ]);
    expect(seed).toMatchObject({
      key: "grant-key", kind: "case", stableSourceId: "2009-scc-32",
      evidenceIds: ["e1", "e2"],
      locators: [{ kind: "paragraph", label: "12" }, { kind: "paragraph", label: "14" }],
    });
    const seeded = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "add-seed", seed });
    expect(seeded.authorities[seed.key].source).toMatchObject({
      kind: "resolved",
    });
    expect(seeded.authorities[seed.key]).toMatchObject({
      sourceIdentity: { stableSourceId: "2009-scc-32", version: "2009" },
      evidenceIds: ["e1", "e2"],
      locators: [{ kind: "paragraph", label: "12" },
        { kind: "paragraph", label: "14" }],
    });

    const text = "2009 SCC 32; Ibid";
    const initial = createAuthoritiesDraft(sourceImport, sourceBindings);
    const next = reduceAuthoritiesDraft(initial, { type: "ingest-ledger", ledger: {
      schemaVersion: "beaver.authority-ledger.v1",
      document: snapshot,
      seeds: [seed],
      occurrences: [
        { id: "cite-1", markerId: "m1", targetId: "t1", authorityKey: seed.key,
          unit: { id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
            footnoteRefs: [], pageNumbers: [], text, sourceTextSha256: "unit-sha" },
          start: 0, end: 11,
          text: "2009 SCC 32", displayedForm: "full",
          pinpoints: [{ kind: "paragraph", text: "12" }],
          evidenceIds: ["e1"], localOrdinal: 0 },
        { id: "cite-2", markerId: "m2", targetId: "t1", authorityKey: seed.key,
          unit: { id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
            footnoteRefs: [], pageNumbers: [], text, sourceTextSha256: "unit-sha" },
          start: 13, end: 17,
          text: "Ibid", displayedForm: "ibid", pinpoints: [],
          evidenceIds: ["e2"], localOrdinal: 1 },
      ],
    } });

    expect(initial.authorityOrder).toEqual([]);
    expect(next.authorities["grant-key"]).toMatchObject({
      source: { kind: "resolved" },
      sourceIdentity: { stableSourceId: "2009-scc-32", sourceSha256: "c".repeat(64) },
    });
    expect(next.occurrences["cite-2"]).toMatchObject({
      kind: "reference", authorityId: "grant-key", reviewed: true,
      reference: { kind: "ibid", targetAuthorityId: "grant-key" },
    });
    expect(validateAuthoritiesDraft(next)).toEqual([]);
    expect(decodeAuthoritiesDraft(next)).toEqual(next);
    expect(() => reduceAuthoritiesDraft(
      createAuthoritiesDraft(
        { ...sourceImport, snapshot: { ...snapshot, versionId: "v2" } }, sourceBindings,
      ),
      { type: "ingest-ledger", ledger: next.ledger! },
    )).toThrow("does not match");
  });

  it("edits review state immutably with explicit identities and reference targets", () => {
    const text = "Case A; Case B";
    const base: AuthoritiesDraft = {
      ...createAuthoritiesDraft({ kind: "manual" }),
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text, occurrenceIds: ["whole"] }],
      occurrences: { whole: occurrence("whole", text, 0, text.length, "a") },
      authorities: { a: authority("a"), b: authority("b") },
      authorityOrder: ["a", "b"],
    };
    const left = occurrence("left", text, 0, 6, "a");
    const right = occurrence("right", text, 8, 14, "a", 1);
    let draft = reduceAuthoritiesDraft(base, {
      type: "split-occurrence", occurrenceId: "whole", replacements: [left, right],
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "relink-occurrence", occurrenceId: "right", authorityId: "b",
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "set-reference", occurrenceId: "right",
      reference: { kind: "supra", targetAuthorityId: "b" },
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "set-reviewed", occurrenceId: "left", reviewed: true,
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "rename-authority", authorityId: "b", displayName: "  Better name  ",
    });
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "b",
      citation: "  2024 SCC 1  ", name: "  Example v Test  ", source: {
        provider: "a2aj", stableSourceId: "2024-scc-1",
        sourceSha256: "d".repeat(64), version: "2024", externalUrl: null,
      } });
    draft = reduceAuthoritiesDraft(draft, {
      type: "exclude-authority", authorityId: "a", excluded: true,
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "reorder-authorities", authorityIds: ["b", "a"],
    });
    draft = reduceAuthoritiesDraft(draft, {
      type: "begin-canlii-handoff", authorityId: "b",
      pageUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html",
    });
    draft = reduceAuthoritiesDraft(draft, { type: "set-output-mode", outputMode: "book" });

    expect(base.occurrences.whole).toBeDefined();
    expect(draft.occurrences.left.reviewed).toBe(true);
    expect(draft.occurrences.right).toMatchObject({ authorityId: "b", reviewed: true,
      reference: { kind: "supra", targetAuthorityId: "b" } });
    draft = reduceAuthoritiesDraft(draft, {
      type: "set-reference", occurrenceId: "right", reference: null,
    });
    expect(draft.occurrences.right).toMatchObject({
      kind: "reference", authorityId: null, reference: null, reviewed: true,
    });
    expect(draft.authorities.b).toMatchObject({ displayName: "Better name",
      citation: "2024 SCC 1", name: "Example v Test",
      source: { kind: "pending-canlii", authorityKey: "b",
        pdfUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf" } });
    expect(draft.authorityOrder).toEqual(["b", "a"]);
    expect(draft.outputMode).toBe("book");
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "b",
      bindingRole: "authority:b", binding: { kind: "local-file", handleId: "handle-b",
        lastSeen: { name: "grant.pdf", size: 20, modified: 1,
          sha256: "e".repeat(64) } },
      filename: "grant.pdf", sourceSha256: "e".repeat(64), sourceUrl: null });
    expect(draft.authorities.b.source).toMatchObject({
      kind: "attached", bindingRole: "authority:b", filename: "grant.pdf",
    });
    expect(draft.bindings).toHaveProperty("authority:b");

    const merged = occurrence("merged", text, 0, text.length, "b");
    draft = reduceAuthoritiesDraft(draft, {
      type: "merge-occurrences", occurrenceIds: ["left", "right"], replacement: merged,
    });
    expect(draft.units[0].occurrenceIds).toEqual(["merged"]);
    expect(() => reduceAuthoritiesDraft(draft, {
      type: "reorder-authorities", authorityIds: ["a"],
    })).toThrow(AuthoritiesDomainError);
  });

  it("carries reviewed partitions only across exact, unambiguous unit matches", () => {
    const text = "Case A; Case A";
    const old: AuthoritiesDraft = {
      ...createAuthoritiesDraft({ kind: "manual" }),
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [[1, 0]], pageNumbers: [], text,
        occurrenceIds: ["old-1", "old-2"] }],
      occurrences: {
        "old-1": { ...occurrence("old-1", text, 0, 6, "old-a"), reviewed: true },
        "old-2": { ...occurrence("old-2", text, 8, 14, "old-a"), reviewed: true },
      },
      authorities: { "old-a": { ...authority("old-a", "same-key"), displayName: "Grant",
        tabLabel: "A-1", excluded: true, evidenceIds: ["receipt-old"],
        locators: [{ kind: "paragraph", label: "12" }],
        sourceIdentity: { provider: "a2aj", stableSourceId: "grant",
          sourceSha256: "f".repeat(64), version: "2009", externalUrl: null },
        source: { kind: "resolved" } } },
      authorityOrder: ["old-a"],
    };
    const refreshed = reduceAuthoritiesDraft(old, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {},
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [[1, 0]], pageNumbers: [], text, occurrenceIds: ["fresh"] }],
      occurrences: { fresh: occurrence("fresh", text, 0, 6, null) },
      authorities: { "new-a": authority("new-a", "same-key") },
      authorityOrder: ["new-a"],
    } });

    expect(refreshed.authorities["new-a"]).toMatchObject({
      displayName: "Grant", tabLabel: "A-1", excluded: true, evidenceIds: ["receipt-old"],
      locators: [{ kind: "paragraph", label: "12" }],
      source: { kind: "resolved" }, sourceIdentity: { stableSourceId: "grant" },
    });
    expect(refreshed.occurrences.fresh).toMatchObject({ authorityId: null, reviewed: false });

    const split = reduceAuthoritiesDraft({ ...old, occurrences: {
      ...old.occurrences, "old-2": { ...old.occurrences["old-2"], localOrdinal: 8 },
    } }, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {}, units: refreshed.units,
      occurrences: { fresh: occurrence("fresh", text, 0, 6, null) },
      authorities: { "new-a": authority("new-a", "same-key") },
      authorityOrder: ["new-a"],
    } });
    expect(split.units[0].occurrenceIds).toEqual(["old-1", "old-2"]);
    expect(split.units[0].occurrenceIds.map((id) => split.occurrences[id].authorityId))
      .toEqual(["new-a", "new-a"]);

    const corrected = { ...old.occurrences["old-1"], end: text.length, text,
      pinpointSpan: { start: 8, end: text.length, text: text.slice(8) },
      pinpoints: [{ kind: "paragraph" as const, text: text.slice(8) }] };
    const unambiguous = reduceAuthoritiesDraft({
      ...old,
      units: [{ ...old.units[0], occurrenceIds: ["old-1"] }],
      occurrences: { "old-1": corrected },
      authorities: { "old-a": { ...old.authorities["old-a"],
        sourceIdentity: null, source: { kind: "unresolved" } } },
    }, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {}, units: [{ ...refreshed.units[0],
        occurrenceIds: ["fresh-1", "fresh-2"] }],
      occurrences: {
        "fresh-1": occurrence("fresh-1", text, 0, 6, null),
        "fresh-2": occurrence("fresh-2", text, 8, text.length, null, 1),
      },
      authorities: { "new-a": { ...authority("new-a", "same-key"),
        sourceIdentity: { provider: "a2aj", stableSourceId: "new-source",
          sourceSha256: "a".repeat(64), version: "2026", externalUrl: null },
        source: { kind: "resolved" } } },
      authorityOrder: ["new-a"],
    } });
    expect(unambiguous.units[0].occurrenceIds).toEqual(["old-1"]);
    expect(unambiguous.occurrences["old-1"]).toMatchObject({ authorityId: "new-a",
      reviewed: true, start: 0, end: text.length,
      authoritySpan: { start: 0, end: 6 }, pinpointSpan: { start: 8, end: text.length } });
    expect(unambiguous.authorities["new-a"]).toMatchObject({
      source: { kind: "resolved" },
      sourceIdentity: { stableSourceId: "new-source", version: "2026" },
    });

    const unmapped = reduceAuthoritiesDraft(unambiguous, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {}, units: refreshed.units,
      occurrences: { fresh: occurrence("fresh", text, 0, 6, "other") },
      authorities: { other: authority("other", "other-key") }, authorityOrder: ["other"],
    } });
    expect(unmapped.units[0].occurrenceIds).toEqual(["fresh"]);
    expect(unmapped.occurrences.fresh).toMatchObject({ authorityId: "other", reviewed: false });
  });

  it("merges receipts only for the same exact source identity", () => {
    const sourceIdentity = { provider: "a2aj", stableSourceId: "grant",
      sourceSha256: "a".repeat(64), version: "2009", externalUrl: null };
    const binding = { kind: "document" as const, documentId: "grant-pdf",
      version: { versionId: "grant-v1", sha256: "b".repeat(64) } };
    const old: AuthoritiesDraft = {
      ...createAuthoritiesDraft({ kind: "manual" }),
      bindings: { "authority:grant": binding },
      authorities: { old: { ...authority("old", "grant-key"),
        evidenceIds: ["old-evidence"], locators: [{ kind: "paragraph", label: "12" }],
        sourceIdentity, source: { kind: "attached", bindingRole: "authority:grant",
          filename: "grant.pdf", sourceSha256: "b".repeat(64), sourceUrl: null,
          origin: "manual" } } },
      authorityOrder: ["old"],
    };
    const reviewWith = (identity: typeof sourceIdentity, evidenceId: string,
      locator: string): Parameters<typeof reduceAuthoritiesDraft>[1] => ({
      type: "refresh", review: { import: { kind: "manual" }, bindings: {}, units: [],
        occurrences: {}, authorities: { fresh: { ...authority("fresh", "grant-key"),
          evidenceIds: [evidenceId], locators: [{ kind: "paragraph", label: locator }],
          sourceIdentity: identity, source: { kind: "resolved" } } },
        authorityOrder: ["fresh"] },
    });

    const sameSource = reduceAuthoritiesDraft(old,
      reviewWith(sourceIdentity, "new-evidence", "14"));
    expect(sameSource.authorities.fresh).toMatchObject({
      evidenceIds: ["new-evidence", "old-evidence"],
      locators: [{ kind: "paragraph", label: "12" },
        { kind: "paragraph", label: "14" }],
      source: { kind: "attached", bindingRole: "authority:grant" },
    });
    expect(sameSource.bindings).toHaveProperty("authority:grant");

    const changedSource = reduceAuthoritiesDraft(old, reviewWith({ ...sourceIdentity,
      version: "2010" }, "replacement-evidence", "20"));
    expect(changedSource.authorities.fresh).toMatchObject({
      evidenceIds: ["replacement-evidence"],
      locators: [{ kind: "paragraph", label: "20" }],
      sourceIdentity: { sourceSha256: "a".repeat(64), version: "2010" },
      source: { kind: "resolved" },
    });
    expect(changedSource.bindings).not.toHaveProperty("authority:grant");
    const changedHash = reduceAuthoritiesDraft(old, reviewWith({ ...sourceIdentity,
      sourceSha256: "c".repeat(64) }, "hash-evidence", "22"));
    expect(changedHash.authorities.fresh).toMatchObject({
      evidenceIds: ["hash-evidence"], sourceIdentity: { sourceSha256: "c".repeat(64) },
    });
  });

  it("collapses grounded citation aliases without losing user state or references", () => {
    const text = "[2015] 1 SCR 331; 2015 SCC 5; Carter, supra";
    let draft: AuthoritiesDraft = {
      ...createAuthoritiesDraft({ kind: "manual" }),
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text,
        occurrenceIds: ["reporter-cite", "neutral-cite", "french-supra"] }],
      occurrences: {
        "reporter-cite": occurrence("reporter-cite", text, 0, 16, "reporter"),
        "neutral-cite": occurrence("neutral-cite", text, 18, 28, "neutral", 1),
        "french-supra": { ...occurrence("french-supra", text, 30, text.length, "french", 2),
          kind: "reference", reference: { kind: "supra", targetAuthorityId: "french" } },
      },
      authorities: {
        reporter: { ...authority("reporter"), citation: "[2015] 1 SCR 331",
          name: null, tabLabel: "A", excluded: true, evidenceIds: ["reporter-evidence"],
          locators: [{ kind: "paragraph", label: "1" }] },
        neutral: { ...authority("neutral"), citation: "2015 SCC 5",
          displayName: "Carter (Charter)", evidenceIds: ["neutral-evidence"],
          locators: [{ kind: "paragraph", label: "2" }] },
        french: { ...authority("french"), citation: "2015 CSC 5", excluded: true,
          evidenceIds: ["french-evidence"] },
      },
      authorityOrder: ["reporter", "neutral", "french"],
    };
    const attach = (authorityId: string, role: string, digest: string) => {
      draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId,
        bindingRole: role, binding: { kind: "local-file", handleId: role,
          lastSeen: { name: `${role}.pdf`, size: 10, modified: 1, sha256: digest } },
        filename: `${role}.pdf`, sourceSha256: digest, sourceUrl: null });
    };
    const source = { provider: "a2aj", stableSourceId: "a2aj:en:scc:2015 scc 5",
      sourceSha256: "c".repeat(64), version: "2015-02-06", externalUrl: null };
    attach("neutral", "authority:neutral", "d".repeat(64));
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "neutral",
      citation: "2015 SCC 5", name: "Carter v Canada (Attorney General)", source });
    attach("french", "authority:french", "e".repeat(64));
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "french",
      citation: "2015 SCC 5", name: "Carter v Canada (Attorney General)", source });
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "reporter",
      citation: "2015 SCC 5", name: "Carter v Canada (Attorney General)", source });

    expect(draft.authorityOrder).toEqual(["reporter"]);
    expect(draft.authorities.reporter).toMatchObject({
      citation: "2015 SCC 5", name: "Carter v Canada (Attorney General)",
      displayName: "Carter (Charter)", tabLabel: "A", excluded: false,
      evidenceIds: ["french-evidence", "neutral-evidence", "reporter-evidence"],
      locators: [{ kind: "paragraph", label: "1" }, { kind: "paragraph", label: "2" }],
      sourceIdentity: source, source: { kind: "attached", bindingRole: "authority:neutral" },
    });
    expect(Object.keys(draft.bindings)).toEqual(["authority:neutral"]);
    expect(Object.values(draft.occurrences).map(({ authorityId }) => authorityId))
      .toEqual(["reporter", "reporter", "reporter"]);
    expect(draft.occurrences["french-supra"].reference)
      .toEqual({ kind: "supra", targetAuthorityId: "reporter" });
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
  });
});
