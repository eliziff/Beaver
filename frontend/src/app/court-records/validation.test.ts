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
  filingPartyIds: ["river"],
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

  it("covers the distinct Alberta and federal record workflows", () => {
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
    const transcript = appealRecord.documentKinds.find(({ id }) => id === "part-3-transcript")!;
    expect(transcript).toMatchObject({ separateFile: true, preserveFilename: true,
      pageLabelScheme: "abca-transcript" });
    expect(transcript.repeatable).toBeUndefined();
    expect(appealRecord.sourceIds).toContain("ab-ca-consolidated-directions");

    expect(COURT_PROFILE_BY_ID.get("fc-motion-record-responding")!.cover.title)
      .toBe("MOTION RECORD");
    for (const id of ["fc-motion-record-moving", "fc-motion-record-responding"])
      expect(COURT_PROFILE_BY_ID.get(id)!.cover.partyStyles?.map(({ id: styleId }) => styleId))
        .toEqual(["application", "action", "appeal"]);
    for (const id of ["fca-motion-record-moving", "fca-motion-record-responding"]) {
      const motion = COURT_PROFILE_BY_ID.get(id)!;
      expect(motion.cover.partyStyles?.map((partyStyle) => partyStyle.id))
        .toEqual(["appeal", "application"]);
      expect(motion.documentKinds.some((kind) => kind.id === "oral-hearing-request"))
        .toBe(true);
      expect(motion.documentKinds.find(({ id }) => id === "written-representations")?.label)
        .toBe("Written representations or memorandum");
      expect(motion.sourceIds).toContain("fca-example-written-representations");
      for (const source of ["fc-practice-guidelines-2025", "fc-efiling", "fc-sample-motion-record"])
        expect(motion.sourceIds).not.toContain(source);
    }

    const appealBook = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    expect(appealBook.cover).toMatchObject({ colourName: "grey", colourHex: "#BEC2C6" });
    expect(appealBook.documentKinds.find(({ id }) => id === "form-344"))
      .toMatchObject({ acceptedFormats: ["pdf"], generated: "federal-form-344-certificate" });
    expect(appealBook.documentKinds.at(-1)?.id).toBe("form-344");
    expect(appealBook.documentKinds.find(({ id }) => id === "other-relevant"))
      .toMatchObject({ requirement: "optional", repeatable: true });
    expect(appealBook.documentKinds.some(({ id }) => id === "other-document")).toBe(false);
    expect(appealBook.sourceIds)
      .toContain("fca-example-appeal-book-agreement");
    expect(COURT_PROFILE_BY_ID.get("fca-leave-motion-record")!.documentKinds
      .map(({ id }) => id)).not.toContain("notice-motion");
    for (const profile of COURT_PROFILES.filter((item) => item.jurisdiction === "ca" &&
      item.outputMode === "combined-record" && ["motion", "application"].includes(item.family))) {
      const proof = profile.documentKinds.find(({ id }) => id === "proof-service");
      expect(proof, profile.id).toMatchObject({ requirement: "conditional" });
      expect(proof?.separateFile, profile.id).toBeUndefined();
    }
    expect(COURT_PROFILE_BY_ID.get("fca-leave-response-set")!.documentKinds
      .find(({ id }) => id === "proof-service")).toMatchObject({ requirement: "conditional",
        acceptedFormats: ["pdf"], appendTo: "memorandum" });
    for (const id of ["fc-motion-reply", "fca-motion-reply", "fca-leave-reply"]) {
      expect(COURT_PROFILE_BY_ID.get(id)!.documentKinds
        .find(({ id: kindId }) => kindId === "proof-service"))
        .toMatchObject({ requirement: "conditional", acceptedFormats: ["pdf"],
          appendTo: "written-reply" });
    }
    for (const profile of COURT_PROFILES.filter((item) => item.courtAbbreviation === "FCA" &&
      item.outputMode === "combined-record")) {
      expect(profile.technical.volumeInstructions, profile.id).toBeTruthy();
      expect(profile.technical.completeIndexEachVolume, profile.id).toBe(true);
      expect(profile.technical.volumeLabelOnBackCover, profile.id).toBe(true);
    }

    for (const court of ["fc", "fca"]) {
      const applicant = COURT_PROFILE_BY_ID.get(`${court}-application-record-applicant`)!;
      const respondent = COURT_PROFILE_BY_ID.get(`${court}-application-record-respondent`)!;
      expect(applicant.documentKinds.find(({ id }) => id === "applicant-cross-exam")?.label)
        .toBe("Cross-examinations conducted by applicant");
      expect(respondent.documentKinds.filter(({ id }) =>
        ["supporting-affidavit", "respondent-cross-exam"].includes(id)).map(({ label }) => label))
        .toEqual(["Respondent affidavit and exhibits", "Cross-examinations conducted by respondent"]);
      for (const profile of [applicant, respondent]) {
        expect(sortedEntries(profile, [entry("tribunal", "tribunal-material"),
          entry("oral", "oral-evidence")]).map(({ id }) => id)).toEqual(["tribunal", "oral"]);
      }
    }

    const rule70Memoranda = COURT_PROFILES.flatMap((profile) => profile.documentKinds
      .filter(({ rule70PageLimit }) => rule70PageLimit)
      .map((kind) => `${profile.id}:${kind.id}:${kind.rule70PageLimit}`));
    expect(rule70Memoranda).toEqual([
      "fc-application-record-applicant:memorandum:standard",
      "fca-application-record-applicant:memorandum:standard",
      "fc-application-record-respondent:memorandum:standard",
      "fca-application-record-respondent:memorandum:standard",
      "fca-leave-motion-record:memorandum:standard",
      "fca-leave-response-set:memorandum:standard",
    ]);

    for (const profile of COURT_PROFILES.filter((item) => item.id.startsWith("ab-ca-extracts-"))) {
      expect(profile.technical.maxOutputPages, profile.id).toBe(200);
      expect(profile.sourceIds, profile.id).toContain("ab-ca-extracts-requirements");
      expect(profile.cover.ruleReference, profile.id).toBe("Rules 14.29(c) and 14.87");
    }
  });

  it("collects only values emitted by separate filing sets and prescribed covers", () => {
    for (const profile of COURT_PROFILES.filter((item) => item.outputMode === "separate-files")) {
      expect(profile.cover.fields, profile.id).toEqual([]);
      expect(profile.cover.partyStyles, profile.id).toBeUndefined();
    }
    const commercialFileNumber = COURT_PROFILE_BY_ID.get(
      "ab-kb-commercial-compendium")!.cover.fields;
    expect(commercialFileNumber).toEqual([
      expect.objectContaining({ id: "courtFileNumber", required: true }),
    ]);
    expect(commercialFileNumber[0]).not.toHaveProperty("placeholder");
    const federalFileNumbers = COURT_PROFILES.filter(({ courtId }) =>
      courtId === "fc" || courtId === "fca").flatMap(({ cover }) =>
      cover.fields.filter(({ id }) => id === "courtFileNumber"));
    expect(federalFileNumbers.length).toBeGreaterThan(0);
    for (const field of federalFileNumbers) expect(field).not.toHaveProperty("placeholder");
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

  it("distinguishes Applications Judge Digital Orders from Justice Word orders", () => {
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
      expect(profile.documentKinds.some(({ generated }) => generated)).toBe(false);
    }
    for (const id of ["ab-kb-chambers-justice-applicant-set",
      "ab-kb-chambers-justice-respondent-set", "ab-kb-desk-justice-application-set",
      "ab-kb-special-application-applicant-set", "ab-kb-special-application-respondent-set",
      "ab-kb-review-appeal-applicant-set", "ab-kb-review-appeal-respondent-set",
      "ab-kb-commercial-applicant-set", "ab-kb-commercial-respondent-set"]) {
      const profile = COURT_PROFILE_BY_ID.get(id)!;
      expect(profile.documentKinds.find(({ id: kindId }) => kindId === "proposed-order"))
        .toMatchObject({ acceptedFormats: ["docx"] });
    }
    for (const id of ["ab-kb-review-appeal-applicant-set",
      "ab-kb-commercial-applicant-set"]) {
      expect(COURT_PROFILE_BY_ID.get(id)!.documentKinds.find(({ id: kindId }) =>
        kindId === "proposed-order")?.requirement).toBe("conditional");
    }
  });
});

