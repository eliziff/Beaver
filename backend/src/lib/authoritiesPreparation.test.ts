import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachAuthoritiesBookPdf, authoritiesReview, updateAuthoritiesDraft } from "./authoritiesActions";
import { createAuthoritiesDraft, type AuthoritiesDraft } from "./authoritiesDomain";
import type { AuthoritiesDiscrepancy } from "./authoritiesDiscrepancy";
import { createAuthoritiesPreparation, prepareAuthoritiesCorrection } from "./authoritiesPreparation";
import { authorityPdfText } from "./authorityPdfText";

vi.mock("./authorityPdfText", () => ({ authorityPdfText: vi.fn() }));
const pdfText = vi.mocked(authorityPdfText);
const hash = "a".repeat(64), id = "d".repeat(64);
const binding = { kind: "local-file" as const, handleId: "source", lastSeen: {
  name: "Factum.docx", size: 1, modified: 0, sha256: hash,
} };
function draft(fileType: "pdf" | "docx" = "docx") {
  return createAuthoritiesDraft({ kind: "document", bindingRole: "source",
    filename: `Factum.${fileType}`, fileType, snapshot: null }, { source: binding }, "both");
}
const finding: AuthoritiesDiscrepancy = {
  id, kind: "wrong_pinpoint", actions: ["ignore", "pinpoint"], occurrenceId: "cite",
  authorityId: "case", footnoteId: 1, citation: "2020 SCC 1", proposition: "The proposition",
  authoredQuote: "the source", authoredPinpoint: { kind: "paragraph", text: "19" },
  cited: { locator: { kind: "paragraph", label: "19" }, text: "Different." },
  found: { locator: { kind: "paragraph", label: "20" }, text: "the source" },
};
const reviewer = async () => [finding];

beforeEach(() => {
  pdfText.mockReset().mockResolvedValue({ pageTextByPage: ["native"], ocrTextByPage: [""] });
});

