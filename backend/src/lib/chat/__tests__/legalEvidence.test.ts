import { afterEach, describe, expect, it, vi } from "vitest";

import { createLibraryEvidence, createLegalEvidenceTurnState, finalizeLegalEvidence, hasCaseNameInText, legalEvidenceReceiptEvent, legalEvidenceProseIntegrityErrors, legalEvidenceResourceReference, priorLegalEvidenceReceipts, priorLegalEvidencePrompt, registerLegalEvidence, registerPriorLegalEvidence, readPriorLegalEvidence, renderLegalEvidenceAnswer, restorePriorLegalEvidence, submitLegalEvidenceAnswer, validateGroundedClaims } from "../legalEvidence";
import { createLegalEvidenceCitations, createLegalEvidenceCitationsFromEntries } from "../citations";
import { a2ajLegalSourceProvider } from "../../legalSources/a2aj";
import { structureNative } from "../../structureNative";

describe("production legal evidence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("identifies exact source/version/occurrence independently of presentation", async () => {
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

  it.each(["document", "page"] as const)("keeps distinct Library spans on the same %s separate", async (kind) => {
    const state = createLegalEvidenceTurnState();
    const sourceText = "First obligation. Second obligation.";
    const receipts = [[0, 17], [18, 36]].map(([start, end]) => createLibraryEvidence({
      documentId: "doc", versionId: "v1", filename: "Terms.docx", sourceText,
      spanText: sourceText.slice(start, end), start, end, locator: { kind, label: kind === "page" ? "page1" : "text paragraph 34" },
    }));
    receipts.forEach((receipt) => registerLegalEvidence(state, receipt));
    expect((await submitLegalEvidenceAnswer({ claims: [0, 1, 0].map((index) => ({
      text: receipts[index].span_text, evidence_ids: [receipts[index].evidence_id],
    })) }, state)).ok).toBe(true);
    expect(renderLegalEvidenceAnswer(state)).toBe("First obligation. [1]\n\nSecond obligation. [2]\n\nFirst obligation. [3]");
    expect(createLegalEvidenceCitations(state).map(({ quotes }) => quotes)).toEqual([receipts[0], receipts[1], receipts[0]].map((receipt) => [
      { quote: receipt.span_text, ...(kind === "page" && { page: "1" }) },
    ]));
    expect((await submitLegalEvidenceAnswer({ claims: [{ text: "An obligation. [3]",
      evidence_ids: [receipts[0].evidence_id] }] }, state)).ok).toBe(false);
  });

  it("allows unquoted extraction wording without relaxing quote or receipt integrity", async () => {
    const sourceText = "The Customer shall obtain the Supplier's prior written consent before any change of control.",
      state = createLegalEvidenceTurnState(), receipt = createLibraryEvidence({ documentId: "consent",
        versionId: "v1", filename: "consent.txt", sourceText, spanText: sourceText, start: 0, end: sourceText.length }),
      claim = (text: string, id = receipt.evidence_id) => [{ text, evidence_ids: [id] }],
      options = { allowUnquotedCopies: true };
    registerLegalEvidence(state, receipt);
    expect((await submitLegalEvidenceAnswer({ claims: claim(sourceText) }, state)).errors)
      .toEqual([expect.stringContaining("unmarked copied passage")]);
    expect((await validateGroundedClaims(claim(sourceText), state, options)).errors).toEqual([]);
    expect((await validateGroundedClaims(claim(`"${sourceText}"`), state, options)).errors).toEqual([]);
    const mixed = `${sourceText} The exception says "Consent is never required for a change of control."`;
    expect((await validateGroundedClaims(claim(mixed), state, options)).errors)
      .toEqual([expect.stringContaining("does not match its cited evidence")]);
    expect((await validateGroundedClaims(claim(sourceText, "unavailable"), state, options)).errors.join(" "))
      .toContain("unknown evidence_id");
    registerLegalEvidence(state, { ...receipt, span_text: "Tampered source text." });
    expect((await validateGroundedClaims(claim(sourceText), state, options)).errors.join(" "))
      .toContain("damaged passage");
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

  // Replays a turn from the local transcript store (chat 582819ad), where
  // every sentence resting on R. v. Grant carried the union of every
  // paragraph read. A pinpoint belongs to the proposition it supports.

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

  it("checks full prior passages only when read or cited, while still checking inventory previews", async () => {
    const copied = "The responding party must provide written notice before the hearing can proceed to the final determination of the disputed factual issues.",
      text = "Unrelated introductory discussion. ".repeat(10_000) + copied,
      receipt = createLibraryEvidence({ documentId: "large", versionId: "v1", filename: "Record",
        sourceText: text, spanText: text, start: 0, end: text.length }),
      state = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(state, [receipt]);
    expect((await legalEvidenceProseIntegrityErrors(copied, [], state))).toEqual([]);
    expect((await legalEvidenceProseIntegrityErrors(`"${copied}"`, [receipt.evidence_id], state))).toEqual([]);
    expect(readPriorLegalEvidence(state, receipt.evidence_id)).not.toBeNull();
    expect((await legalEvidenceProseIntegrityErrors(copied, [], state)).join(" ")).toContain("unmarked copied passage");

    const preview = createLibraryEvidence({ documentId: "preview", versionId: "v1", filename: "Other record",
      sourceText: copied, spanText: copied, start: 0, end: copied.length });
    const unopened = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(unopened, [preview]);
    expect((await legalEvidenceProseIntegrityErrors(copied, [], unopened)).join(" ")).toContain("unmarked copied passage");
  });

});
