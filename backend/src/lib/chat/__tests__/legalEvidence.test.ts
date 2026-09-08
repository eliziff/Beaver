import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTnaEvidence,
  createLibraryEvidence,
  createPublicJournalPassageEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidence,
  GROUNDED_QUOTATION_POLICY,
  GROUNDED_QUOTATION_POLICY_CLASSIC,
  GROUNDED_QUOTATION_POLICY_CURRENT,
  hasCaseNameInText,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  legalEvidenceCitationEntries,
  legalEvidenceReceiptEvent,
  legalEvidenceRequested,
  legalEvidenceProseIntegrityErrors,
  legalEvidenceResourceReference,
  priorLegalEvidenceReceipts,
  priorLegalEvidencePrompt,
  priorLegalResearchQueryReceipts,
  registerLegalEvidence,
  registerLegalResearchQueries,
  registerPriorLegalEvidence,
  registerPriorLegalResearchQueries,
  readPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  restorePriorLegalEvidence,
  selectGroundedQuotationPolicy,
  submitLegalEvidenceAnswer,
  validateGroundedClaims,
} from "../legalEvidence";
import {
  createLegalEvidenceCitations,
  createLegalEvidenceCitationsFromEntries,
  createLegalSourceSearchCitations,
} from "../citations";
import { CODING_PRODUCTION_SYSTEM_PROMPT } from "../prompts";
import { a2ajLegalSourceProvider } from "../../legalSources/a2aj";
import { structureNative } from "../../structureNative";

function passage(locatorLabel = "par12") {
  return createTnaEvidence({
    jurisdiction: "CA",
    sourceClass: "case",
    stableSourceId: "courtlistener:1",
    sourceText: "The appeal is allowed.",
    spanText: "The appeal is allowed.",
    citation: "2024 SCC 1",
    name: "Example v Example",
    dataset: "courtlistener",
    externalUrl: "https://example.test/case",
    locatorKind: "paragraph",
    locatorLabel,
  });
}

