import { describe, expect, it } from "vitest";
import { decodeCourtRecordDraftState } from "./courtRecordContract";

const sourceSha256 = "a".repeat(64);
const state = () => ({
  profileId: "ab-kb-affidavit-exhibits",
  cover: {},
  entries: [{
    id: "affidavit", kindId: "affidavit", title: "Affidavit",
    lastSeen: { name: "affidavit.pdf", size: 20, modified: 1, sha256: sourceSha256 },
    sourceExhibits: { sourceSha256, labels: ["A", "B", "C"] },
    sourceFields: { cover: { courtFileNumber: "2401-1", deponent: "JANE McDONALD" },
      exhibitLabels: ["A", "C"], exhibitMentions: { A: ["attached as Exhibit A"] },
      entryTitle: "Affidavit of JANE McDONALD", entryDate: "September 4, 2026" },
  }, {
    id: "exhibit-a", kindId: "exhibit", title: "Contract", exhibitLabel: "A",
    lastSeen: { name: "contract.pdf", size: 20, modified: 1, sha256: "b".repeat(64) },
  }],
  bindings: {
    affidavit: { kind: "local-file", handleId: "affidavit-file",
      lastSeen: { name: "affidavit.pdf", size: 20, modified: 1, sha256: sourceSha256 } },
    "exhibit-a": { kind: "document", documentId: "contract", version: "latest" },
  },
});

