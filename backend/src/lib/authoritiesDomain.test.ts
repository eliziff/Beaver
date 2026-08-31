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
  evidenceIds: [], sourceTextSha256: "unit-sha", localOrdinal, reviewed: false,
});

describe("authorities draft domain", () => {
  it("decodes canonical and rejects malformed nested durable state", () => {
    const canonical = createAuthoritiesDraft({ kind: "manual" });
    expect(decodeAuthoritiesDraft(canonical)).toEqual(canonical);

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

  it("offers source-document output only for imported Word drafts", () => {
    const source = createAuthoritiesDraft(sourceImport, sourceBindings);
    expect(reduceAuthoritiesDraft(source,
      { type: "set-document-output", enabled: true }).insertIntoDocument).toBe(true);
    expect(() => reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "set-document-output", enabled: true }))
      .toThrowError(AuthoritiesDomainError);
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
    expect(draft.occurrences.right).toMatchObject({ authorityId: "b", reviewed: true,
      reference: { kind: "supra", targetAuthorityId: "b" } });
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

  it("carries decisions only across unambiguous structural occurrence matches", () => {
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
        excluded: true, evidenceIds: ["receipt-old"],
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
      displayName: "Grant", excluded: true, evidenceIds: ["receipt-old"],
      locators: [{ kind: "paragraph", label: "12" }],
      source: { kind: "resolved" }, sourceIdentity: { stableSourceId: "grant" },
    });
    expect(refreshed.occurrences.fresh).toMatchObject({ authorityId: null, reviewed: false });

    const unambiguous = reduceAuthoritiesDraft({
      ...old,
      units: [{ ...old.units[0], occurrenceIds: ["old-1"] }],
      occurrences: { "old-1": old.occurrences["old-1"] },
      authorities: { "old-a": { ...old.authorities["old-a"],
        sourceIdentity: null, source: { kind: "unresolved" } } },
    }, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {}, units: refreshed.units,
      occurrences: { fresh: occurrence("fresh", text, 0, 6, null) },
      authorities: { "new-a": { ...authority("new-a", "same-key"),
        sourceIdentity: { provider: "a2aj", stableSourceId: "new-source",
          sourceSha256: "a".repeat(64), version: "2026", externalUrl: null },
        source: { kind: "resolved" } } },
      authorityOrder: ["new-a"],
    } });
    expect(unambiguous.occurrences.fresh).toMatchObject({ authorityId: "new-a", reviewed: true });
    expect(unambiguous.authorities["new-a"]).toMatchObject({
      source: { kind: "resolved" },
      sourceIdentity: { stableSourceId: "new-source", version: "2026" },
    });
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
          filename: "grant.pdf", sourceSha256: "b".repeat(64), sourceUrl: null } } },
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
});
