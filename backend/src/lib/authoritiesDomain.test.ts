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
  authorityCitationForms,
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
  authoritySpan: { start, end, text: text.slice(start, end) },
  coreSpan: { start, end, text: text.slice(start, end) }, pinpointSpan: null,
  evidenceIds: [], sourceTextSha256: "unit-sha", localOrdinal, reviewed: false,
});

describe("authorities draft domain", () => {
  it("corrects the canonical identity of a manual PDF without replacing its source", () => {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { ...authority("2009scc32"), kind: "other",
        citation: "2009scc32", name: "2009scc32" },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "2009scc32",
      bindingRole: "authority:2009scc32", binding: { kind: "local-file", handleId: "grant" },
      filename: "2009scc32.pdf", sourceSha256: "a".repeat(64), sourceUrl: null,
      language: "en" });
    const source = draft.authorities["2009scc32"].source;

    draft = reduceAuthoritiesDraft(draft, { type: "edit-authority",
      authorityId: "2009scc32", kind: "case", citation: "  2009 SCC 32  ",
      name: "  R v Grant  " });

    expect(draft.authorities["2009scc32"]).toMatchObject({ kind: "case",
      citation: "2009 SCC 32", name: "R v Grant", displayName: null, source });
  });

  it("keeps explicit English and French PDFs together and lets a bilingual PDF replace them", () => {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "add-authority", authority: authority("act") });
    const attach = (language: "en" | "fr" | "bilingual") => {
      const role = `authority:act:${language}`;
      draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "act",
        bindingRole: role, binding: { kind: "local-file", handleId: role,
          lastSeen: { name: `${language}.pdf`, size: 10, modified: 1,
            sha256: language[0].repeat(64) } }, filename: `${language}.pdf`,
        sourceSha256: language[0].repeat(64), sourceUrl: null, language });
    };
    attach("fr"); attach("en");
    expect(draft.authorities.act.source).toMatchObject({ kind: "attached",
      sources: [{ language: "en" }, { language: "fr" }] });
    expect(Object.keys(draft.bindings)).toEqual(["authority:act:fr", "authority:act:en"]);

    attach("bilingual");
    expect(draft.authorities.act.source).toMatchObject({ kind: "attached",
      sources: [{ language: "bilingual", bindingRole: "authority:act:bilingual" }] });
    expect(Object.keys(draft.bindings)).toEqual(["authority:act:bilingual"]);
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
  });

  it("carries highlight exclusions across a document refresh", () => {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { ...authority("grant"), locators: [
        { kind: "paragraph", label: "12" }] },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "set-highlight-exclusion",
      authorityId: "grant", locator: { kind: "paragraph", label: "12" }, excluded: true });
    draft = reduceAuthoritiesDraft(draft, { type: "refresh", review: {
      import: draft.import, bindings: draft.bindings, units: [], occurrences: {},
      authorities: { grant: authority("grant") }, authorityOrder: ["grant"],
    } });
    expect(draft.authorities.grant.highlightExclusions).toEqual([{ kind: "paragraph",
      label: "12" }]);
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
  });

  it("fills missing cover data without replacing manual Form 66 values", () => {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "set-cover", cover: { courtFileNumber: "T-9-26", partyGroups: [
        { role: "Applicant", parties: ["Edited Applicant"] },
        { role: "Respondent", parties: ["Edited Respondent"] },
      ], applicationUnder: "", title: "Applicant's Authorities" },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "refresh", review: {
      import: draft.import, bindings: draft.bindings, units: [], occurrences: {},
      authorities: {}, authorityOrder: [], cover: { courtFileNumber: "T-1-26",
        partyGroups: [{ role: "Applicant", parties: ["Source Applicant"] },
          { role: "Respondent", parties: ["Source Respondent"] }],
        applicationUnder: "Federal Courts Act, section 18.1", title: "" },
    } });
    expect(draft.cover).toEqual({ courtFileNumber: "T-9-26", partyGroups: [
      { role: "Applicant", parties: ["Edited Applicant"] },
      { role: "Respondent", parties: ["Edited Respondent"] },
    ], applicationUnder: "Federal Courts Act, section 18.1",
    title: "Applicant's Authorities" });
  });

  it("decodes canonical and rejects malformed nested durable state", () => {
    const canonical = createAuthoritiesDraft({ kind: "manual" });
    expect(decodeAuthoritiesDraft(canonical)).toEqual(canonical);
    const text = "2009 SCC 32";
    const current = { ...canonical,
      units: [{ id: "footnote:1", kind: "footnote" as const, ordinal: 0, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text, occurrenceIds: ["o"] }],
      occurrences: { o: occurrence("o", text, 0, text.length, null) } };
    expect(decodeAuthoritiesDraft(current)).toEqual(current);
    for (const field of ["authoritySpan", "coreSpan", "pinpointSpan"] as const) {
      const oldOccurrence = structuredClone(current) as unknown as {
        occurrences: Record<string, Partial<AuthorityOccurrence>> };
      delete oldOccurrence.occurrences.o[field];
      expect(decodeAuthoritiesDraft(oldOccurrence)).toBeNull();
    }
    const oldShape = structuredClone(canonical) as Partial<AuthoritiesDraft>;
    delete oldShape.settings; delete oldShape.bookParts;
    expect(decodeAuthoritiesDraft(oldShape)).toBeNull();
    const prior = structuredClone(canonical) as Partial<AuthoritiesDraft>;
    delete prior.discrepancyDecisions;
    expect(decodeAuthoritiesDraft(prior)).toBeNull();
    expect(decodeAuthoritiesDraft({ ...canonical,
      discrepancyDecisions: { invalid: "quote_exact" } })).toBeNull();

    const stored = structuredClone({ ...canonical,
      bindings: { pdf: { kind: "document" as const, documentId: "pdf", version: "latest" as const } },
      authorities: { a: { ...authority("a"), source: { kind: "attached" as const,
        bindingRole: "pdf", filename: "a.pdf", sourceSha256: "a".repeat(64),
        sourceUrl: null } } }, authorityOrder: ["a"],
    }) as unknown as Partial<AuthoritiesDraft> & {
      authorities: Record<string, Record<string, unknown>>;
    };
    delete stored.settings; delete stored.bookParts;
    expect(decodeAuthoritiesDraft(stored)).toBeNull();
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
    const source = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport, sourceBindings),
      { type: "set-output-mode", outputMode: "table" });
    const enabled = reduceAuthoritiesDraft(source,
      { type: "set-document-output", enabled: true });
    expect(enabled.insertIntoDocument).toBe(true);
    expect(reduceAuthoritiesDraft(enabled,
      { type: "set-output-mode", outputMode: "book" }).insertIntoDocument).toBe(false);
    const book = reduceAuthoritiesDraft(source,
      { type: "set-output-mode", outputMode: "book" });
    expect(() => reduceAuthoritiesDraft(book,
      { type: "set-document-output", enabled: true })).toThrowError(AuthoritiesDomainError);
    expect(decodeAuthoritiesDraft({ ...book, insertIntoDocument: true })).toBeNull();
    const pdf = reduceAuthoritiesDraft(createAuthoritiesDraft({ ...sourceImport,
      filename: "Factum.pdf", fileType: "pdf" }, sourceBindings),
    { type: "set-output-mode", outputMode: "table" });
    expect(reduceAuthoritiesDraft(pdf,
      { type: "set-document-output", enabled: true }).insertIntoDocument).toBe(true);
    expect(() => reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "set-document-output", enabled: true }))
      .toThrowError(AuthoritiesDomainError);
  });

  it("applies data-backed court presets and locked output rules", () => {
    const general = createAuthoritiesDraft({ kind: "manual" });
    expect(general).toMatchObject({ outputMode: "book", settings: {
      profileId: "general", sourceMode: "automatic", tableOrder: "alphabetical",
    } });
    expect(() => reduceAuthoritiesDraft(general,
      { type: "set-output-mode", outputMode: "table" })).toThrow(AuthoritiesDomainError);
    expect(() => reduceAuthoritiesDraft(general,
      { type: "set-profile", profileId: "ab-court-of-appeal" }))
      .toThrow(AuthoritiesDomainError);
    const appeal = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport, sourceBindings),
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
      "federal-court-appeal", "federal-court-of-appeal"] as const) {
      expect(reduceAuthoritiesDraft(general, { type: "set-profile", profileId }))
        .toMatchObject({ outputMode: "book", settings: {
          sourceMode: "automatic", scannedPdfPolicy: "full",
        } });
    }
    const kingsBench = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport, sourceBindings),
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
    expect(federal.settings).toMatchObject({ filingMedium: "electronic" });
    expect(federal.settings.bookRole).toBeUndefined();
    for (const bookRole of ["plaintiff", "defendant", "applicant", "respondent",
      "moving-party", "responding-party", "joint"] as const) {
      expect(reduceAuthoritiesDraft(federal,
        { type: "set-settings", settings: { bookRole } }).settings.bookRole).toBe(bookRole);
    }
    expect(reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { filingMedium: "paper", bookRole: "respondent" } }).settings)
      .toMatchObject({ filingMedium: "paper", bookRole: "respondent" });
    expect(reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { bookRole: "joint" } }).settings.bookRole).toBe("joint");
    expect(() => reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { passageMarking: "none" } })).toThrow(AuthoritiesDomainError);
    expect(reduceAuthoritiesDraft(federal, { type: "set-settings",
      settings: { passageMarking: "text" } }).settings.passageMarking).toBe("text");
    for (const profileId of ["federal-court-appeal", "federal-court-of-appeal"] as const) {
      const federalAppeal = reduceAuthoritiesDraft(general,
        { type: "set-profile", profileId });
      expect(federalAppeal.settings).toMatchObject({ filingMedium: "electronic", bookRole: "joint" });
      for (const bookRole of ["appellant", "respondent", "intervener"] as const) {
        expect(reduceAuthoritiesDraft(federalAppeal,
          { type: "set-settings", settings: { bookRole } }).settings.bookRole).toBe(bookRole);
      }
      expect(() => reduceAuthoritiesDraft(federalAppeal, { type: "set-settings",
        settings: { passageMarking: "none" } })).toThrow(AuthoritiesDomainError);
      expect(() => reduceAuthoritiesDraft(federalAppeal, { type: "set-settings",
        settings: { bookRole: "applicant" } })).toThrow(AuthoritiesDomainError);
    }
  });

  it("binds front matter and append-only supplemental PDFs", () => {
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
      draft = reduceAuthoritiesDraft(draft, { type: "set-book-supplement",
        supplement: { id, ...pdf(id, digest) }, binding: input(id, digest) });
    }
    expect(draft.bookParts).toMatchObject({ cover: { bindingRole: "book:cover" },
      index: { bindingRole: "book:index" }, supplements: [{ id: "one" }, { id: "two" }] });
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
    expect(decodeAuthoritiesDraft(draft)).toEqual(draft);

    expect(() => reduceAuthoritiesDraft(draft, { type: "set-book-part", slot: "index",
      pdf: pdf("cover", "1".repeat(64)), binding: input("cover", "1".repeat(64)) }))
      .toThrow("Binding is assigned more than once");

    draft = reduceAuthoritiesDraft(draft, { type: "clear-book-part", slot: "index" });
    draft = reduceAuthoritiesDraft(draft, { type: "remove-book-supplement", id: "one" });
    expect(Object.keys(draft.bindings).sort()).toEqual(["book:cover", "book:two"]);
  });

  it("keeps append order and clears an attached source without deleting its authority", () => {
    let draft = createAuthoritiesDraft({ kind: "manual" });
    draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: authority("first") });
    draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
      ...authority("second"), displayName: "Second case" } });
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "second",
      bindingRole: "authority:second", binding: { kind: "local-file", handleId: "second",
        lastSeen: { name: "second.pdf", size: 10, modified: 1,
          sha256: "a".repeat(64) } },
      filename: "second.pdf", sourceSha256: "a".repeat(64), sourceUrl: null,
      language: "en" });

    const cleared = reduceAuthoritiesDraft(draft,
      { type: "clear-authority-source", authorityId: "second" });
    expect(cleared.authorityOrder).toEqual(["first", "second"]);
    expect(cleared.authorities.second).toMatchObject({ displayName: "Second case",
      citation: "second", source: { kind: "unresolved" } });
    expect(cleared.bindings).not.toHaveProperty("authority:second");
  });

  it("clears machine-selected sources when source mode changes", () => {
    const digest = "a".repeat(64), binding = (id: string) => ({ kind: "local-file" as const,
      handleId: id, lastSeen: { name: `${id}.pdf`, size: 10, modified: 1, sha256: digest } });
    let draft = createAuthoritiesDraft({ kind: "manual" });
    for (const [id, origin] of [["original", "original"], ["rendered", "reconstructed"],
      ["manual", "manual"]] as const) {
      draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: authority(id) });
      draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: id,
        bindingRole: `authority:${id}`, binding: binding(id), filename: `${id}.pdf`,
        sourceSha256: digest, sourceUrl: null, origin, language: "en" });
    }
    draft = reduceAuthoritiesDraft(draft,
      { type: "add-authority", authority: authority("pending") });
    draft = reduceAuthoritiesDraft(draft, { type: "begin-canlii-handoff",
      authorityId: "pending",
      pageUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html" });
    draft.authorities.original.scanOnly = true;

    const changed = reduceAuthoritiesDraft(draft,
      { type: "set-settings", settings: { sourceMode: "render" } });
    expect(["original", "rendered", "pending"].map((id) => changed.authorities[id].source))
      .toEqual(Array(3).fill({ kind: "unresolved" }));
    expect(changed.authorities.manual.source).toMatchObject({ kind: "attached",
      sources: [{ origin: "manual" }] });
    expect(Object.keys(changed.bindings)).toEqual(["authority:manual"]);
    expect(decodeAuthoritiesDraft(changed)).toEqual(changed);
  });

  it("returns canonical and linked parallel citations in occurrence order", () => {
    const text = "[2009] 2 SCR 353; 2009 SCC 32; Grant, supra";
    const draft = createAuthoritiesDraft({ kind: "manual" });
    draft.authorities.grant = { ...authority("grant"), citation: "2009 SCC 32" };
    draft.authorityOrder = ["grant"];
    draft.units = [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [], text,
      occurrenceIds: ["reporter", "neutral", "supra"] }];
    draft.occurrences = {
      reporter: occurrence("reporter", text, 0, 16, "grant"),
      neutral: occurrence("neutral", text, 18, 29, "grant", 1),
      supra: { ...occurrence("supra", text, 31, text.length, "grant", 2),
        kind: "reference", reference: { kind: "supra", targetAuthorityId: "grant" } },
    };

    expect(authorityCitationForms(draft, "grant"))
      .toEqual(["2009 SCC 32", "[2009] 2 SCR 353"]);
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
      ...createAuthoritiesDraft(sourceImport, sourceBindings), stage: "build",
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
    expect(draft.stage).toBe("citations");
    expect(base.stage).toBe("build");
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
    expect(draft.authorityOrder).toEqual(["a", "b"]);
    expect(draft.outputMode).toBe("book");
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "b",
      bindingRole: "authority:b", binding: { kind: "local-file", handleId: "handle-b",
        lastSeen: { name: "grant.pdf", size: 20, modified: 1,
          sha256: "e".repeat(64) } },
      filename: "grant.pdf", sourceSha256: "e".repeat(64), sourceUrl: null,
      language: "en" });
    expect(draft.authorities.b.source).toMatchObject({
      kind: "attached", sources: [{ bindingRole: "authority:b", filename: "grant.pdf" }],
    });
    expect(draft.bindings).toHaveProperty("authority:b");
    draft = reduceAuthoritiesDraft(draft,
      { type: "clear-authority-source", authorityId: "b" });
    expect(draft.authorities.b).toMatchObject({ displayName: "Better name",
      citation: "2024 SCC 1", name: "Example v Test", source: { kind: "resolved" } });
    expect(draft.bindings).not.toHaveProperty("authority:b");

    const merged = occurrence("merged", text, 0, text.length, "b");
    draft = reduceAuthoritiesDraft(draft, {
      type: "merge-occurrences", occurrenceIds: ["left", "right"], replacement: merged,
    });
    expect(draft.units[0].occurrenceIds).toEqual(["merged"]);
  });

  it("adds a missed citation into its unit in reading order, over free text only", () => {
    const text = "Case A; Case B; Case C";
    const unitId = "body:2";
    const item = (id: string, start: number, end: number, localOrdinal: number) =>
      ({ ...occurrence(id, text, start, end, "a", localOrdinal), unitId });
    const base: AuthoritiesDraft = {
      ...createAuthoritiesDraft(sourceImport, sourceBindings),
      units: [{ id: unitId, kind: "body", ordinal: 2, footnoteId: null, footnoteRefs: [],
        pageNumbers: [], text, occurrenceIds: ["third"] }],
      occurrences: { third: item("third", 16, 22, 2) },
      authorities: { a: authority("a") }, authorityOrder: ["a"],
    };
    const first = item("first", 0, 6, 0);
    const draft = reduceAuthoritiesDraft(base, { type: "add-occurrence", occurrence: first });
    expect(draft.units[0].occurrenceIds).toEqual(["first", "third"]);
    expect(base.units[0].occurrenceIds).toEqual(["third"]);
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
    expect(reduceAuthoritiesDraft(draft,
      { type: "add-occurrence", occurrence: item("second", 8, 14, 1) })
      .units[0].occurrenceIds).toEqual(["first", "second", "third"]);
    expect(() => reduceAuthoritiesDraft(draft, { type: "add-occurrence",
      occurrence: { ...first, id: "overlap", start: 4, end: 10 } }))
      .toThrow(AuthoritiesDomainError);
    expect(() => reduceAuthoritiesDraft(draft, { type: "add-occurrence", occurrence: first }))
      .toThrow(/already on the review list/u);
    expect(() => reduceAuthoritiesDraft(draft, { type: "add-occurrence",
      occurrence: { ...first, id: "elsewhere", unitId: "body:9" } })).toThrow(/Unknown unit/u);
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
      authorities: { "old-a": { ...authority("old-a", "same-key"), name: "R. v. Grant", displayName: "Grant",
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
      authorities: { "new-a": { ...authority("new-a", "same-key"), name: null } },
      authorityOrder: ["new-a"],
    } });

    expect(refreshed.authorities["new-a"]).toMatchObject({
      name: "R. v. Grant", displayName: "Grant", excluded: true, evidenceIds: ["receipt-old"],
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

  it("retains an explicit user-added authority when an imported source is rescanned", () => {
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport, sourceBindings), {
      type: "add-authority", authority: { ...authority("added", "added-key"), userAdded: true },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "added",
      bindingRole: "authority:added", binding: { kind: "local-file", handleId: "added-pdf" },
      filename: "Added.pdf", sourceSha256: "a".repeat(64), sourceUrl: null,
      language: "en" });
    const refreshed = reduceAuthoritiesDraft(draft, { type: "refresh", review: {
      import: sourceImport, bindings: sourceBindings, units: [], occurrences: {},
      authorities: {}, authorityOrder: [],
    } });

    expect(refreshed.authorityOrder).toEqual(["added"]);
    expect(refreshed.authorities.added).toMatchObject({ userAdded: true,
      source: { kind: "attached", sources: [{ bindingRole: "authority:added" }] } });
    expect(refreshed.bindings).toHaveProperty("authority:added");
    expect(reduceAuthoritiesDraft(refreshed, { type: "edit-authority", authorityId: "added",
      kind: "case", citation: "2024 ABKB 13", name: "Jones v Smith" })
      .authorities.added.citation).toBe("2024 ABKB 13");

    const scanned = reduceAuthoritiesDraft(createAuthoritiesDraft(sourceImport, sourceBindings), {
      type: "add-authority", authority: { ...authority("scan"), scanOnly: true },
    });
    expect(() => reduceAuthoritiesDraft(scanned, { type: "edit-authority", authorityId: "scan",
      kind: "case", citation: "2024 ABKB 13", name: "Jones v Smith" }))
      .toThrow("Only a manual authority can be edited directly.");
  });

  it("keeps a reviewed false positive removed when the source is rescanned", () => {
    const text = "This is not 2024 ABKB 1.";
    let draft: AuthoritiesDraft = {
      ...createAuthoritiesDraft({ kind: "manual" }),
      units: [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [[1, 0]], pageNumbers: [], text, occurrenceIds: ["false-positive"] }],
      occurrences: {
        "false-positive": occurrence("false-positive", text, 12, text.length - 1, "case"),
      },
      authorities: { case: { ...authority("case"), scanOnly: true } },
      authorityOrder: ["case"],
    };
    draft = reduceAuthoritiesDraft(draft,
      { type: "remove-occurrence", occurrenceId: "false-positive" });

    const refreshed = reduceAuthoritiesDraft(draft, { type: "refresh", review: {
      import: { kind: "manual" }, bindings: {},
      units: [{ ...draft.units[0], occurrenceIds: ["detected-again"] }],
      occurrences: {
        "detected-again": occurrence("detected-again", text, 12, text.length - 1, "case"),
      },
      authorities: { case: { ...authority("case"), scanOnly: true } }, authorityOrder: ["case"],
    } });

    expect(refreshed.units[0].occurrenceIds).toEqual([]);
    expect(refreshed.occurrences).not.toHaveProperty("detected-again");
    expect(refreshed.authorityOrder).toEqual([]);
    expect(refreshed.authorities).toEqual({});
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
        sourceIdentity, source: { kind: "attached", sources: [{ bindingRole: "authority:grant",
          filename: "grant.pdf", sourceSha256: "b".repeat(64), sourceUrl: null,
          origin: "manual", language: "en" }] } } },
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
      source: { kind: "attached", sources: [{ bindingRole: "authority:grant" }] },
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
          name: null, excluded: true, evidenceIds: ["reporter-evidence"],
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
        filename: `${role}.pdf`, sourceSha256: digest, sourceUrl: null, language: "en" });
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
      displayName: "Carter (Charter)", excluded: false,
      evidenceIds: ["french-evidence", "neutral-evidence", "reporter-evidence"],
      locators: [{ kind: "paragraph", label: "1" }, { kind: "paragraph", label: "2" }],
      sourceIdentity: source, source: { kind: "attached",
        sources: [{ bindingRole: "authority:neutral" }] },
    });
    expect(Object.keys(draft.bindings)).toEqual(["authority:neutral"]);
    expect(Object.values(draft.occurrences).map(({ authorityId }) => authorityId))
      .toEqual(["reporter", "reporter", "reporter"]);
    expect(draft.occurrences["french-supra"].reference)
      .toEqual({ kind: "supra", targetAuthorityId: "reporter" });
    expect(validateAuthoritiesDraft(draft)).toEqual([]);
  });
});
