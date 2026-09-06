import { beforeEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());
const lookupProviderPdfReference = vi.hoisted(() => vi.fn());
const rehydrateProviderPdfReference = vi.hoisted(() => vi.fn());
const hasNativeOpinionStructure = vi.hoisted(() => vi.fn());
vi.mock("../providerPdfLibraryBridge", () => ({
  lookupProviderPdfReference,
  queueProviderPdfAttachment,
  rehydrateProviderPdfReference,
}));

vi.mock("../legalSources/courtlistener", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../legalSources/courtlistener")
  >();
  return {
    ...original,
    courtlistenerLegalSourceProvider: {
      ...original.courtlistenerLegalSourceProvider,
      hasNativeOpinionStructure,
    },
  };
});
vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

import { runLocalAssistantTools } from "./support/localAssistantTools";
import { legalSourceOperations } from "../legalSourceApplication";
import { courtlistenerLegalSourceProvider } from "../legalSources/courtlistener";
import type { LegalSourcePassage, LegalSourceReference } from "../legalSources";
import { resourceReference } from "../resourceReferences";

const fallback = {
  provider: "courtlistener",
  identity: "42",
  reference_id: "reference-1",
  download_status: "queued",
  parse_status: null,
};

beforeEach(() => {
  queueProviderPdfAttachment.mockReset();
  queueProviderPdfAttachment.mockResolvedValue(fallback);
  hasNativeOpinionStructure.mockReset();
  hasNativeOpinionStructure.mockReturnValue(false);
  lookupProviderPdfReference.mockReset();
  rehydrateProviderPdfReference.mockReset();
});

