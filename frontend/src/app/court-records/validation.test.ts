import { describe, expect, it } from "vitest";
import sourceReceipts from "../../../../docs/decisions/court-output-preset-receipts.json";
import { COURT_PROFILES, COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtRecordReceipt, CoverValues, RecordEntry } from "./types";
import { outputFilename, sortedEntries, staleBuildSource, validateCourtRecord } from "./validation";

function testFile(name: string, size = 1000) {
  const file = new File(["%PDF-1.7"], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function testDocx(name = "order.docx") {
  return new File(["editable order"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function entry(id: string, kindId: string, extra: Partial<RecordEntry> = {}): RecordEntry {
  return {
    id,
    kindId,
    file: testFile(`${id}.pdf`),
    title: id,
    pageCount: 2,
    searchable: true,
    encrypted: false,
    ...extra,
  };
}

const cover: CoverValues = {
  courtFileNumber: "T-1-26",
  lowerCourtFileNumber: "2201-1",
  registry: "Vancouver",
  partyStyleId: "application",
  partyGroups: [
    { id: "party-a", role: "Applicant", parties: [{ id: "river", name: "River Society" }] },
    { id: "party-b", role: "Respondent", parties: [{ id: "canada", name: "Canada" }] },
  ],
  filingPartyId: "river",
  counselName: "A. Lawyer",
  counselAddress: "1 Main Street",
  counselPhone: "555-0100",
  counselEmail: "lawyer@example.test",
  applicationUnder: "Federal Courts Act, section 18.1",
  recordSubtitle: "Constitutional question",
};

describe("court record profiles", () => {
  it("has unique ids and only references receipted official sources", () => {
    const receipts = new Map(sourceReceipts.sources.map((source) => [source.id, source]));
    expect(new Set(COURT_PROFILES.map((profile) => profile.id)).size).toBe(COURT_PROFILES.length);
    expect(new Set(COURT_PROFILES.map((profile) => profile.jurisdiction)))
      .toEqual(new Set(["general", "ab", "ca"]));
    for (const profile of COURT_PROFILES) {
      expect(profile).toMatchObject({ courtId: expect.any(String), language: "en",
        documentFamily: expect.any(String), documentLabel: expect.any(String),
        variant: expect.any(String) });
      if (profile.jurisdiction === "general") expect(profile.sourceIds).toEqual([]);
      else expect(profile.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of profile.sourceIds) {
        const receipt = receipts.get(sourceId);
        expect(receipt, `${profile.id} references missing source ${sourceId}`).toBeDefined();
        expect(receipt?.profiles, `${sourceId} does not support ${profile.id}`)
          .toContain(profile.id);
      }
    }
  });

  it("covers the distinct Alberta King’s Bench and Federal Court of Appeal record workflows", () => {
    expect([...COURT_PROFILE_BY_ID.keys()]).toEqual(expect.arrayContaining([
      "ab-kb-chambers-justice-applicant-set",
      "ab-kb-chambers-justice-respondent-set",
      "ab-kb-chambers-applications-judge-applicant-set",
      "ab-kb-chambers-applications-judge-respondent-set",
      "ab-kb-desk-justice-application-set",
      "ab-kb-desk-applications-judge-application-set",
      "ab-kb-special-application-applicant-set",
      "ab-kb-special-application-respondent-set",
      "ab-kb-review-appeal-applicant-set",
      "ab-kb-review-appeal-respondent-set",
      "ab-kb-commercial-applicant-set",
      "ab-kb-commercial-respondent-set",
      "ab-kb-commercial-compendium",
      "fca-motion-record-moving",
      "fca-motion-record-responding",
      "fca-application-record-applicant",
      "fca-application-record-respondent",
      "fca-leave-motion-record",
      "fca-leave-response-set",
      "fca-informal-motion-letter",
      "fca-appeal-book",
      "fca-condensed-book",
      "fca-compendium",
      "fc-trial-record",
    ]));
  });

  it("encodes the court-specific parts, covers and proceeding styles", () => {
    const appealRecord = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    expect(appealRecord.documentKinds.map((kind) => kind.id)).toEqual(expect.arrayContaining([
      "part-3-transcript", "part-3-no-oral-record",
    ]));
    expect(appealRecord.sourceIds).toContain("ab-ca-consolidated-directions");

    expect(COURT_PROFILE_BY_ID.get("fc-motion-record-responding")!.cover.title)
      .toBe("MOTION RECORD");
    for (const id of ["fca-motion-record-moving", "fca-motion-record-responding"]) {
      const motion = COURT_PROFILE_BY_ID.get(id)!;
      expect(motion.cover.partyStyles?.map((partyStyle) => partyStyle.id))
        .toEqual(["appeal", "application"]);
      expect(motion.documentKinds.some((kind) => kind.id === "oral-hearing-request"))
        .toBe(true);
      expect(motion.sourceIds).toContain("fca-example-written-representations");
      for (const source of ["fc-practice-guidelines-2025", "fc-efiling", "fc-sample-motion-record"])
        expect(motion.sourceIds).not.toContain(source);
    }

    const appealBook = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    expect(appealBook.cover).toMatchObject({ colourName: "grey", colourHex: "#BEC2C6" });
    expect(appealBook.sourceIds).toContain("fca-example-appeal-book-agreement");
    expect(COURT_PROFILE_BY_ID.get("fca-leave-motion-record")!.documentKinds
      .find((kind) => kind.id === "notice-motion")?.requirement).toBe("required");
    for (const profile of COURT_PROFILES.filter((item) => item.courtAbbreviation === "FCA"))
      expect(profile.technical.volumeInstructions, profile.id).toBeUndefined();
  });

  it("collects only values emitted by separate filing sets and prescribed covers", () => {
    for (const profile of COURT_PROFILES.filter((item) => item.outputMode === "separate-files")) {
      expect(profile.cover.fields, profile.id).toEqual([]);
      expect(profile.cover.partyStyles, profile.id).toBeUndefined();
    }
    expect(COURT_PROFILE_BY_ID.get("ab-kb-commercial-compendium")!.cover.fields
      .map(({ id }) => id)).toEqual(["courtFileNumber"]);
    for (const profile of COURT_PROFILES.filter((item) => item.courtId === "ab-ca")) {
      expect(profile.cover.fields.some(({ id }) => id === "restrictions"), profile.id).toBe(false);
    }
    expect(COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!.cover.fields
      .filter(({ required }) => required).map(({ id }) => id)).toEqual(["courtFileNumber"]);
  });

  it("limits the 2026 Filing Digital Service receipt to civil chambers sets", () => {
    const fdsProfiles = COURT_PROFILES
      .filter((profile) => profile.sourceIds.includes("ab-kb-fds-2026"))
      .map((profile) => profile.id);
    expect(fdsProfiles).toEqual([
      "ab-kb-chambers-applications-judge-applicant-set",
      "ab-kb-chambers-applications-judge-respondent-set",
    ]);
  });

  it("distinguishes Applications Judge Digital Orders from Justice PDF orders", () => {
    const applicationsJudge = COURT_PROFILES.filter((profile) =>
      profile.sourceIds.includes("ab-kb-digital-orders-2026"));
    expect(applicationsJudge.map(({ id }) => id)).toEqual([
      "ab-kb-chambers-applications-judge-applicant-set",
      "ab-kb-chambers-applications-judge-respondent-set",
      "ab-kb-desk-applications-judge-application-set",
    ]);
    for (const profile of applicationsJudge) {
      expect(profile).toMatchObject({ division: "applications-judge",
        effective: { from: "2026-09-15" } });
      expect(profile.variant).toContain("digital-order");
      expect(profile.documentKinds.find(({ id }) => id === "proposed-order")?.requirement)
        .toBe("forbidden");
    }
    for (const id of ["ab-kb-chambers-justice-applicant-set",
      "ab-kb-chambers-justice-respondent-set", "ab-kb-desk-justice-application-set"]) {
      const profile = COURT_PROFILE_BY_ID.get(id)!;
      expect(profile.division).toBe("justice");
      expect(profile.documentKinds.find(({ id: kindId }) => kindId === "proposed-order"))
        .toMatchObject({ acceptedFormats: ["pdf", "docx"] });
    }
  });
});

describe("court record validation", () => {
  it("blocks an unavailable nested draft and rejects its prior built source", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-commercial-respondent-set")!;
    const nested = entry("authorities", "authorities", {
      inputStatus: "missing",
      binding: { kind: "work-product-output", workProductId: "child", role: "book" },
      origin: { kind: "library", documentId: "book", versionId: "version-2",
        sourceSha256: "b".repeat(64) },
    });
    const report = validateCourtRecord({ profile, entries: [nested], cover });
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "missing-file-authorities", title: "Rebuild the source draft",
      entryId: "authorities",
    }));
    const receipt = { sources: [{ entryId: nested.id, filename: nested.file.name,
      byteCount: nested.file.size, sha256: "a".repeat(64),
      origin: { kind: "library", documentId: "book", versionId: "version-1",
        sourceSha256: "a".repeat(64) } }] } as CourtRecordReceipt;
    expect(staleBuildSource(receipt, [{ ...nested, inputStatus: "ready" }]))
      .toMatchObject({ entryId: "authorities" });
  });

  it("applies Alberta King’s Bench size limits per separate file", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!;
    const entries = [
      entry("application", "application", { file: testFile("application.pdf", 60 * 1024 * 1024) }),
      entry("affidavit", "affidavit", { file: testFile("affidavit.pdf", 60 * 1024 * 1024) }),
      entry("order", "proposed-order"),
    ];
    const report = validateCourtRecord({
      profile,
      entries,
      cover: {},
    });
    expect(report.blockers.some((item) => item.id === "output-size")).toBe(false);
    expect(report.ready).toBe(true);
  });

  it("accepts Word in every slot once combined-record sources have a PDF rendition", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!;
    const order = entry("order", "proposed-order", {
      file: testDocx(), pageCount: null, searchable: null, encrypted: null,
    });
    const ready = validateCourtRecord({
      profile,
      entries: [entry("application", "application"), order],
      cover: { ...cover, courtFileNumber: "2401-1" },
    });
    expect(ready.ready).toBe(true);
    const combined = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const wordMotion = entry("motion", "notice-motion", {
      file: testDocx("motion.docx"), pdfRendition: testFile("motion.pdf"),
      pageCount: 2, searchable: true, encrypted: false,
    });
    const converted = validateCourtRecord({
      profile: combined,
      entries: [wordMotion, entry("argument", "written-representations")],
      cover,
    });
    expect(converted.ready).toBe(true);
    const incomplete = validateCourtRecord({
      profile: combined,
      entries: [{ ...wordMotion, pdfRendition: undefined },
        entry("argument", "written-representations")],
      cover,
    });
    expect(incomplete.blockers.some((item) => item.id === "rendition-motion")).toBe(true);
  });

  it("requires document dates only for Rules 309 and 310 application records", () => {
    const application = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const applicationEntries = [
      entry("notice", "notice-application"),
      entry("memorandum", "memorandum"),
    ];
    const missing = validateCourtRecord({ profile: application, entries: applicationEntries, cover });
    expect(missing.blockers.filter((item) => item.id.startsWith("date-")).map((item) => item.entryId))
      .toEqual(["notice", "memorandum"]);
    expect(validateCourtRecord({
      profile: application,
      entries: applicationEntries.map((item) => ({ ...item, date: "May 31, 2023" })),
      cover,
    }).ready).toBe(true);

    const motion = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    expect(validateCourtRecord({
      profile: motion,
      entries: [entry("notice", "notice-motion"), entry("argument", "written-representations")],
      cover,
    }).blockers.some((item) => item.id.startsWith("date-"))).toBe(false);
  });

  it("accepts a physical-exhibit description without a file or invented date", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const physical = entry("physical", "physical-exhibit", {
      file: new File([], "description-only"),
      title: "Original scale model in the Registry's custody",
      pageCount: 0,
      searchable: null,
      encrypted: null,
      descriptionOnly: true,
    });
    const report = validateCourtRecord({
      profile,
      cover,
      entries: [
        entry("notice", "notice-application", { date: "May 1, 2026" }),
        physical,
        entry("memorandum", "memorandum", { date: "May 2, 2026" }),
      ],
    });
    expect(report.blockers.filter((item) => item.entryId === physical.id)).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("keeps role-specific records bound to the prescribed filing side", () => {
    const applicant = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    expect(outputFilename(applicant, { ...cover, filingPartyId: "canada" }))
      .toContain("River-Society");
    const respondent = COURT_PROFILE_BY_ID.get("fc-application-record-respondent")!;
    expect(outputFilename(respondent, { ...cover, filingPartyId: "river" }))
      .toContain("Canada");
  });

  it("directs an oversized FCA record to the Registry instead of inventing volumes", () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-motion-record-moving")!;
    const report = validateCourtRecord({
      profile,
      cover,
      entries: [
        entry("notice", "notice-motion", { file: testFile("notice.pdf", 55 * 1024 * 1024) }),
        entry("argument", "written-representations", { file: testFile("argument.pdf", 55 * 1024 * 1024) }),
      ],
    });
    expect(report.blockers.some((item) => item.id === "output-size")).toBe(true);
    expect(report.review.some((item) => item.id === "output-size-split")).toBe(false);
  });

  it("blocks evidence in an Alberta appeal record and automatically sorts allowed parts", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const entries = [
      entry("notice", "part-2-notice"),
      entry("pleading", "part-1-pleading"),
      entry("reasons", "part-2-reasons"),
      entry("order", "part-2-order"),
      entry("evidence", "evidence"),
    ];
    const report = validateCourtRecord({ profile, entries, cover });
    expect(report.blockers.some((item) => item.id === "forbidden-evidence")).toBe(true);
    expect(sortedEntries(profile, entries).map((item) => item.id).slice(0, 4)).toEqual([
      "pleading", "reasons", "order", "notice",
    ]);
  });
});