describe("court record validation", () => {
  it("accepts only the prescribed page-label sequence for the combined ABCA transcript", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const transcript = entry("transcript", "part-3-transcript", {
      file: testFile("EVK26DOEJ.pdf"), pageCount: 8,
    });
    const pageLabelBlockers = (pageLabels?: string[] | null) => validateCourtRecord({
      profile, cover, entries: [{ ...transcript, pageLabels }],
    }).blockers.filter(({ id }) => id.startsWith("page-labels-"));

    expect(pageLabelBlockers()).toHaveLength(1);
    expect(pageLabelBlockers(["", "i", "ii", "1", "2", "", "i", "1"]))
      .toHaveLength(0);
    expect(pageLabelBlockers(["", "i", "ii", "1", "3", "", "i", "1"]))
      .toHaveLength(1);
    expect(validateCourtRecord({ profile, cover, entries: [
      entry("pleading", "part-1-pleading", { date: "May 1, 2026" }),
    ] }).blockers.some(({ id }) => id.startsWith("page-labels-"))).toBe(false);
  });

  it("requires the contact information prescribed by the AP-5 cover", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!;
    const ap5Cover: CoverValues = {
      courtFileNumber: "2401-1", lowerCourtFileNumber: "2201-1", registry: "Edmonton",
      partyStyleId: "action-plaintiff", partyGroups: [
        { id: "party-a", role: "Appellant", roleBelow: "Plaintiff",
          parties: [{ id: "appellant", name: "Ada North" }] },
        { id: "party-b", role: "Respondent", roleBelow: "Defendant",
          parties: [{ id: "respondent", name: "River South" }] },
      ], filingPartyIds: ["appellant"], decisionMaker: "Justice Jones",
      decisionDate: "May 1, 2026", decisionFileDate: "May 2, 2026",
      counselName: "A. Lawyer", counselAddress: "1 Main Street", counselPhone: "555-0100",
    };
    const entries = [entry("extract", "transcript-extract")];

    expect(validateCourtRecord({ profile, entries, cover: ap5Cover }).blockers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "cover-counselFax", fieldId: "counselFax" }),
        expect.objectContaining({ id: "contact-respondent", fieldId: "partyContacts" }),
      ]));
    ap5Cover.counselFax = "N/A";
    ap5Cover.partyGroups![1].parties[0].contact = {
      name: "R. Counsel", address: "2 River Road", phone: "555-0200",
    };
    expect(validateCourtRecord({ profile, entries, cover: ap5Cover }).ready).toBe(true);
  });

  it("applies Rule 70 to Parts I–IV, not the whole memorandum PDF", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const notice = entry("notice", "notice-application", { date: "May 1, 2026" });
    const memorandum = entry("memorandum", "memorandum", {
      date: "May 2, 2026", pageCount: 45,
    });
    const validate = (patch: Partial<RecordEntry> = {}) => validateCourtRecord({ profile, cover,
      entries: [notice, { ...memorandum, ...patch }] });

    expect(validate().blockers).toContainEqual(expect.objectContaining({
      id: "rule70-pages-memorandum", title: "Enter the Parts I–IV page count",
    }));
    expect(validate({ rule70CountedPages: 30 }).blockers
      .some(({ id }) => id === "rule70-pages-memorandum")).toBe(false);
    expect(validate({ rule70CountedPages: 31 }).blockers).toContainEqual(expect.objectContaining({
      id: "rule70-pages-memorandum", title: "Parts I–IV exceed 30 pages",
    }));
    expect(validate({ rule70CountedPages: 46 }).blockers).toContainEqual(expect.objectContaining({
      id: "rule70-pages-memorandum", title: "Enter the Parts I–IV page count",
    }));
  });

  it("supports Rule 70's 60-page combined respondent/cross-appeal contract", () => {
    const source = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const profile = { ...source, documentKinds: source.documentKinds.map((kind) => kind.id ===
      "memorandum" ? { ...kind, rule70PageLimit: "combined-cross-appeal" as const } : kind) };
    const notice = entry("notice", "notice-application", { date: "May 1, 2026" });
    const memorandum = entry("memorandum", "memorandum", {
      date: "May 2, 2026", pageCount: 70,
    });
    const validate = (rule70CountedPages: number) => validateCourtRecord({ profile, cover,
      entries: [notice, { ...memorandum, rule70CountedPages }] });

    expect(validate(60).blockers.some(({ id }) => id === "rule70-pages-memorandum")).toBe(false);
    expect(validate(61).blockers).toContainEqual(expect.objectContaining({
      id: "rule70-pages-memorandum", title: "Parts I–IV exceed 60 pages",
    }));
  });

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

  it("rejects a same-name, same-size device file whose verified content changed", () => {
    const file = testFile("affidavit.pdf", 1000), previous = "a".repeat(64);
    const current = entry("affidavit", "affidavit", { file, origin: { kind: "device" },
      binding: { kind: "local-file", handleId: "affidavit", lastSeen: {
        name: file.name, size: file.size, modified: 2, sha256: "b".repeat(64),
      } } });
    const receipt = { sources: [{ entryId: current.id, filename: file.name,
      byteCount: file.size, sha256: previous, origin: { kind: "device" } }] } as CourtRecordReceipt;

    expect(staleBuildSource(receipt, [current])).toMatchObject({ entryId: "affidavit" });
  });

  it("applies Alberta King’s Bench size limits per separate file", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!;
    const entries = [
      entry("application", "application", { file: testFile("application.pdf", 60 * 1024 * 1024) }),
      entry("affidavit", "affidavit", { file: testFile("affidavit.pdf", 60 * 1024 * 1024) }),
      entry("order", "proposed-order", {
        file: testDocx(), pageCount: null, searchable: null, encrypted: null,
      }),
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
    expect(validateCourtRecord({ profile, entries: [entry("application", "application"),
      entry("order", "proposed-order")], cover: {} }).blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "format-order" })]));
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

  it("blocks an unreadable PDF even when the court files documents separately", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!;
    const unreadable = entry("application", "application", {
      pageCount: null, searchable: null, encrypted: null,
      inspectionError: "The PDF is damaged.",
    });
    expect(validateCourtRecord({ profile, cover: {}, entries: [unreadable] }).blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: "inspection-application", level: "blocker",
      })]));
  });

  it("accepts a textless page only after OCR and explicit non-text confirmation", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const documents = [entry("motion", "notice-motion"),
      entry("argument", "written-representations")];
    const scanned = { ...documents[0], searchable: false, textlessPageCount: 1,
      textlessPages: [1], ocrAttemptedPages: [1] };

    expect(validateCourtRecord({ profile, cover, entries: [scanned, documents[1]] }).blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: "searchability-motion", title: "Confirm non-text pages",
      })]));
    expect(validateCourtRecord({ profile, cover, entries: [
      { ...scanned, nonTextPagesConfirmed: true }, documents[1],
    ] }).ready).toBe(true);
  });

  it("counts only exhibit certificates the builder will actually insert", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-affidavit-exhibits")!;
    const affidavit = entry("affidavit", "affidavit");
    const certified = entry("exhibit", "exhibit", { exhibitLabel: "A",
      sourceFields: { cover: {}, exhibitLabels: [], explicitExhibitLabel: "A" } });
    const raw = { ...certified, sourceFields: undefined };

    expect(validateCourtRecord({ profile, entries: [affidavit, certified], cover }).pageCount)
      .toBe(4);
    expect(validateCourtRecord({ profile, entries: [affidavit, raw], cover }).pageCount)
      .toBe(5);
  });

  it("counts an uploaded Form 344 instead of the generated fallback", () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    const required = profile.documentKinds.filter((kind) =>
      kind.requirement === "required" && !kind.generated)
      .map((kind) => entry(kind.id, kind.id));
    const generated = validateCourtRecord({ profile, entries: required, cover }).pageCount!;
    const signed = validateCourtRecord({ profile,
      entries: [...required, entry("signed", "form-344", { pageCount: 3 })], cover }).pageCount!;

    expect(signed).toBe(generated + 2);
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
    expect(outputFilename(applicant, { ...cover, filingPartyIds: ["river"] }))
      .toContain("River-Society");
    const respondent = COURT_PROFILE_BY_ID.get("fc-application-record-respondent")!;
    expect(outputFilename(respondent, { ...cover, filingPartyIds: ["canada"] }))
      .toContain("Canada");
  });

  it("routes an oversized FCA combined record through the shared volume builder", () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-motion-record-moving")!;
    const report = validateCourtRecord({
      profile,
      cover,
      entries: [
        entry("notice", "notice-motion", { file: testFile("notice.pdf", 55 * 1024 * 1024) }),
        entry("argument", "written-representations", { file: testFile("argument.pdf", 55 * 1024 * 1024) }),
      ],
    });
    expect(report.blockers.some((item) => item.id === "output-size")).toBe(false);
    expect(report.review.some((item) => item.id === "output-size-split")).toBe(true);
  });

  it("blocks an oversized Federal affidavit instead of promising unsupported volume output", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-affidavit-exhibits")!;
    expect(profile.technical.volumeInstructions).toBeUndefined();
    const report = validateCourtRecord({ profile,
      cover: { ...cover, deponent: "Ada Applicant", swornDate: "September 4, 2026" },
      entries: [entry("affidavit", "affidavit", {
        file: testFile("affidavit.pdf", 110 * 1024 * 1024),
      })],
    });
    expect(report.blockers.some((item) => item.id === "output-size")).toBe(true);
    expect(report.review.some((item) => item.id === "output-size-split")).toBe(false);
  });

  it("blocks evidence in an Alberta appeal record and automatically sorts allowed parts", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const entries = [
      entry("notice", "part-2-notice"),
      entry("later-pleading", "part-1-pleading", { date: "June 2, 2026" }),
      entry("earlier-pleading", "part-1-pleading", { date: "May 1, 2026" }),
      entry("reasons", "part-2-reasons"),
      entry("order", "part-2-order"),
      entry("evidence", "evidence"),
    ];
    const report = validateCourtRecord({ profile, entries, cover });
    expect(report.blockers.some((item) => item.id === "forbidden-evidence")).toBe(true);
    expect(sortedEntries(profile, entries).map((item) => item.id).slice(0, 5)).toEqual([
      "earlier-pleading", "later-pleading", "reasons", "order", "notice",
    ]);
  });

  it("requires parseable dates for chronological Alberta appeal pleadings", () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const report = validateCourtRecord({ profile, cover, entries: [
      entry("missing", "part-1-pleading"),
      entry("invalid", "part-1-pleading", { date: "not a date" }),
    ] });

    expect(profile.documentKinds.find(({ id }) => id === "part-1-pleading")?.chronological)
      .toBe(true);
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "date-missing", title: "Document date is required" }),
      expect.objectContaining({ id: "date-invalid", title: "Use a valid document date" }),
    ]));
  });
});
