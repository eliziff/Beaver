import { afterEach, describe, expect, it, vi } from "vitest";

import { createTnaEvidence, createLibraryEvidence, createLegalEvidenceTurnState, finalizeLegalEvidence, hasCaseNameInText, legalEvidenceReceiptEvent, legalEvidenceProseIntegrityErrors, legalEvidenceResourceReference, priorLegalEvidenceReceipts, priorLegalEvidencePrompt, registerLegalEvidence, registerPriorLegalEvidence, readPriorLegalEvidence, renderLegalEvidenceAnswer, restorePriorLegalEvidence, submitLegalEvidenceAnswer, validateGroundedClaims } from "../legalEvidence";
import { createLegalEvidenceCitations, createLegalEvidenceCitationsFromEntries } from "../citations";
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
      locator: { kind: "cell", label: "Penalty-Summary!B4", sheet: "Penalty-Summary", cells: "B4" } });
    expect(legalEvidenceResourceReference(sheet)).toBe("document://doc/version/v1");
    expect(createLegalEvidenceCitationsFromEntries([{ receipt: sheet }])[0]).toMatchObject({
      kind: "document", locator_kind: "cell", locator: "Penalty-Summary!B4", sheet: "Penalty-Summary", cells: "B4",
    });
  });

  it.each(["document", "page"] as const)("keeps distinct Library spans on the same %s separate", (kind) => {
    const state = createLegalEvidenceTurnState();
    const sourceText = "First obligation. Second obligation.";
    const receipts = [[0, 17], [18, 36]].map(([start, end]) => createLibraryEvidence({
      documentId: "doc", versionId: "v1", filename: "Terms.docx", sourceText,
      spanText: sourceText.slice(start, end), start, end, locator: { kind, label: kind === "page" ? "page1" : "text paragraph 34" },
    }));
    receipts.forEach((receipt) => registerLegalEvidence(state, receipt));
    expect(submitLegalEvidenceAnswer({ claims: [0, 1, 0].map((index) => ({
      text: receipts[index].span_text, evidence_ids: [receipts[index].evidence_id],
    })) }, state).ok).toBe(true);
    expect(renderLegalEvidenceAnswer(state)).toBe("First obligation. [1]\n\nSecond obligation. [2]\n\nFirst obligation. [3]");
    expect(createLegalEvidenceCitations(state).map(({ quotes }) => quotes)).toEqual([receipts[0], receipts[1], receipts[0]].map((receipt) => [
      { quote: receipt.span_text, ...(kind === "page" && { page: "1" }) },
    ]));
    expect(submitLegalEvidenceAnswer({ claims: [{ text: "An obligation. [3]",
      evidence_ids: [receipts[0].evidence_id] }] }, state).ok).toBe(false);
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

  it("allows unquoted extraction wording without relaxing quote or receipt integrity", () => {
    const sourceText = "The Customer shall obtain the Supplier's prior written consent before any change of control.",
      state = createLegalEvidenceTurnState(), receipt = createLibraryEvidence({ documentId: "consent",
        versionId: "v1", filename: "consent.txt", sourceText, spanText: sourceText, start: 0, end: sourceText.length }),
      claim = (text: string, id = receipt.evidence_id) => [{ text, evidence_ids: [id] }],
      options = { allowUnquotedCopies: true };
    registerLegalEvidence(state, receipt);
    expect(submitLegalEvidenceAnswer({ claims: claim(sourceText) }, state).errors)
      .toEqual([expect.stringContaining("unmarked copied passage")]);
    expect(validateGroundedClaims(claim(sourceText), state, options).errors).toEqual([]);
    expect(validateGroundedClaims(claim(`"${sourceText}"`), state, options).errors).toEqual([]);
    const mixed = `${sourceText} The exception says "Consent is never required for a change of control."`;
    expect(validateGroundedClaims(claim(mixed), state, options).errors)
      .toEqual([expect.stringContaining("does not match its cited evidence")]);
    expect(validateGroundedClaims(claim(sourceText, "unavailable"), state, options).errors.join(" "))
      .toContain("unknown evidence_id");
    registerLegalEvidence(state, { ...receipt, span_text: "Tampered source text." });
    expect(validateGroundedClaims(claim(sourceText), state, options).errors.join(" "))
      .toContain("damaged passage");
  });

  it("keeps a rejected submission as the draft and takes back only the claims that failed", () => {
    const state = createLegalEvidenceTurnState(), evidence = passage();
    registerLegalEvidence(state, evidence);
    const claim = (text: string) => ({ text, evidence_ids: [evidence.evidence_id] });
    const rejected = submitLegalEvidenceAnswer({ replace: null, claims: [claim("The appeal is allowed."),
      claim("Supporting analysis. ".repeat(80)), claim("The appeal is allowed.")] }, state);
    expect(rejected.ok).toBe(false);
    expect(rejected.draft_claims).toBe(3);
    expect(rejected.errors).toEqual([expect.stringContaining("claims[1].text is 1679 characters and the limit is 1200")]);
    expect(rejected.next).toContain("replace");
    const twoSentences = submitLegalEvidenceAnswer({ claims: null, replace: [{ index: 1,
      ...claim("The appeal is allowed. The appeal is allowed.") }] }, state);
    expect(twoSentences).toEqual({ ok: true, terminal: true });
    expect(state.answer).toHaveLength(3);
  });

  it("normalizes repeated handles without weakening reference or quotation validation", () => {
    const state = createLegalEvidenceTurnState(), evidence = passage();
    registerLegalEvidence(state, evidence);
    const claims = [{ text: "The appeal is allowed. This is the disposition.",
      evidence_ids: Array(8).fill(evidence.evidence_id) }];
    expect(submitLegalEvidenceAnswer({ claims }, state)).toEqual({ ok: true, terminal: true });
    expect(state.answer?.[0].evidence_ids).toEqual([evidence.evidence_id]);
    expect(claims[0].evidence_ids).toHaveLength(8);
    expect(validateGroundedClaims([{ ...claims[0], evidence_ids: [evidence.evidence_id, null] }], state)
      .errors).toContain("claims[0].evidence_ids must contain 1 to 4 unique handles");
    expect(validateGroundedClaims([{ ...claims[0], evidence_ids: ["missing", "missing"] }], state)
      .errors.join(" ")).toContain("unknown evidence_id");
    expect(validateGroundedClaims([{ ...claims[0], text: 'The court said "This is invented wording."' }], state)
      .errors.join(" ")).toContain("does not match its cited evidence");
  });

  it("refuses a replacement that names no draft or a claim outside it", () => {
    const state = createLegalEvidenceTurnState(), evidence = passage();
    registerLegalEvidence(state, evidence);
    const claim = { text: "The appeal is allowed.", evidence_ids: [evidence.evidence_id] };
    expect(submitLegalEvidenceAnswer({ replace: [{ index: 0, ...claim }] }, state).errors)
      .toEqual(["there is no draft to replace; send the whole answer in claims"]);
    submitLegalEvidenceAnswer({ claims: [{ ...claim, text: "" }] }, state);
    expect(submitLegalEvidenceAnswer({ replace: [{ index: 2, ...claim }] }, state).errors)
      .toEqual(["replace names claim 2; the draft holds claims 0 to 0"]);
    expect(submitLegalEvidenceAnswer({ replace: [{ index: 0, ...claim }] }, state))
      .toEqual({ ok: true, terminal: true });
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

  it("reports quoted citation text from the draft without demanding authorities", () => {
    const reporting = createLegalEvidenceTurnState();
    expect(finalizeLegalEvidence(reporting, "In-text citation 1 reads “Bhasin v. Hrynew, " +
      "2014 SCC” and should read “Bhasin v. Hrynew, 2014 SCC 71”; use Use selection as citation."))
      .toBe(true);
    expect(reporting.failure).toBeNull();

    const asserting = createLegalEvidenceTurnState();
    expect(finalizeLegalEvidence(asserting, "Bhasin v. Hrynew, 2014 SCC 71 recognized good faith."))
      .toBe(false);
  });

  it("reports the bound draft's own citation text however it is punctuated", () => {
    const reporting = createLegalEvidenceTurnState();
    reporting.reportedCitations = new Set(["Bhasin v. Hrynew",
      "Bhasin v. Hrynew, 2014 SCC", "Bhasin v. Hrynew, 2014 SCC 71"]);
    expect(finalizeLegalEvidence(reporting, "In-text citation 1 reads Bhasin v. Hrynew, 2014 SCC " +
      "and should read Bhasin v. Hrynew, 2014 SCC 71; press Use selection as citation."))
      .toBe(true);
    expect(reporting.failure).toBeNull();

    const advancing = createLegalEvidenceTurnState();
    advancing.reportedCitations = new Set(["Bhasin v. Hrynew, 2014 SCC"]);
    expect(finalizeLegalEvidence(advancing, "The boundary is wrong, and R. v. Oakes governs it."))
      .toBe(false);
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

  it("refuses a neighbouring paragraph handle and accepts the named paragraph", () => {
    const state = createLegalEvidenceTurnState();
    const wrong = passage("par73"), right = passage("par74");
    registerLegalEvidence(state, wrong); registerLegalEvidence(state, right);
    const text = "The duty applies irrespective of intention: 2024 SCC 1, para. 74.";
    expect(submitLegalEvidenceAnswer({ claims: [{ text, evidence_ids: [wrong.evidence_id] }] }, state))
      .toMatchObject({ ok: false, errors: [expect.stringContaining("paragraphs 74 require their exact passage")] });
    expect(submitLegalEvidenceAnswer({ claims: [{ text, evidence_ids: [wrong.evidence_id, right.evidence_id] }] }, state).ok)
      .toBe(false);
    expect(submitLegalEvidenceAnswer({ claims: [{ text, evidence_ids: [right.evidence_id] }] }, state).ok).toBe(true);
    expect(createLegalEvidenceCitations(state)[0]).toMatchObject({ locator: "74" });
    const range = "The duty applies: 2024 SCC 1, paras. 73–75.";
    const end = passage("par75"); registerLegalEvidence(state, end);
    expect(submitLegalEvidenceAnswer({ claims: [{ text: range, evidence_ids: [wrong.evidence_id, end.evidence_id] }] }, state).ok)
      .toBe(false);
    expect(submitLegalEvidenceAnswer({ claims: [{ text: range,
      evidence_ids: [wrong.evidence_id, right.evidence_id, end.evidence_id] }] }, state).ok).toBe(true);
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
      // Even the same receipt gets a fresh reference for a later claim.
      { text: "Oakes proposition 1 again.", evidence_ids: [ids[0]] },
    ] }, state);

    expect(createLegalEvidenceCitations(state).map(
      ({ ref, authority, pinpoint, short_form }) => [ref, authority, pinpoint, short_form],
    )).toEqual([
      [1, "R. v. Oakes, [1986] 1 SCR 103", "para 1", undefined],
      [2, "R. v. Oakes, [1986] 1 SCR 103", "para 3", true],
      [3, "R. v. Oakes, [1986] 1 SCR 103", "para 4", true],
      [4, "R. v. Oakes, [1986] 1 SCR 103", "para 69", true],
      [5, "R. v. Oakes, [1986] 1 SCR 103", "para 1", true],
    ]);
    expect(renderLegalEvidenceAnswer(state)).toBe([
      "Oakes proposition 1. [1]", "Oakes proposition 2. [2]",
      "Oakes proposition 3. [3]", "Oakes proposition 4. [4]",
      "Oakes proposition 1 again. [5]",
    ].join("\n\n"));
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

  it("requires both pinpointed sources for every review finding", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    state.reviewDocumentIds = new Set(["brief"]);
    const document = createLibraryEvidence({ documentId: "brief", versionId: "v1", filename: "brief.docx",
      sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.", start: 0, end: 22,
      locator: { kind: "paragraph", label: "para 5" } });
    const authority = passage();
    for (const receipt of [document, authority]) registerLegalEvidence(state, receipt);
    const claim = (ids: string[]) => ({ text: "The result requires qualification.", evidence_ids: ids });
    for (const ids of [[document.evidence_id], [authority.evidence_id]]) {
      expect(submitLegalEvidenceAnswer({ claims: [claim(ids)] }, state).ok).toBe(false);
      expect(renderLegalEvidenceAnswer(state)).toBeNull();
    }
    expect(submitLegalEvidenceAnswer({ claims: [claim([document.evidence_id, authority.evidence_id])] }, state).ok).toBe(true);
    expect(createLegalEvidenceCitations(state).map(({ pinpoint }) => pinpoint)).toEqual(["para 5", "para 12"]);
    const broad = passage(" ");
    registerLegalEvidence(state, broad);
    expect(submitLegalEvidenceAnswer({ claims: [claim([document.evidence_id, broad.evidence_id])] }, state).ok).toBe(false);
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
    }] }, state).errors).toContain("claims[0].text is 1201 characters and the limit is 1200; split it into concise support units with their own evidence_ids");
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

  it("keeps granular support without counting sentences", () => {
    const state = createLegalEvidenceTurnState("citation_structure"), evidence = [passage("par30"), passage("par31")];
    evidence.forEach((receipt) => registerLegalEvidence(state, receipt));
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal succeeded. Both passages record that result.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state).ok).toBe(true);
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal succeeded. Both passages record that result. [1]");
    expect(submitLegalEvidenceAnswer({ claims: [
      { text: "The appeal succeeded.", evidence_ids: [evidence[0].evidence_id] },
      { text: "Both passages record that result.", evidence_ids: evidence.map(({ evidence_id }) => evidence_id) },
    ] }, state).ok).toBe(true);
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal succeeded. [1]\n\nBoth passages record that result. [2]");
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