describe("production legal evidence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("identifies exact source/version/occurrence independently of presentation", () => {
    const source = { documentId: "doc", versionId: "v1", filename: "Workbook.xlsx",
      sourceText: "Same text. Same text.", spanText: "Same text.", start: 0, end: 10 };
    const first = createLibraryEvidence(source);
    expect(createLibraryEvidence({ ...source, blockId: "paragraph:1",
      locator: { kind: "paragraph", label: "1" } }).evidence_id).toBe(first.evidence_id);
    expect(createLibraryEvidence({ ...source, start: 11, end: 21 }).evidence_id)
      .not.toBe(first.evidence_id);
    expect(createLibraryEvidence({ ...source, versionId: "v2" }).evidence_id)
      .not.toBe(first.evidence_id);
    expect(createLibraryEvidence({ ...source, blockId: "pdf:page-1" }).evidence_id)
      .not.toBe(createLibraryEvidence({ ...source, blockId: "pdf:page-2" }).evidence_id);
    const sheet = createLibraryEvidence({ ...source,
      locator: { kind: "cell", label: "Terms!B4", sheet: "Terms", cells: "B4" } });
    expect(legalEvidenceResourceReference(sheet)).toBe("document://doc/version/v1");
    expect(createLegalEvidenceCitationsFromEntries([{ receipt: sheet }])[0]).toMatchObject({
      kind: "document", locator_kind: "cell", locator: "Terms!B4", sheet: "Terms", cells: "B4",
    });
  });

  it("shares grounding checks without imposing chat answer limits on extraction", () => {
    const state = createLegalEvidenceTurnState(), evidence = passage();
    registerLegalEvidence(state, evidence);
    const claims = Array.from({ length: 70 }, () => ({ text: "The appeal succeeds.",
      evidence_ids: [evidence.evidence_id] }));
    expect(validateGroundedClaims(claims, state).errors).toEqual([]);
    expect(submitLegalEvidenceAnswer({ claims }, state).ok).toBe(false);
    const long = [{ ...claims[0], text: "Supporting analysis. ".repeat(80) }];
    expect(validateGroundedClaims(long, state).errors).toEqual([]);
    expect(submitLegalEvidenceAnswer({ claims: long }, state).ok).toBe(false);
    registerLegalEvidence(state, { ...evidence, span_text: "Tampered source text." });
    expect(validateGroundedClaims(claims, state).errors.join(" ")).toContain("damaged passage");
  });

  it("recognizes named cases even when the model omits their citations", () => {
    expect(hasCaseNameInText("My favourite is *R. v. Oakes*.")).toBe(true);
    expect(hasCaseNameInText("I prefer Baker v. Canada for this point.")).toBe(true);
    expect(hasCaseNameInText("The answer is a general explanation.")).toBe(false);

    const state = createLegalEvidenceTurnState();
    expect(finalizeLegalEvidence(state, "My favourite is *R. v. Oakes*.")).toBe(false);
    expect(state.failure).toContain("without verified passages");
    expect(renderLegalEvidenceAnswer(state)).toBeNull();
  });

  it("accepts registered passages and emits durable receipts", () => {
    const state = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    const event = legalEvidenceReceiptEvent(state)!;
    expect(event.status).toBe("passed");
    expect(priorLegalEvidenceReceipts([event])).toEqual([evidence]);
  });

  it("keeps each grounded table row's citations inside its final cell", () => {
    const state = createLegalEvidenceTurnState();
    const first = passage("par12"), second = passage("par13");
    registerLegalEvidence(state, first);
    registerLegalEvidence(state, second);
    expect(submitLegalEvidenceAnswer({ claims: [
      { text: "The appeal is allowed.", evidence_ids: [first.evidence_id] },
      { text: "| Outcome | Source |\n| --- | --- |\n| The appeal is allowed. | |", evidence_ids: [first.evidence_id] },
      { text: "| The appeal is allowed. | |", evidence_ids: [second.evidence_id] },
      { text: "The appeal is allowed.", evidence_ids: [second.evidence_id] },
    ] }, state)).toEqual({ ok: true, terminal: true });
    // Each row carries the pinpoint of its own evidence, and the second
    // reference to the decision is a short form rather than the full citation.
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The appeal is allowed. [1]\n\n| Outcome | Source |\n| --- | --- |\n| The appeal is allowed. | [1] |\n| The appeal is allowed. | [2] |\n\nThe appeal is allowed. [2]",
    );
    expect(createLegalEvidenceCitations(state).map(({ pinpoint, short_form }) =>
      [pinpoint, short_form])).toEqual([["para 12", undefined], ["para 13", true]]);
  });

  it("persists a query-only turn as an auditable research receipt", () => {
    const state = createLegalEvidenceTurnState();
    registerLegalResearchQueries(state, [{
      call_id: "call_1",
      tool: "search_sources",
      executed_at: "2026-08-30T12:00:00.000Z",
      executor_version: "legal-source-search-v1",
      input: { query: "standard of review", limit: 10 },
      results: [{ rank: 1, resource: "source://a2aj/cases/scc/2019-scc-65" }],
    }], "test-model");

    const event = legalEvidenceReceiptEvent(state)!;
    expect(event).toMatchObject({
      schema_version: 7,
      status: "passed",
      evidence: [],
      queries: [expect.objectContaining({
        call_id: "call_1",
        model: "test-model",
        tool: "search_sources",
      })],
    });
    expect(priorLegalResearchQueryReceipts([event])).toEqual(event.queries);
    expect(priorLegalResearchQueryReceipts([{ ...event, status: "failed" }]))
      .toEqual(event.queries);
    const restored = createLegalEvidenceTurnState();
    registerPriorLegalResearchQueries(restored,
      priorLegalResearchQueryReceipts([event]));
    expect([...restored.queries]).toEqual([[event.queries[0].query_id, event.queries[0]]]);
    expect(legalEvidenceReceiptEvent(restored)).toBeNull();
    const inventory = priorLegalEvidencePrompt([], event.queries);
    expect(inventory).toContain(event.queries[0].query_id);
    expect(inventory).toContain("standard of review");
    expect(inventory).not.toContain("executor_version");
  });

  it("strips DOCX citation-handle markers that leak into chat claims", () => {
    // The model sometimes over-applies the Write.citations "[@id]" marker
    // convention to submit_grounded_answer prose. Pills come from
    // evidence_ids at render time, so the inline token is dropped rather
    // than leaking a raw handle into the answer.
    const state = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: 'Every parent has an obligation [@id1] to provide support.',
      evidence_ids: [evidence.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "Every parent has an obligation to provide support. [1]",
    );
  });

  it("collapses one provision family into a single chip in both views", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const ids = ["sec50(1)", "sec50(1)(a)", "sec50(1)(b)", "sec50(1)(c)"].map(
      (label) => {
        const evidence = {
          ...passage(label),
          provider: "a2aj" as const,
          stable_source_id: `a2aj:fla:${label}`,
          citation: "SA 2003, c F-4.5",
          dataset: "LEGISLATION-AB",
          name: "Family Law Act",
          external_url:
            "https://kings-printer.alberta.ca/1266.cfm?page=F04P5.cfm&leg_type=Acts&isbncln=9780779854820&display=html",
          locator: { kind: "section" as const, label },
        };
        registerLegalEvidence(state, evidence);
        return evidence.evidence_id;
      },
    );
    submitLegalEvidenceAnswer({ claims: [
      { text: "First clause proposition.", evidence_ids: [ids[0]] },
      { text: "Second clause proposition.", evidence_ids: [ids[1]] },
      { text: "Third clause proposition.", evidence_ids: [ids[2]] },
      { text: "Fourth clause proposition.", evidence_ids: [ids[3]] },
    ] }, state);

    // Each proposition carries the clause it rests on; family collapse still
    // applies inside a claim, but never merges four claims into one pinpoint.
    expect(renderLegalEvidenceAnswer(state)).toBe(
      [
        "First clause proposition. [1]",
        "Second clause proposition. [2]",
        "Third clause proposition. [3]",
        "Fourth clause proposition. [4]",
      ].join("\n\n"),
    );
    const citations = createLegalEvidenceCitations(state);
    expect(citations.map(({ pinpoint }) => pinpoint))
      .toEqual(["s 50(1)", "s 50(1)(a)", "s 50(1)(b)", "s 50(1)(c)"]);
    // The tool-call view has no claims to divide, so it presents the family
    // once; the answer's chips still carry a clause each.
    expect(createLegalEvidenceCitationsFromEntries(
      legalEvidenceCitationEntries(state),
    ).map(({ pinpoint }) => pinpoint)).toEqual(["s 50(1)"]);
  });

  it("keeps sibling provision receipts separate under one collapsed chip", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const ids = ["sec49(2)(a)", "sec49(2)(b)"].map((label) => {
      const evidence = {
        ...passage(label),
        provider: "a2aj" as const,
        stable_source_id: `a2aj:fla:${label}`,
        citation: "SA 2003, c F-4.5",
        dataset: "LEGISLATION-AB",
        name: "Family Law Act",
        external_url: "https://kings-printer.alberta.ca/1266.cfm?page=F04P5.cfm",
        locator: { kind: "section" as const, label },
      };
      registerLegalEvidence(state, evidence);
      return evidence.evidence_id;
    });
    submitLegalEvidenceAnswer({ claims: [{
      text: "Both clauses matter.",
      evidence_ids: ids,
    }] }, state);

    const citations = createLegalEvidenceCitations(state);
    expect(renderLegalEvidenceAnswer(state)).toBe("Both clauses matter. [1]");
    expect(citations.map(({ pinpoint }) => pinpoint))
      .toEqual(["s 49(2)(a)\u2013(b)"]);
    // Both receipts survive in the evidence store behind that one chip.
    expect(legalEvidenceCitationEntries(state).map(
      ({ receipt }) => receipt.locator.label)).toEqual(ids.map(() => expect.any(String)));
    expect(createLegalEvidenceCitationsFromEntries(
      legalEvidenceCitationEntries(state),
    )).toEqual(citations);
  });

  // Replays a turn from the local transcript store (chat 582819ad), where
  // every sentence resting on R. v. Grant carried the union of every
  // paragraph read. A pinpoint belongs to the proposition it supports.
  it("gives each claim the pinpoint of its own proposition", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const ids = ["par1", "par3", "par4", "par69"].map((label) => {
      const evidence = { ...passage(label), citation: "[1986] 1 SCR 103",
        name: "R. v. Oakes" };
      registerLegalEvidence(state, evidence);
      return evidence.evidence_id;
    });
    submitLegalEvidenceAnswer({ claims: [
      ...ids.map((id, index) => ({ text: `Oakes proposition ${index + 1}.`, evidence_ids: [id] })),
      // A later claim on pinpoints already cited reuses that chip.
      { text: "Oakes proposition 1 again.", evidence_ids: [ids[0]] },
    ] }, state);

    expect(createLegalEvidenceCitations(state).map(
      ({ ref, authority, pinpoint, short_form }) => [ref, authority, pinpoint, short_form],
    )).toEqual([
      [1, "R. v. Oakes, [1986] 1 SCR 103", "para 1", undefined],
      [2, "R. v. Oakes, [1986] 1 SCR 103", "para 3", true],
      [3, "R. v. Oakes, [1986] 1 SCR 103", "para 4", true],
      [4, "R. v. Oakes, [1986] 1 SCR 103", "para 69", true],
    ]);
    expect(renderLegalEvidenceAnswer(state)).toBe([
      "Oakes proposition 1. [1]", "Oakes proposition 2. [2]",
      "Oakes proposition 3. [3]", "Oakes proposition 4. [4]",
      "Oakes proposition 1 again. [1]",
    ].join("\n\n"));
  });

  it("keeps unpinpointed passages of one authority on one locator-less chip", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    // An A2AJ headnote sits outside every native paragraph of a
    // paragraph-numbered decision, so the read can only address it by
    // character range; the citator attests the same authority as a document.
    const unpinpointed = ["characters 1963\u20132391", "2019 SCC 34"].map((label, index) => {
      const evidence = createTnaEvidence({
        jurisdiction: "CA", sourceClass: "case", stableSourceId: `le-${index}`,
        sourceText: `Le passage ${index}.`, spanText: `Le passage ${index}.`,
        citation: "2019 SCC 34", name: "R. v. Le", dataset: `dataset-${index}`,
        locatorKind: "document", locatorLabel: label });
      registerLegalEvidence(state, evidence);
      return evidence.evidence_id;
    });
    const paragraphs = ["par1", "par5", "par9", "par14"].map((label) => {
      const evidence = { ...passage(label), citation: "2019 SCC 34", name: "R. v. Le" };
      registerLegalEvidence(state, evidence);
      return evidence.evidence_id;
    });
    submitLegalEvidenceAnswer({ claims: [...unpinpointed, ...paragraphs].map(
      (id, index) => ({ text: `Le proposition ${index}.`, evidence_ids: [id] })) }, state);

    const citations = createLegalEvidenceCitations(state);
    // The two unpinpointed claims share one locator-less chip for the
    // authority; a claim never borrows a pinpoint from a different claim.
    expect(citations.map(({ locator_kind, pinpoint }) => [locator_kind, pinpoint]))
      .toEqual([[undefined, undefined], ["paragraph", "para 1"], ["paragraph", "para 5"],
        ["paragraph", "para 9"], ["paragraph", "para 14"]]);
    expect(citations[0].quotes).toHaveLength(2);
    expect(citations.map(({ short_form }) => short_form))
      .toEqual([undefined, true, true, true, true]);
  });

  it("exposes the approved quotation policy once through the grounding tool", () => {
    expect(GROUNDED_QUOTATION_POLICY_CURRENT).toContain("Quote the shortest passage");
    expect(GROUNDED_QUOTATION_POLICY_CURRENT).toContain("Split the claim");
    expect(selectGroundedQuotationPolicy()).toBe(GROUNDED_QUOTATION_POLICY_CURRENT);
    expect(selectGroundedQuotationPolicy("classic")).toBe(
      GROUNDED_QUOTATION_POLICY_CLASSIC,
    );
    expect(`${CODING_PRODUCTION_SYSTEM_PROMPT}${JSON.stringify(LEGAL_EVIDENCE_SUBMIT_TOOL)}`
      .split(GROUNDED_QUOTATION_POLICY)).toHaveLength(2);
  });

  it("carries an immediate citation correction across the follow-up", () => {
    expect(legalEvidenceRequested([
      { role: "user", content: "Give me a cite." },
      { role: "assistant", content: "Here is one." },
      { role: "user", content: "to the PDF" },
    ])).toBe(true);
    expect(legalEvidenceRequested([
      { role: "user", content: "Read the PDF." },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Tell me more." },
    ])).toBe(false);
  });

  it("persists newly read passages for later turns without grounding the answer", () => {
    const firstTurn = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(firstTurn, evidence);
    const event = legalEvidenceReceiptEvent(firstTurn)!;
    expect(event).toMatchObject({ mode: null, status: "passed", claims: [] });
    expect(event.evidence).toEqual([evidence]);

    const followUp = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(followUp, priorLegalEvidenceReceipts([event]));
    expect(legalEvidenceReceiptEvent(followUp)).toBeNull();
    expect(followUp.evidence.get(evidence.evidence_id)?.receipt).toEqual(evidence);
  });

  it("keeps a bounded inventory while old exact passages remain readable without source fetches", () => {
    const receipts = Array.from({ length: 100 }, (_, index) => {
      const text = `Passage ${index}. ${"Verified source text. ".repeat(100)}`;
      return createLibraryEvidence({
        documentId: `doc-${index}`, filename: `Document ${index}`, versionId: "v1",
        sourceText: text, spanText: text, start: 0, end: text.length,
        locator: { kind: "page", label: "1" },
      });
    });
    const state = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(state, receipts);
    const inventory = priorLegalEvidencePrompt(receipts);
    expect(inventory.length).toBeLessThanOrEqual(8_000);
    expect(inventory).toContain(receipts.at(-1)!.evidence_id);
    expect(inventory).not.toContain(receipts[0].evidence_id);
    expect(inventory).not.toContain(receipts.at(-1)!.span_text);
    expect(readPriorLegalEvidence(state, receipts[0].evidence_id)?.receipt).toEqual(receipts[0]);
    expect(readPriorLegalEvidence(state, "e_missing")).toBeNull();
    registerPriorLegalEvidence(state, [{ ...receipts[0], span_text: "Tampered passage" }]);
    expect(readPriorLegalEvidence(state, receipts[0].evidence_id)).toBeNull();
    registerPriorLegalEvidence(state, [{ ...receipts[0], exact_span_sha256: "tampered" }]);
    expect(readPriorLegalEvidence(state, receipts[0].evidence_id)).toBeNull();
  });

  it("checks full prior passages only when read or cited, while still checking inventory previews", () => {
    const copied = "The responding party must provide written notice before the hearing can proceed to the final determination of the disputed factual issues.",
      text = "Unrelated introductory discussion. ".repeat(10_000) + copied,
      receipt = createLibraryEvidence({ documentId: "large", versionId: "v1", filename: "Record",
        sourceText: text, spanText: text, start: 0, end: text.length }),
      state = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(state, [receipt]);
    expect(legalEvidenceProseIntegrityErrors(copied, [], state)).toEqual([]);
    expect(legalEvidenceProseIntegrityErrors(`"${copied}"`, [receipt.evidence_id], state)).toEqual([]);
    expect(readPriorLegalEvidence(state, receipt.evidence_id)).not.toBeNull();
    expect(legalEvidenceProseIntegrityErrors(copied, [], state).join(" ")).toContain("unmarked copied passage");

    const preview = createLibraryEvidence({ documentId: "preview", versionId: "v1", filename: "Other record",
      sourceText: copied, spanText: copied, start: 0, end: copied.length });
    const unopened = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(unopened, [preview]);
    expect(legalEvidenceProseIntegrityErrors(copied, [], unopened).join(" ")).toContain("unmarked copied passage");
  });

  it("restores a prior A2AJ receipt against its unchanged full source", async () => {
    const text = [
      "Delay in seeking child support may arise for unrelated reasons.",
      "Delay in seeking child support requires a distinct final proposition.",
    ].join("\n");
    const native = await structureNative().deriveDocumentStructure({
      kind: "provider_text",
      input: {
        provider: "a2aj",
        citation: "2006 SCC 37",
        source_kind: "cases",
        text,
        dataset: "SCC",
        require_report_start: true,
        url: "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
      },
    });
    const receipt = {
      ...passage("par101"),
      provider: "a2aj" as const,
      stable_source_id: "a2aj:en:scc:2006 scc 37",
      source_sha256: structureNative().documentRevision(native),
      citation: "2006 SCC 37",
      dataset: "SCC",
      external_url:
        "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
      resolver_version: "a2aj-inline-v1" as const,
    };
    const document = {
      docType: "cases" as const,
      dataset: "SCC",
      citation: "2006 SCC 37",
      alternateCitation: null,
      name: "D.B.S. v S.R.G.",
      date: "2006-07-31",
      url: receipt.external_url,
      verifiedPdf: null,
      language: "en" as const,
      upstreamLicense: null,
      native,
    };
    vi.spyOn(a2ajLegalSourceProvider, "document").mockResolvedValue(document);

    expect(await restorePriorLegalEvidence([receipt])).toEqual([{
      receipt,
      document,
    }]);
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt, { document });
    registerLegalEvidence(state, receipt);
    expect(state.evidence.get(receipt.evidence_id)?.document).toBe(document);
    const related = { ...receipt, evidence_id: "e_other_passage", block_id: "par102" };
    vi.spyOn(a2ajLegalSourceProvider, "document").mockRejectedValue(new Error("must reuse loaded source"));
    expect(await restorePriorLegalEvidence([related], undefined, false,
      [...state.evidence.values()])).toEqual([{ receipt: related, document }]);
  });

  it("emits typed public-source citations from provider receipts", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createTnaEvidence({
      jurisdiction: "UK",
      sourceClass: "case",
      stableSourceId: "uksc/2026/1:page-3",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      citation: "Example v State",
      dataset: "tna",
      externalUrl: "https://example.test/judgment.pdf#page=3",
      locatorKind: "page",
      locatorLabel: "page=3",
    });
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({
        kind: "public_legal",
        ref: 1,
        provider: "tna",
        identifier: "uksc/2026/1:page-3",
        // No source document was loaded, so the citation keeps the page
        // anchor and no text directive: a blind directive would paint
        // whichever passage matched first rather than the cited one.
        url: "https://example.test/judgment.pdf#page=3",
      }),
    ]);
  });

  it("emits document citations for attached PDF passages", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createLibraryEvidence({
      documentId: "document-1",
      versionId: "version-1",
      filename: "record.pdf",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      start: 0,
      end: 22,
      blockId: "pdf:page-5",
      locator: { kind: "page", label: "page 5" },
    });
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({
        kind: "document",
        ref: 1,
        document_id: "document-1",
        version_id: "version-1",
        filename: "record.pdf",
        quotes: [{ quote: "The appeal is allowed." }],
      }),
    ]);
  });

  it("rejects unknown evidence and keeps citation presentation out of prose", () => {
    const rejected = createLegalEvidenceTurnState();
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "Unsupported.",
      evidence_ids: ["e_missing"],
    }] }, rejected).ok).toBe(false);

    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
  });

  it("rejects paragraph-sized claims and broad evidence bundles", () => {
    const state = createLegalEvidenceTurnState();
    const evidence = ["par1", "par2", "par3", "par4", "par5"].map(passage);
    evidence.forEach((receipt) => registerLegalEvidence(state, receipt));

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "x".repeat(1_201),
      evidence_ids: [evidence[0].evidence_id],
    }] }, state).errors).toContain("claims[0].text is invalid");
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "One proposition.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state).errors).toContain(
      "claims[0].evidence_ids must contain 1 to 4 unique handles",
    );
  });

  it("attaches each verified passage without synthesizing citation text or URLs", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const first = passage();
    const second = passage("par13");
    registerLegalEvidence(state, first);
    registerLegalEvidence(state, second);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The court allowed the appeal.",
      evidence_ids: [first.evidence_id, second.evidence_id],
    }] }, state);

    const rendered = renderLegalEvidenceAnswer(state)!;
    expect(rendered).toBe("The court allowed the appeal. [1]");
    expect(rendered).not.toContain("http");
    expect(createLegalEvidenceCitations(state).map(({ pinpoint }) => pinpoint))
      .toEqual(["paras 12\u201313"]);
  });

  it("drops a broad authority receipt when the same claim has an exact pinpoint", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const source = "The necessity test is demanding. Valero identified no unsettled question.";
    const broad = createTnaEvidence({
      jurisdiction: "CA", sourceClass: "case", stableSourceId: "forest-ethics",
      sourceText: source, spanText: "The necessity test is demanding.",
      citation: "2013 FCA 236", name: "Forest Ethics v Canada", dataset: "FCA",
      externalUrl: "https://example.test/forest-ethics",
      locatorKind: "document", locatorLabel: "document",
    });
    const exact = createTnaEvidence({
      jurisdiction: "CA", sourceClass: "case", stableSourceId: "forest-ethics",
      sourceText: source, spanText: "Valero identified no unsettled question.",
      citation: "2013 FCA 236", name: "Forest Ethics v Canada", dataset: "FCA",
      externalUrl: "https://example.test/forest-ethics#para31",
      locatorKind: "paragraph", locatorLabel: "par31",
    });
    [broad, exact].forEach((evidence) => registerLegalEvidence(state, evidence));
    submitLegalEvidenceAnswer({ claims: [{
      text: "Valero identified no question requiring its joinder.",
      evidence_ids: [broad.evidence_id, exact.evidence_id],
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe(
      "Valero identified no question requiring its joinder. [1]",
    );
    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({ pinpoint: "para 31" }),
    ]);
  });

  it("requires separate claims when sentences use different passages", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = [passage("par30"), passage("par31")];
    evidence.forEach((receipt) => registerLegalEvidence(state, receipt));

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The test is demanding. Valero failed to identify an unsettled question.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state).errors).toContain(
      "claims[0] must split sentences supported by different passages",
    );

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "R. v. Smith and Acme Ltd. Canada support one proposition.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state).errors ?? []).not.toContain(
      "claims[0] must split sentences supported by different passages",
    );
  });

  it("collapses one article's pages into a single journal chip", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const citation = "Gordon F. Henderson, “Problems Involved in the Assignment of Patents and Patent Rights” (1966) 1:1 Ottawa L Rev 36";
    const evidence = [60, 61, 62, 63].map((page) =>
      createPublicJournalPassageEvidence({
        citation,
        name: "Problems Involved in the Assignment of Patents and Patent Rights",
        date: "1966",
        url: "https://example.test/article",
        text: `Passage on page ${page}.`,
        articleId: "ottawa-lr-1966-1-1-36",
        locatorKind: "page",
        locatorLabel: `page${page}`,
      }));
    evidence.forEach((receipt) => registerLegalEvidence(state, receipt));
    submitLegalEvidenceAnswer({ claims: [{
      text: "The article discusses assignments.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe(
      "The article discusses assignments. [1]",
    );
    expect(createLegalEvidenceCitations(state).map(({ pinpoint }) => pinpoint))
      .toEqual(["60\u201363"]);
    expect(createLegalEvidenceCitationsFromEntries(
      legalEvidenceCitationEntries(state),
    )).toEqual([expect.objectContaining({
        authority: citation,
        locator: "60–63",
        pinpoint: "60–63",
        quotes: expect.arrayContaining(evidence.map(({ span_text }) => ({ quote: span_text }))),
    })]);
  });

  it("projects searched case names through the ordinary citation model", () => {
    expect(createLegalSourceSearchCitations([{
      provider: "a2aj",
      source_type: "case",
      identifier: "2020 BCSC 1",
      title: "Example v Example",
      citation: "2020 BCSC 1",
      collection: "BCSC",
      url: "https://example.test/case",
    }])).toEqual([expect.objectContaining({
      kind: "a2aj",
      source_class: "case",
      name: "Example v Example",
      citation: "2020 BCSC 1",
      quotes: [],
    })]);
  });

  it("rejects an unstructured legal draft", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    registerLegalEvidence(state, passage());
    expect(finalizeLegalEvidence(state, "Example v Example allowed the appeal.")).toBe(false);
    expect(state.failure).toBe("The model did not submit a grounded answer.");
  });

  it("runs quote and unmarked-copy gates at grounded submission", () => {
    const quoteSource = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:quote",
      sourceText: "The busybody must decide 12 motions, promptly, before the hearing continues.",
      spanText: "The busybody must decide 12 motions, promptly, before the hearing continues.",
      citation: "2024 SCC 2",
      name: "Quote v Example",
      dataset: "fixture",
      externalUrl: "https://example.test/quote",
      locatorKind: "paragraph",
      locatorLabel: "par9",
    });
    const copiedSource = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:copy",
      sourceText: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      spanText: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      citation: "2024 SCC 3",
      name: "Copy v Example",
      dataset: "fixture",
      externalUrl: "https://example.test/copy",
      locatorKind: "paragraph",
      locatorLabel: "par10",
    });
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, quoteSource);
    registerLegalEvidence(state, copiedSource);

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The court wrote, \u201cThe busybody may decide 12 motions, promptly, before the hearing continues.\u201d",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state).errors?.[0]).toContain("does not match");
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state).errors?.[0]).toContain(copiedSource.evidence_id);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The court wrote, \u201c[T]he busybod[ies] must decide 12 motions, promptly, before the hearing continues.\u201d",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
  });
});