describe("shared Authorities correction preparation", () => {
  it("records ignore without reading a source or mutating the caller's draft", async () => {
    const state = draft(), before = structuredClone(state), read = vi.fn();
    const result = await prepareAuthoritiesCorrection(state, { id, action: "ignore" }, read, reviewer);
    expect(result).toMatchObject({ kind: "ignored", draft: { discrepancyDecisions: { [id]: "ignore" } } });
    expect(read).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it.each(["missing", "decided", "unsupported"] as const)("rejects a %s decision before reading bytes", async (scenario) => {
    const state = draft(), read = vi.fn();
    if (scenario === "decided") state.discrepancyDecisions[id] = "ignore";
    await expect(prepareAuthoritiesCorrection(state,
      { id: scenario === "missing" ? "e".repeat(64) : id,
        action: scenario === "unsupported" ? "quote_exact" : "pinpoint" }, read, reviewer))
      .rejects.toMatchObject({ status: scenario === "unsupported" ? 400 : 409 });
    expect(read).not.toHaveBeenCalled();
  });

  it("requires Word and propagates the host's exact-source verification failure without accepting a decision", async () => {
    const state = draft(), read = vi.fn().mockRejectedValue(new Error("Exact source hash changed"));
    await expect(prepareAuthoritiesCorrection(draft("pdf"), { id, action: "pinpoint" }, read, reviewer))
      .rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled();
    await expect(prepareAuthoritiesCorrection(state, { id, action: "pinpoint" }, read, reviewer))
      .rejects.toThrow("Exact source hash changed");
    expect(state.discrepancyDecisions).toEqual({});
  });

  it("stops a cancelled review before reading or publishing a correction", async () => {
    const state = draft(), abort = new AbortController(), read = vi.fn();
    await expect(prepareAuthoritiesCorrection(state, { id, action: "pinpoint" }, read, async () => {
      abort.abort(new Error("Review cancelled")); return [finding];
    }, abort.signal)).rejects.toThrow("Review cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(state.discrepancyDecisions).toEqual({});
  });
});

describe("shared Authorities refresh and book attachment", () => {
  it("refreshes import data but never imports default settings, book parts, or decisions", () => {
    let state = draft();
    state = attachAuthoritiesBookPdf(state, { slot: "cover" }, binding, "Cover.pdf", hash);
    state.settings.tabLabels = ["Schedule A"];
    state.settings.passageMarking = "none";
    state.insertIntoDocument = true;
    state.cover.title = "Reviewed cover";
    state.discrepancyDecisions[id] = "pinpoint";
    const before = structuredClone(state), fresh = draft();
    fresh.import = { ...fresh.import as Extract<AuthoritiesDraft["import"], { kind: "document" }>,
      filename: "Corrected.docx" };
    fresh.bindings.source = { ...binding, handleId: "corrected" };
    fresh.outputMode = "table";
    fresh.discrepancyDecisions[id] = "ignore";
    const refreshed = updateAuthoritiesDraft(state, { type: "refresh", review: authoritiesReview(fresh) });
    expect(refreshed.import).toEqual(fresh.import);
    expect(refreshed.bindings.source).toEqual(fresh.bindings.source);
    expect(refreshed).toMatchObject({ settings: before.settings, bookParts: before.bookParts,
      discrepancyDecisions: before.discrepancyDecisions, cover: before.cover,
      outputMode: before.outputMode, insertIntoDocument: before.insertIntoDocument });
    expect(refreshed.bindings[before.bookParts.cover!.bindingRole]).toEqual(binding);
    expect(state).toEqual(before);
  });

  it.each(["cover", "index"] as const)("retains an existing %s slot's binding identity", (slot) => {
    let state = draft();
    state = updateAuthoritiesDraft(state, { type: "set-book-part", slot, binding,
      pdf: { bindingRole: "retained-slot", filename: "Old.pdf", sourceSha256: hash } });
    const changed = attachAuthoritiesBookPdf(state, { slot }, binding, "New.pdf", "b".repeat(64));
    expect(changed.bookParts[slot]).toEqual({ bindingRole: "retained-slot",
      filename: "New.pdf", sourceSha256: "b".repeat(64) });
    expect(changed.bindings[`book:${slot}:${slot}`]).toBeUndefined();
  });

  it("does not create a new supplement when a requested replacement no longer exists", () => {
    expect(() => attachAuthoritiesBookPdf(draft(), { slot: "supplemental", supplementId: "gone" },
      binding, "Supplement.pdf", hash)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

function markedDraft() {
  const state = draft();
  state.settings.passageMarking = "text";
  state.settings.scannedPdfPolicy = "page-margin";
  state.authorityOrder = ["case"];
  state.authorities.case = { id: "case", key: "case", kind: "case", citation: "2020 SCC 1",
    name: "Example", displayName: null, evidenceIds: [], excluded: false,
    locators: [{ kind: "paragraph", label: "19" }], sourceIdentity: null,
    source: { kind: "attached", sources: [{ bindingRole: "authority", filename: "Case.pdf",
      sourceSha256: hash, sourceUrl: null, origin: "manual", language: "en" }] } };
  state.bindings.authority = binding;
  return state;
}

describe("shared Authorities text preparation", () => {
  it.each(["unmarked", "table", "excluded"] as const)("does not read or OCR a %s source", async (mode) => {
    const state = markedDraft();
    if (mode === "unmarked") state.settings.passageMarking = "none";
    if (mode === "table") state.outputMode = "table";
    if (mode === "excluded") state.authorities.case.excluded = true;
    const plan = createAuthoritiesPreparation(state);
    expect(plan.authoritySources).toHaveLength(1);
    expect(await plan.prepareText("authority", { bytes: Buffer.from("pdf") })).toEqual({});
    expect(pdfText).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the existing projection with unchanged identity (Library=%s)", async (library) => {
    const state = markedDraft(), bytes = Buffer.from("exact bytes"), signal = new AbortController().signal;
    const input = { bytes, signal, ...(library ? { documentId: "doc", versionId: "version", sourceSha256: hash } : {}) };
    const result = await createAuthoritiesPreparation(state).prepareText("authority", input);
    expect(result).toEqual({ pageTextByPage: ["native"] });
    expect(pdfText).toHaveBeenCalledWith({ ...input, scannedPdfPolicy: "page-margin",
      ocrTargets: [{ id: "passage:1", locatorKind: "paragraph", locator: "19", exactQuotes: [] }],
      passageTargets: [{ id: "passage:1", locatorKind: "paragraph", locator: "19", exactQuotes: [] }] });
  });

  it("preserves explicit recognition targets without enabling passage marking", async () => {
    const state = markedDraft(); state.settings.passageMarking = "none";
    state.settings.scannedPdfPolicy = "cited-pages";
    pdfText.mockResolvedValueOnce({ pageTextByPage: ["recognized"], ocrTextByPage: ["recognized"] });
    expect(await createAuthoritiesPreparation(state).prepareText("authority", { bytes: Buffer.from("pdf") }))
      .toEqual({ pageTextByPage: ["recognized"], ocrTextByPage: ["recognized"] });
    expect(pdfText.mock.calls[0][0]).toMatchObject({ scannedPdfPolicy: "cited-pages", passageTargets: [],
      ocrTargets: [{ locatorKind: "paragraph", locator: "19" }] });
  });

  it("does not return a projection that completed after cancellation", async () => {
    const abort = new AbortController();
    pdfText.mockImplementationOnce(async () => {
      abort.abort(new Error("Preparation cancelled"));
      return { pageTextByPage: ["native"], ocrTextByPage: [] };
    });
    await expect(createAuthoritiesPreparation(markedDraft()).prepareText("authority", {
      bytes: Buffer.from("pdf"), signal: abort.signal,
    })).rejects.toThrow("Preparation cancelled");
  });
});
