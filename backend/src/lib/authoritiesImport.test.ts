import { describe, expect, it, vi } from "vitest";
import { createAuthoritiesImporter, importStandaloneAuthoritiesFile } from "./authoritiesImport";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { Document, Packer, Paragraph } from "docx";

const scope = { userId: "user-1" };

const receipt = (evidenceId: string, label: string): LegalEvidenceReceipt => ({
  evidence_id: evidenceId, provider: "a2aj", jurisdiction: "ca", source_class: "case",
  stable_source_id: "2016-scc-27", source_sha256: "c".repeat(64), scope: "passage",
  block_id: label, span_sha256: `${evidenceId}-sha`, span_text: "Evidence",
  citation: "2016 SCC 27", name: "R v Jordan", dataset: "SCC", language: "en",
  version: "2024-01-01", external_url: "https://example.test/jordan",
  locator: { kind: "paragraph", label }, resolver_version: "a2aj-inline-v1",
});

describe("authorities import application", () => {
  it("runs standalone DOCX bytes through the installed Rust runtime", async () => {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph("Example v Example, 2024 ABKB 123 at para 7."),
    ] }] }));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 1 });
    expect(state.authorityOrder).toHaveLength(1);
    expect(state.authorities[state.authorityOrder[0]].citation).toBe("2024 ABKB 123");
    expect(state.authorities[state.authorityOrder[0]].source).toMatchObject({
      kind: "pending-canlii",
      pdfUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf",
    });
  });

  it("imports standalone bytes through the same Rust occurrence scan", async () => {
    const bytes = Buffer.from("exact docx bytes"), citation = "2024 ABCA 1";
    const native = { docxAuthorityTextUnits: vi.fn(async () => [{ key: "body:0",
      kind: "body" as const, ordinal: 0, footnote_id: null, page_numbers: [1],
      text: citation, footnote_refs: [] }]), pdfAuthorityTextUnits: vi.fn(),
      citationLookupKey: vi.fn(() => "2024-abca-1"), citationLookupKeys: vi.fn(),
      citationOccurrencesInText: vi.fn(() => [{
        text: citation, start: 0, end: citation.length,
        styledCitation: { text: citation, start: 0, end: citation.length },
        coreCitation: { text: citation, start: 0, end: citation.length },
        pinpoints: [], kind: "case" as const, shortForm: null, reasons: ["neutral"],
      }]) };
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 42 }, { read: vi.fn() as never }, native);
    expect(state).toMatchObject({ import: { filename: "Brief.docx", snapshot: null },
      bindings: { source: { kind: "local-file", lastSeen: { modified: 42 } } },
      authorityOrder: ["2024-abca-1"], authorities: { "2024-abca-1": {
        source: { kind: "pending-canlii",
          pdfUrl: "https://www.canlii.org/en/ab/abca/doc/2024/2024abca1/2024abca1.pdf" },
      } } });
    expect(native.docxAuthorityTextUnits).toHaveBeenCalledWith(bytes);
    expect(native.citationOccurrencesInText).toHaveBeenCalledWith(citation);
  });

  it("creates a version-bound draft with ordered UTF-16 citation locations", async () => {
    const bytes = Buffer.from("exact docx bytes");
    const sourceSha256 = sha256(bytes);
    const body = "🦫 See R. v. Jordan, 2016 SCC 27 at para 7.";
    const text = "R. v. Jordan, 2016 SCC 27 at para 7";
    const start = body.indexOf(text), end = start + text.length;
    const core = "2016 SCC 27", coreStart = body.indexOf(core);
    const docxAuthorityTextUnits = vi.fn(async () => [
      { key: "body:0", kind: "body" as const, ordinal: 0, footnote_id: null,
        page_numbers: [], text: body, footnote_refs: [[1, 3]] },
      { key: "footnote:1", kind: "footnote" as const, ordinal: 1, footnote_id: 1,
        page_numbers: [], text: "No citation", footnote_refs: [] },
    ]);
    const native = {
      docxAuthorityTextUnits,
      pdfAuthorityTextUnits: vi.fn(() => { throw new Error("PDF parser must not run"); }),
      citationLookupKey: vi.fn(() => "2016-scc-27"),
      citationLookupKeys: vi.fn(),
      citationOccurrencesInText: vi.fn((unit: string) => unit === body ? [{
        text, start, end,
        styledCitation: { text: "R. v. Jordan, 2016 SCC 27", start,
          end: coreStart + core.length },
        coreCitation: { text: core, start: coreStart, end: coreStart + core.length },
        pinpoints: [{ text: "7", start: end - 1, end, kind: "paragraph" as const }],
        kind: "case" as const, shortForm: "R. v. Jordan",
        reasons: ["neutral", "same_text_style", "pinpoint_grammar"],
      }] : []),
    };
    const documents = {
      projectionSource: vi.fn(async () => ({ documentId: "brief", versionId: "v1",
        fileType: "docx", sourceSha256, readBytes: async () => bytes })),
      versions: vi.fn(async () => ({ current_version_id: "v1", versions: [{ id: "v1",
        filename: "Brief.docx", source_sha256: sourceSha256 }] })),
    } as unknown as DocumentStore;
    const read = vi.fn(() => { throw new Error("DOCX projection must not run"); });
    const importer = createAuthoritiesImporter(
      documents, { read: read as never }, native as never);
    const binding = { kind: "document" as const, documentId: "brief",
      version: "latest" as const };

    const state = await importer.draft(scope, binding);

    expect(state.import).toEqual({ kind: "document", bindingRole: "source",
      filename: "Brief.docx", fileType: "docx",
      snapshot: { documentId: "brief", versionId: "v1", sha256: sourceSha256 } });
    expect(state.bindings).toEqual({ source: binding });
    expect(state.units.map(({ id }) => id)).toEqual(["body:0", "footnote:1"]);
    expect(state.units[0].footnoteRefs).toEqual([[1, 3]]);
    expect(state.units[0].pageNumbers).toEqual([]);
    expect(state.occurrences["body:0:0"]).toMatchObject({
      unitId: "body:0", start, end, text,
      sourceTextSha256: sha256(body), localOrdinal: 0,
      pinpoints: [{ kind: "paragraph", text: "7" }],
    });
    expect(body.slice(start, end)).toBe(text);
    expect(state.authorities["2016-scc-27"]).toMatchObject({
      citation: core, name: "R. v. Jordan", source: { kind: "unresolved" },
    });
    expect(docxAuthorityTextUnits).toHaveBeenCalledWith(bytes);
    expect(documents.projectionSource).toHaveBeenCalledWith(scope, "brief", null);
    expect(read).not.toHaveBeenCalled();
  });

  it("imports exact grounded receipt seeds without reparsing", async () => {
    const key = "2016-scc-27";
    const citationOccurrencesInText = vi.fn(() => {
      throw new Error("receipt-backed authorities must not be reparsed");
    });
    const native = {
      citationOccurrencesInText,
      citationLookupKey: vi.fn(() => { throw new Error("known key must not be rebuilt"); }),
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("document parser must not run"); }),
      pdfAuthorityTextUnits: vi.fn(() => { throw new Error("document parser must not run"); }),
    };
    const importer = createAuthoritiesImporter({} as DocumentStore,
      { read: vi.fn() as never }, native as never);

    const state = await importer.draft(scope, { kind: "receipts", seeds: [{
      authorityKey: key, receipts: [receipt("e1", "12"), receipt("e2", "14")],
    }] });

    expect(state.authorities[key]).toMatchObject({ name: "R v Jordan",
      source: { kind: "resolved" }, sourceIdentity: {
        stableSourceId: "2016-scc-27", sourceSha256: "c".repeat(64),
        version: "2024-01-01" } });
    expect(citationOccurrencesInText).not.toHaveBeenCalled();
    expect(native.citationLookupKey).not.toHaveBeenCalled();
  });

  it("uses a matching assistant citation ledger without reading or reparsing the DOCX", async () => {
    const sourceSha256 = "a".repeat(64), unitText = "R v Jordan, 2016 SCC 27";
    const readBytes = vi.fn(() => { throw new Error("ledger-backed DOCX must not be read"); });
    const ledger = {
      schemaVersion: "beaver.authority-ledger.v1" as const,
      seeds: [{
        key: "2016-scc-27", kind: "case" as const, provider: "a2aj",
        stableSourceId: "2016-scc-27", sourceSha256: "c".repeat(64),
        citation: "2016 SCC 27", name: "R v Jordan", version: "2024-01-01",
        externalUrl: "https://example.test/jordan", evidenceIds: ["e_receipt0001"],
        locators: [{ kind: "paragraph", label: "12" }],
      }],
      occurrences: [{
        id: "body:0:ledger:0", markerId: "jordan", targetId: "2016-scc-27",
        authorityKey: "2016-scc-27", unit: { id: "body:0", kind: "body" as const,
          ordinal: 0, footnoteId: null, footnoteRefs: [], pageNumbers: [],
          text: unitText, sourceTextSha256: sha256(unitText) },
        start: 0, end: unitText.length, text: unitText, displayedForm: "full" as const,
        pinpoints: [{ kind: "paragraph" as const, text: "12" }],
        evidenceIds: ["e_receipt0001"], localOrdinal: 0,
      }],
    };
    const documents = {
      projectionSource: vi.fn(async () => ({ documentId: "brief", versionId: "v1",
        fileType: "docx", sourceSha256, readBytes,
        provenance: { actor: "assistant" as const, generation: { authorityLedger: ledger } } })),
      versions: vi.fn(async () => ({ current_version_id: "v1", versions: [{ id: "v1",
        filename: "Brief.docx", source_sha256: sourceSha256 }] })),
    } as unknown as DocumentStore;
    const native = {
      citationOccurrencesInText: vi.fn(() => { throw new Error("ledger must not be scanned"); }),
      citationLookupKey: vi.fn(() => { throw new Error("ledger key must not be rebuilt"); }),
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("DOCX parser must not run"); }),
      pdfAuthorityTextUnits: vi.fn(() => { throw new Error("PDF parser must not run"); }),
    };
    const read = vi.fn(() => { throw new Error("projection must not run"); });

    const state = await createAuthoritiesImporter(documents, { read: read as never },
      native as never).draft(scope, { kind: "document", documentId: "brief",
        version: "latest" });

    expect(state.authorityOrder).toEqual(["2016-scc-27"]);
    expect(state.occurrences["body:0:ledger:0"]).toMatchObject({
      text: unitText, authorityId: "2016-scc-27", reviewed: true,
      evidenceIds: ["e_receipt0001"],
    });
    expect(state.ledger?.document).toEqual({ documentId: "brief", versionId: "v1",
      sha256: sourceSha256 });
    expect(readBytes).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(native.docxAuthorityTextUnits).not.toHaveBeenCalled();
    expect(native.citationOccurrencesInText).not.toHaveBeenCalled();
  });

  it("carries exact PDF body pages from the shared projection into static cited-at data", async () => {
    const bytes = Buffer.from("%PDF-1.7\n%%EOF"), sourceSha256 = sha256(bytes);
    const projection = { documentId: "brief", versionId: "v1" };
    const readBytes = vi.fn(() => { throw new Error("PDF bytes must use the projection"); });
    const documents = {
      projectionSource: vi.fn(async () => ({ documentId: "brief", versionId: "v1",
        fileType: "pdf", sourceSha256, readBytes })),
      versions: vi.fn(async () => ({ current_version_id: "v1", versions: [{ id: "v1",
        filename: "Brief.pdf", source_sha256: sourceSha256 }] })),
    } as unknown as DocumentStore;
    const pdfAuthorityTextUnits = vi.fn(() => [{ key: "body:0", kind: "body" as const,
      ordinal: 0, footnote_id: null, page_numbers: [2, 4], text: "2024 FCA 1",
      footnote_refs: [] }]);
    const native = {
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("DOCX parser must not run"); }),
      pdfAuthorityTextUnits,
      citationOccurrencesInText: vi.fn(() => []), citationLookupKey: vi.fn(),
    };
    const read = vi.fn(async () => projection);
    const importer = createAuthoritiesImporter(documents, { read: read as never }, native as never);

    const state = await importer.draft(scope, { kind: "document", documentId: "brief",
      version: "latest" });

    expect(state.units[0].pageNumbers).toEqual([2, 4]);
    expect(read).toHaveBeenCalledOnce();
    expect(pdfAuthorityTextUnits).toHaveBeenCalledWith(projection);
    expect(readBytes).not.toHaveBeenCalled();
  });
});