describe("Court Record draft contract", () => {
  it("keeps unassigned Library sources in the selected filing until their slots are chosen", () => {
    const pending = { profileId: "fc-motion-record-moving", cover: {}, entries: [{ id: "source",
      kindId: "unassigned", title: "Source document",
      lastSeen: { name: "source.pdf", size: 20, modified: 1 } }],
    bindings: { source: { kind: "document", documentId: "source", version: "latest" } } };
    expect(decodeCourtRecordDraftState(pending)).not.toBeNull();
    expect(decodeCourtRecordDraftState({ ...pending, profileId: "" }))
      .toBeNull();
    const prepared = { ...pending, cover: { courtFileNumber: "T-1" },
      entries: [{ ...pending.entries[0], date: "September 4, 2026",
        sourceFields: { cover: { courtFileNumber: "T-1" }, exhibitLabels: [] } }] };
    expect(decodeCourtRecordDraftState(prepared)).not.toBeNull();
    expect(decodeCourtRecordDraftState({ ...prepared,
      entries: [{ ...prepared.entries[0], kindId: "notice-motion" }] })).not.toBeNull();
    expect(decodeCourtRecordDraftState({ ...pending, bindings: { source: {
      kind: "work-product-output", workProductId: "draft-2", role: "record" } } }))
      .toBeNull();
    expect(decodeCourtRecordDraftState({ ...pending, bindings: {} })).toBeNull();
  });

  it("admits only configured saved-output role families at the structural boundary", () => {
    const nested = (kindId: string, role: string, profileId =
      "ab-kb-chambers-justice-applicant-set") => ({ profileId, cover: {}, entries: [{
      id: "nested", kindId, title: "Nested output",
      lastSeen: { name: "output.pdf", size: 20, modified: 1 },
    }], bindings: { nested: { kind: "work-product-output",
      workProductId: "draft-2", role } } });
    expect(decodeCourtRecordDraftState(nested("authorities", "book"))).not.toBeNull();
    expect(decodeCourtRecordDraftState(nested("authorities", "book-2"))).not.toBeNull();
    expect(decodeCourtRecordDraftState(nested("affidavit", "record"))).not.toBeNull();
    expect(decodeCourtRecordDraftState(nested("authorities", "book-1"))).toBeNull();
    expect(decodeCourtRecordDraftState(nested("authorities", "table"))).toBeNull();
    expect(decodeCourtRecordDraftState(nested("brief", "book"))).toBeNull();
  });

  it("accepts only hash-bound sequential source slots and unique grounded assignments", () => {
    expect(decodeCourtRecordDraftState(state())).not.toBeNull();

    const skipped = state(); skipped.entries[0].sourceExhibits.labels = ["A", "C"];
    const stale = state(); stale.entries[0].sourceExhibits.sourceSha256 = "c".repeat(64);
    const localMismatch = state();
    localMismatch.bindings.affidavit.lastSeen.sha256 = "c".repeat(64);
    const invented = state(); invented.entries[1].exhibitLabel = "D";
    const duplicate = state(); duplicate.entries.push({ ...duplicate.entries[1], id: "exhibit-b" });
    duplicate.bindings["exhibit-b"] = duplicate.bindings["exhibit-a"];
    const wrongSlot = state();
    wrongSlot.entries[1].sourceExhibits = wrongSlot.entries[0].sourceExhibits;
    delete wrongSlot.entries[0].sourceExhibits;
    const malformedSource = state();
    malformedSource.entries[0].sourceFields.cover.unknown = "invented";
    const guessedParties = state();
    Object.assign(guessedParties.entries[0].sourceFields, {
      partyStyleId: "action", partyGroups: [{ role: "Plaintiff", parties: ["IBM CANADA LTD."] }],
    });
    const extraKey = state() as ReturnType<typeof state> & { extra?: boolean };
    extraKey.extra = true;

    for (const invalid of [skipped, stale, localMismatch, invented, duplicate, wrongSlot,
      malformedSource, guessedParties,
      extraKey]) expect(decodeCourtRecordDraftState(invalid)).toBeNull();
  });

  it("keeps joint filers and unresolved AP-5 party styles explicit", () => {
    const cover = {
      partyGroups: [
        { id: "party-a", role: "Appellant", parties: [
          { id: "north", name: "North Holdings Inc." },
          { id: "south", name: "South Holdings Inc." },
        ] },
        { id: "party-b", role: "Respondent", parties: [
          { id: "river", name: "Riverstone Ltd.",
            contact: { name: "R. Counsel", address: "2 River Road" } },
        ] },
        { id: "intervener", role: "Intervener", roleBelow: "Intervener", parties: [
          { id: "justice", name: "Justice Centre",
            contact: { name: "I. Counsel", email: "i@example.test" } },
        ] },
      ],
      filingPartyIds: ["north", "south"],
    };
    const draft = { profileId: "ab-ca-appeal-record", cover, entries: [], bindings: {} };
    expect(decodeCourtRecordDraftState(draft)?.cover).toMatchObject({ partyGroups: [
      {}, { parties: [{ contact: { name: "R. Counsel", address: "2 River Road" } }] },
      { parties: [{ contact: { name: "I. Counsel", email: "i@example.test" } }] },
    ] });
    expect(decodeCourtRecordDraftState({ ...draft, cover: { ...cover,
      filingPartyIds: ["north", "north"] } })).toBeNull();
    expect(decodeCourtRecordDraftState({ ...draft, cover: { ...cover,
      filingPartyIds: ["river"] } })).toBeNull();
    expect(decodeCourtRecordDraftState({ ...draft, cover: { ...cover,
      filingPartyId: "north", filingPartyIds: undefined } })).toBeNull();
    const inventedContact = structuredClone(draft);
    Object.assign(inventedContact.cover.partyGroups[1].parties[0].contact!, { pager: "555" });
    expect(decodeCourtRecordDraftState(inventedContact)).toBeNull();
  });

  it("accepts Rule 70 counts only on a Rule 70 memorandum slot", () => {
    const memorandum = {
      profileId: "fc-application-record-applicant", cover: {},
      entries: [{ id: "memorandum", kindId: "memorandum", title: "Memorandum",
        rule70CountedPages: 30,
        lastSeen: { name: "memorandum.pdf", size: 20, modified: 1 } }],
      bindings: { memorandum: { kind: "local-file", handleId: "memorandum-file",
        lastSeen: { name: "memorandum.pdf", size: 20, modified: 1 } } },
    };
    expect(decodeCourtRecordDraftState(memorandum)).not.toBeNull();
    expect(decodeCourtRecordDraftState({ ...memorandum, entries: [{
      ...memorandum.entries[0], rule70CountedPages: 0,
    }] })).toBeNull();
    expect(decodeCourtRecordDraftState({ ...state(), entries: [{
      ...state().entries[0], rule70CountedPages: 30,
    }] })).toBeNull();
  });
});
