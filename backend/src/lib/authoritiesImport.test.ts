import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthoritiesImporter, importStandaloneAuthoritiesFile } from "./authoritiesImport";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative } from "./structureNative";
import { Document, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scope = { userId: "user-1" };
let aliasDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_CITATOR_DB;
  if (aliasDirectory) await rm(aliasDirectory, { recursive: true, force: true });
  aliasDirectory = null;
});

async function useAliasGraph(rows: Array<[citation: string, decision: string]>) {
  aliasDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-authorities-alias-"));
  const databasePath = path.join(aliasDirectory, "citator.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE resolution (cited_key TEXT, path TEXT, file_row_number INTEGER)");
  const insert = database.prepare("INSERT INTO resolution VALUES (?, ?, 1)");
  const native = structureNative();
  rows.forEach(([citation, decision]) => insert.run(native.citationLookupKey(citation), decision));
  database.close();
  process.env.MIKE_CITATOR_DB = databasePath;
}

const scanNative = (texts: string[]) => {
  const native = structureNative();
  return {
    docxAuthorityTextUnits: vi.fn(async () => texts.map((text, index) => ({
      key: `footnote:${index + 1}`, kind: "footnote" as const, ordinal: index + 1,
      footnote_id: index + 1, page_numbers: [], text, footnote_refs: [],
    }))),
    pdfAuthorityTextUnits: vi.fn(),
    citationOccurrencesInText: (text: string) => native.citationOccurrencesInText(text),
    authorityReferencesInText: (text: string) => native.authorityReferencesInText(text),
    citationLookupKey: (text: string) => native.citationLookupKey(text),
  };
};

const receipt = (evidenceId: string, label: string): LegalEvidenceReceipt => ({
  evidence_id: evidenceId, provider: "a2aj", jurisdiction: "ca", source_class: "case",
  stable_source_id: "2016-scc-27", source_sha256: "c".repeat(64), scope: "passage",
  block_id: label, span_sha256: `${evidenceId}-sha`, span_text: "Evidence",
  citation: "2016 SCC 27", name: "R v Jordan", dataset: "SCC", language: "en",
  version: "2024-01-01", external_url: "https://example.test/jordan",
  locator: { kind: "paragraph", label }, resolver_version: "a2aj-inline-v1",
});