describe("provider PDF consumers", () => {
  it("keeps source passages when one shared optional PDF fails", async () => {
    const source = { provider: "courtlistener", id: "42", kind: "case" as const };
    const native = { case: { clusterId: 42, opinions: [{ id: 8 }],
      pdfUrl: "https://storage.courtlistener.com/pdf/42.pdf" } };
    const passages = ["First passage", "Second passage"].map((text) => ({
      source, native, text, role: "selected", locator: { label: "1" },
    } as LegalSourcePassage));
    const reader = vi.spyOn(courtlistenerLegalSourceProvider, "readPassage")
      .mockResolvedValue(passages);
    try {
      const ready = await legalSourceOperations.readWithRenditions({ source }, "local-user");
      expect(ready).toMatchObject({ status: "found", values: passages,
        pdfRenditions: [{ ...fallback, resource: resourceReference.source("pdf", "reference-1") }] });
      expect(queueProviderPdfAttachment.mock.calls[0][0].source).toEqual(source);
      hasNativeOpinionStructure.mockReturnValue(true);
      expect(await legalSourceOperations.readWithRenditions({ source }, "local-user"))
        .toEqual({ status: "found", values: passages, pdfRenditions: [] });
      native.case.opinions.push({ id: 10 });
      hasNativeOpinionStructure.mockImplementation((opinion) => opinion.id === 8);
      expect(await legalSourceOperations.readWithRenditions({ source }, "local-user"))
        .toEqual(ready);
      queueProviderPdfAttachment.mockRejectedValue(new Error("PDF unavailable"));
      const failed = await legalSourceOperations.readWithRenditions({ source }, "local-user");
      expect(failed).toEqual({ status: "found", values: passages, pdfRenditions: [] });
    } finally { reader.mockRestore(); }
  });

  it.each<{ source: LegalSourceReference; jurisdiction: string }>([
    { source: { provider: "courtlistener", id: "42", part: "8", kind: "case",
      citation: "410 U.S. 113", title: "CourtListener decision", collection: "scotus" }, jurisdiction: "US" },
    { source: { provider: "a2aj", id: "2026 SCC 1", kind: "case", citation: "2026 SCC 1",
      title: "Canadian decision", collection: "SCC", language: "en" }, jurisdiction: "CA" },
    { source: { provider: "a2aj", id: "LRC 1985, c C-46", kind: "legislation",
      citation: "LRC 1985, c C-46", title: "Code criminel", collection: "STATUTES-FED", language: "fr" }, jurisdiction: "CA" },
    { source: { provider: "govinfo", id: "USCOURTS-example", kind: "case",
      citation: "1:22-cv-00930", title: "Federal decision", collection: "USCOURTS" }, jurisdiction: "US" },
    { source: { provider: "govinfo", id: "CFR-2025-title1", kind: "legislation",
      citation: "1 CFR 1.1", title: "Federal regulation", collection: "CFR", date: "2025-01-01" }, jurisdiction: "US" },
    { source: { provider: "tna", id: "uksc/2026/1", kind: "case",
      citation: "[2026] UKSC 1", title: "UK decision", collection: "uksc" }, jurisdiction: "UK" },
    { source: { provider: "govuk-et", id: "tribunal-decision", kind: "case",
      citation: "1234/2026", title: "Tribunal decision", collection: "employment-tribunal" }, jurisdiction: "UK" },
  ])("preserves $source.provider $source.kind identity through PDF lookup and rehydration", async ({ source, jurisdiction }) => {
    const requestReference = `mike-provider-pdf:v1:${source.provider}:${"1".repeat(64)}`;
    const sourceReference = `${requestReference}:${"2".repeat(64)}`;
    const handle = `mike-evidence:v1:${"3".repeat(64)}`;
    const ready = {
      availability: "ready",
      state: {
        provider: source.provider,
        identity: source.id,
        request_reference: requestReference,
        reference_id: sourceReference,
        source_reference: sourceReference,
        download_status: "downloaded",
        source_sha256: "2".repeat(64),
        parse_status: "ready",
        fetched_at: "2026-07-27T00:00:00.000Z",
        checked_at: "2026-07-27T00:00:00.000Z",
      },
      params: {
        provider: source.provider,
        identity: source.id,
        source,
        structureSource: "flat_text",
        url: "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf",
        title: "Attachment title must not replace the source citation",
      },
      lookup: {
        status: "found",
        matches: [],
        source: { version_id: "2".repeat(32) },
        evidence: {
          handle,
          page_numbers: [3],
          page_text_sha256: "4".repeat(64),
        },
        link: { page_numbers: [3] },
        units: [
          {
            id: "page-3",
            kind: "page",
            locator: "[page 3]",
            text:
              "Unique first context. The exact governing rule applies here. " +
              "Unique first conclusion.",
            page_numbers: [3],
            proposition: { sentence: "The supporting proposition refers to this note.",
              passage_since_prior_note: "The supporting proposition refers to this note." },
            confidence: 0.99,
            note: { label: "1", warnings: ["Footnote marker is uncertain."] },
            confidence_basis: "native",
            provenance: "parser",
          },
        ],
        before: [],
        after: [],
      },
    };
    lookupProviderPdfReference
      .mockResolvedValueOnce({
        availability: "queued",
        state: {
          reference_id: requestReference,
          download_status: "queued",
          parse_status: null,
        },
      })
      .mockResolvedValueOnce(ready);
    rehydrateProviderPdfReference.mockResolvedValue(ready);
    const [queued] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-queued",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", requestReference),
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
    );
    expect(JSON.parse(queued.content)).toMatchObject({
      ok: false,
      status: "queued",
      reference_id: requestReference,
    });

    const [resolved] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-ready",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", requestReference),
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
    );
    const payload = JSON.parse(resolved.content);
    expect(payload).toMatchObject({
      ok: true,
      title: source.title,
      citation: source.citation,
      handle,
    });
    expect(resolved.evidence).toEqual([
      expect.objectContaining({
        provider: source.provider,
        jurisdiction,
        source_class: source.kind,
        citation: source.citation,
        name: source.title,
        dataset: source.collection,
        language: source.language ?? "en",
        version: source.date ?? null,
        source_reference: { id: source.id, ...(source.part ? { part: source.part } : {}) },
        source_sha256: "2".repeat(64),
        stable_source_id: `${sourceReference}:page:page-3`,
        span_text: "Unique first context. The exact governing rule applies here. " +
          "Unique first conclusion.\n\nThe supporting proposition refers to this note.",
        external_url:
          "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf#page=3",
        locator: { kind: "page", label: "page=3" },
      }),
    ]);
    expect(payload.passages).toEqual([expect.objectContaining({
      evidence_id: (resolved.evidence?.[0] as { evidence_id: string }).evidence_id,
      kind: "page", locator: "[page 3]", pages: [3], confidence: 0.99,
      note: { label: "1", warnings: ["Footnote marker is uncertain."] },
      text: resolved.evidence![0].span_text,
    })]);

    const [rehydrated] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-rehydrate",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", sourceReference),
            handle,
          },
        },
      ],
    );
    expect(JSON.parse(rehydrated.content)).toEqual({ ...payload,
      resource: resourceReference.source("pdf", sourceReference) });
    expect(rehydrated.evidence).toEqual(resolved.evidence);
  });

  it("keeps A2AJ links server-side without queuing PDF work", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence.`,
    ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 1",
              source_url_en:
                "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
              unofficial_text_en: text,
            },
          ],
        }),
      }),
    );
    const source = `source://a2aj/${encodeURIComponent(JSON.stringify([
      "2099 SCC 1",
      "cases",
      "SCC",
    ]))}`;
    const [response] = await runLocalAssistantTools("local-user", [
      {
        id: "call-a2aj",
        name: "Read",
        input: { file_path: source },
      },
    ]);

    const fetchPayload = JSON.parse(response.content);
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
    expect(fetchPayload.url).toBeUndefined();
    expect(fetchPayload.pdf_rendition).toBeUndefined();

    const [lookupResponse] = await runLocalAssistantTools("local-user", [
      {
        id: "lookup-a2aj",
        name: "Read",
        input: {
          file_path: source,
          locator_kind: "paragraph",
          locator: "1",
        },
      },
    ]);
    const lookupPayload = JSON.parse(lookupResponse.content);
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
    expect(lookupPayload.url).toBeUndefined();
    expect(lookupPayload.pdf_rendition).toBeUndefined();

    const [found] = await runLocalAssistantTools("local-user", [{
      id: "find-a2aj",
      name: "Read",
      input: { file_path: source, pattern: "substantive judicial language" },
    }]);
    expect(JSON.parse(found.content)).toMatchObject({
      ok: true,
      total_matches: 6,
      passages: expect.arrayContaining([expect.objectContaining({ evidence_id: expect.stringMatching(/^e_/u) })]),
      hits: expect.arrayContaining([expect.objectContaining({
        evidence_id: expect.stringMatching(/^e_/u),
      })]),
    });
    expect(found.evidence?.[0]).toMatchObject({
      evidence_id: expect.stringMatching(/^e_/u),
      span_text: expect.stringContaining("substantive judicial language"),
    });
  });
});