describe("authorities import application", () => {
  it("propagates Form 66 fields from an imported filing", async () => {
    const lines = ["Court File No. T-982-19", "FEDERAL COURT", "BETWEEN:",
      "North Prairie Ltd.", "Applicant", "and", "Attorney General of Canada", "Respondent",
      "APPLICATION UNDER Federal Courts Act, section 18.1"];
    const native = { docxAuthorityTextUnits: vi.fn(async () => lines.map((text, ordinal) => ({
      key: `body:${ordinal}`, kind: "body" as const, ordinal, footnote_id: null,
      page_numbers: [], text, footnote_refs: [],
    }))), pdfAuthorityTextUnits: vi.fn(), citationOccurrencesInText: vi.fn(() => []),
    authorityReferencesInText: vi.fn(() => []), citationLookupKey: vi.fn(() => "") };

    const state = await importStandaloneAuthoritiesFile({ filename: "Memorandum.docx",
      fileType: "docx", bytes: Buffer.from("filing"), modified: 1 },
    { read: vi.fn() as never }, native);

    expect(state.cover).toEqual({ courtFileNumber: "T-982-19", partyGroups: [
      { role: "Applicant", parties: ["North Prairie Ltd."] },
      { role: "Respondent", parties: ["Attorney General of Canada"] },
    ], applicationUnder: "Federal Courts Act, section 18.1", title: "" });
  });

  it("coalesces reciprocal neutral, reporter, and French case citations before supra", async () => {
    const citations = ["2015 SCC 5", "[2015] 1 SCR 331", "2015 CSC 5"];
    await useAliasGraph(citations.map((citation) => [citation, "carter"]));
    const texts = [
      `Carter v Canada, ${citations[0]}.`,
      `Carter v Canada, ${citations[1]}.`,
      `Carter c Canada, ${citations[2]}.`,
      "Carter v Canada, supra note 1 at para 8.",
    ];

    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative(texts));

    expect(state.authorityOrder).toHaveLength(1);
    const authorityId = state.authorityOrder[0];
    expect(state.authorities[authorityId]).toMatchObject({
      id: structureNative().citationLookupKey(citations[0]), kind: "case",
      citation: citations[0],
    });
    expect(Object.values(state.occurrences).filter(({ kind }) => kind !== "reference")
      .map(({ citation, authorityId: id, kind }) => ({ citation, id, kind }))).toEqual(
      citations.map((citation) => ({ citation, id: authorityId, kind: "case" })),
    );
    expect(Object.values(state.occurrences).find(({ kind }) => kind === "reference"))
      .toMatchObject({ citation: "supra note 1", authorityId, reviewed: true,
        reference: { kind: "supra", targetAuthorityId: authorityId } });
  });

  it("does not merge asymmetric or ambiguous alias closures", async () => {
    const neutral = "2020 SCC 1", reporter = "[2020] 1 SCR 1";
    await useAliasGraph([[neutral, "decision-a"], [reporter, "decision-a"],
      [reporter, "decision-b"]]);
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative([neutral, reporter]));

    expect(state.authorityOrder).toEqual([neutral, reporter]
      .map((citation) => structureNative().citationLookupKey(citation)));
  });

  it("leaves singleton cases and non-case alias groups alone", async () => {
    const reporters = ["[2020] 1 SCR 1", "[2020] 2 SCR 2"], singleton = "2024 ABCA 1";
    await useAliasGraph([[reporters[0], "reporters"], [reporters[1], "reporters"],
      [singleton, "singleton"], ["[2024] 1 Alta LR 1", "singleton"]]);
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes: Buffer.from("brief"), modified: 1 },
    { read: vi.fn() as never }, scanNative([...reporters, singleton]));

    expect(state.authorityOrder).toEqual([...reporters, singleton]
      .map((citation) => structureNative().citationLookupKey(citation)));
    expect(state.authorityOrder.map((id) => state.authorities[id].kind))
      .toEqual(["other", "other", "case"]);
  });

  it("keeps standalone manual-source imports unresolved until source preparation", async () => {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph("Example v Example, 2024 ABKB 123 at para 7 [Example]."),
      new Paragraph("Ibid at para 9."),
      new Paragraph("Example, supra at para 11."),
    ] }] }));
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.docx",
      fileType: "docx", bytes, modified: 1, sourceMode: "manual-originals" });
    expect(state.authorityOrder).toHaveLength(1);
    expect(state.authorities[state.authorityOrder[0]].citation).toBe("2024 ABKB 123");
    expect(state.authorities[state.authorityOrder[0]].source).toEqual({ kind: "unresolved" });
    expect(Object.values(state.occurrences).filter(({ kind }) => kind === "reference"))
      .toMatchObject([
        { citation: "Ibid", text: "Ibid at para 9", authoritySpan: { text: "Ibid" },
          pinpointSpan: { text: "9" }, sourceTextSha256: sha256("Ibid at para 9."),
          localOrdinal: 0, authorityId: state.authorityOrder[0], reviewed: true,
          reference: { kind: "ibid", targetAuthorityId: state.authorityOrder[0] } },
        { citation: "supra", text: "supra at para 11", authoritySpan: { text: "supra" },
          pinpointSpan: { text: "11" }, authorityId: state.authorityOrder[0], reviewed: true,
          reference: { kind: "supra", targetAuthorityId: state.authorityOrder[0] } },
      ]);
  });

  it("finds ordinary references through a real PDF projection", async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("R v Grant, 2009 SCC 32", { x: 50, y: 700, font, size: 12 });
    page.drawText("Ibid at para 7.", { x: 50, y: 680, font, size: 12 });
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf",
      fileType: "pdf", bytes: Buffer.from(await pdf.save()), modified: 1 });
    const reference = Object.values(state.occurrences).find(({ kind }) => kind === "reference");
    expect(state.authorityOrder).toHaveLength(1);
    expect(reference).toMatchObject({ citation: "Ibid", authorityId: state.authorityOrder[0],
      reference: { kind: "ibid", targetAuthorityId: state.authorityOrder[0] } });
  });

  it("links supra notes only when their native reference target is unambiguous", async () => {
    const runtime = structureNative();
    const text = [
      "R v Smith, 2020 SCC 1; R v Smith, 2020 SCC 2.",
      "Gamma v Delta, 2021 SCC 3.",
      "R v Smith, supra note 1 at para 4.",
      "Gamma v Delta, supra note 2 at para 5.",
    ];
    const units = text.map((value, index) => ({ key: `footnote:${index + 1}`,
      kind: "footnote" as const, ordinal: index + 1, footnote_id: index + 1,
      page_numbers: [], text: value, footnote_refs: [] }));
    const native = {
      docxAuthorityTextUnits: vi.fn(), pdfAuthorityTextUnits: vi.fn(() => units),
      citationOccurrencesInText: (value: string) => runtime.citationOccurrencesInText(value),
      authorityReferencesInText: (value: string) => runtime.authorityReferencesInText(value),
      citationLookupKey: (value: string) => runtime.citationLookupKey(value),
    };
    const state = await importStandaloneAuthoritiesFile({ filename: "Brief.pdf",
      fileType: "pdf", bytes: Buffer.from("%PDF-1.7\n%%EOF"), modified: 1 },
    { read: vi.fn(async () => ({})) as never }, native);
    const references = Object.values(state.occurrences)
      .filter(({ kind }) => kind === "reference");

    expect(references[0]).toMatchObject({ citation: "supra note 1", authorityId: null,
      reference: null, reviewed: false, pinpointSpan: { text: "4" } });
    expect(state.units[2].occurrenceIds).toContain(references[0].id);
    expect(references[1]).toMatchObject({ citation: "supra note 2", reviewed: true,
      reference: { kind: "supra", targetAuthorityId: references[1].authorityId } });
  });

  it("imports standalone bytes through the same Rust occurrence scan", async () => {
    const bytes = Buffer.from("exact docx bytes"), citation = "2024 ABCA 1";
    const native = { docxAuthorityTextUnits: vi.fn(async () => [{ key: "body:0",
      kind: "body" as const, ordinal: 0, footnote_id: null, page_numbers: [1],
      text: citation, footnote_refs: [] }]), pdfAuthorityTextUnits: vi.fn(),
      citationLookupKey: vi.fn(() => "2024-abca-1"), citationLookupKeys: vi.fn(),
      authorityReferencesInText: vi.fn(() => []),
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
        source: { kind: "unresolved" },
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
      authorityReferencesInText: vi.fn(() => []),
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
      version: { versionId: "v1", sha256: sourceSha256 } };

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
      authoritySpan: { start, end: coreStart + core.length,
        text: body.slice(start, coreStart + core.length) },
      coreSpan: { start: coreStart, end: coreStart + core.length, text: core },
      pinpointSpan: { start: end - 1, end, text: "7" },
      sourceTextSha256: sha256(body), localOrdinal: 0,
      pinpoints: [{ kind: "paragraph", text: "7" }],
    });
    expect(body.slice(start, end)).toBe(text);
    expect(state.authorities["2016-scc-27"]).toMatchObject({
      citation: core, name: "R. v. Jordan", source: { kind: "unresolved" },
    });
    expect(docxAuthorityTextUnits).toHaveBeenCalledWith(bytes);
    expect(documents.projectionSource).toHaveBeenCalledWith(scope, "brief", "v1");
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
      metadata: vi.fn(async () => ({ current_version_id: "v1", filename: "Brief.docx" })),
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
      metadata: vi.fn(async () => ({ current_version_id: "v1", filename: "Brief.pdf" })),
    } as unknown as DocumentStore;
    const pdfAuthorityTextUnits = vi.fn(() => [{ key: "body:0", kind: "body" as const,
      ordinal: 0, footnote_id: null, page_numbers: [2, 4], text: "2024 FCA 1",
      footnote_refs: [] }]);
    const native = {
      docxAuthorityTextUnits: vi.fn(() => { throw new Error("DOCX parser must not run"); }),
      pdfAuthorityTextUnits,
      citationOccurrencesInText: vi.fn(() => []),
      authorityReferencesInText: vi.fn(() => []), citationLookupKey: vi.fn(),
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
