// @vitest-environment jsdom

import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildCourtRecord } from "./assembly";
import { COURT_PROFILES, COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtProfile, CoverValues, RecordEntry } from "./types";

async function sourcePdf(name: string, pages = 1, rotation = 0) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([612, 792]);
    if (rotation) page.setRotation({ angle: rotation, type: "degrees" });
    page.drawText(`${name} page ${index + 1}`, { x: 72, y: 700, font, size: 12 });
  }
  return new File([await document.save()], `${name}.pdf`, { type: "application/pdf" });
}

async function entry(id: string, kindId: string, pages = 1): Promise<RecordEntry> {
  return {
    id,
    kindId,
    file: await sourcePdf(id, pages),
    title: id,
    pageCount: pages,
    searchable: true,
    encrypted: false,
  };
}

const cover: CoverValues = {
  courtFileNumber: "S-12345",
  registry: "Vancouver",
  partyStyleId: "application",
  partyGroups: [
    { id: "party-a", role: "Applicant", parties: [
      { id: "ada", name: "Ada Applicant" },
      { id: "acme", name: "Acme Holdings" },
    ] },
    { id: "party-b", role: "Respondent", parties: [{ id: "riley", name: "Riley Respondent" }] },
    { id: "intervener", role: "Intervener", parties: [{ id: "justice", name: "Justice Centre" }] },
  ],
  filingPartyId: "ada",
  counselName: "A. Lawyer",
  counselAddress: "1 Court Street, Edmonton, AB",
  counselPhone: "604-555-0100",
  counselEmail: "lawyer@example.test",
  applicationUnder: "Federal Courts Act, section 18.1",
  recordSubtitle: "Constitutional question",
};

function profileCover(profile: CourtProfile): CoverValues {
  const style = profile.cover.partyStyles?.[0];
  const partyGroups = style?.groups.map((group, groupIndex) => ({
    id: group.id,
    role: group.role,
    roleBelow: group.roleBelow,
    parties: Array.from({ length: groupIndex ? 1 : 2 }, (_value, partyIndex) => ({
      id: `${group.id}-${partyIndex + 1}`,
      name: `${group.role} ${partyIndex + 1}`,
    })),
  }));
  const filingGroup = partyGroups?.find((group) => group.id === profile.cover.filingGroupId) ??
    partyGroups?.[0];
  return {
    ...cover,
    courtName: profile.court,
    lowerCourtFileNumber: "2401-00001",
    decisionMaker: "The Honourable Justice Example",
    decisionDate: "May 31, 2023",
    decisionFileDate: "June 2, 2023",
    recordTitle: profile.cover.title,
    affidavitNumber: "1",
    deponent: "Ada Applicant",
    swornDate: "August 29, 2026",
    swornPlace: "Edmonton, Alberta",
    partyStyleId: style?.id,
    partyGroups,
    filingPartyId: filingGroup?.parties[0]?.id,
  };
}

async function pdfText(bytes: Uint8Array, pageNumber = 1) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes }).promise;
  const content = await (await document.getPage(pageNumber)).getTextContent();
  return content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ");
}

async function firstPageFill(bytes: Uint8Array) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes }).promise;
  const operators = await (await document.getPage(1)).getOperatorList();
  const index = operators.fnArray.indexOf(OPS.setFillRGBColor);
  return index < 0 ? [] : Array.from(operators.argsArray[index] as Uint8Array);
}

async function profileEntries(profile: CourtProfile) {
  const required = profile.documentKinds.filter((kind) =>
    kind.requirement === "required" && !kind.generated);
  const kinds = required.length ? required : profile.documentKinds.filter((kind) =>
    kind.requirement !== "forbidden" && !kind.generated).slice(0, 1);
  return Promise.all(kinds.map(async (kind, index) => ({
    ...await entry(`${profile.id}-${index + 1}`, kind.id),
    ...(profile.technical.indexDate === "required" ? { date: "May 31, 2023" } : {}),
  })));
}

describe("court record assembly", () => {
  it("generates a linked, bookmarked, continuously labelled Federal motion record", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const result = await buildCourtRecord({
      profile,
      cover,
      preparationDate: "2026-08-29",
      entries: [
        await entry("notice", "notice-motion", 2),
        await entry("argument", "written-representations"),
      ],
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    const output = await PDFDocument.load(artifact.bytes);
    expect(output.getPageCount()).toBe(5);
    expect(output.catalog.get(PDFName.of("Outlines"))).toBeTruthy();
    expect(output.catalog.get(PDFName.of("PageLabels"))).toBeTruthy();
    expect(output.catalog.get(PDFName.of("PageMode"))?.toString()).toBe("/UseOutlines");
    const annots = output.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(2);
    const labels = output.context.lookup(
      output.catalog.get(PDFName.of("PageLabels")), PDFDict,
    ).lookup(PDFName.of("Nums"), PDFArray);
    expect(labels.size()).toBe(2);
    expect(result.receipt.outputs[0]).toMatchObject({
      filename: artifact.filename,
      page_count: 5,
      sha256: artifact.sha256,
    });
    expect(result.receipt.automatic_steps).toContain(
      "Linked each generated table-of-contents row to its document",
    );
    const coverText = await pdfText(artifact.bytes);
    expect(coverText).toContain("Ada Applicant");
    expect(coverText).toContain("Acme Holdings");
    expect(coverText).toContain("Riley Respondent");
    expect(coverText).toContain("Justice Centre");
    expect(coverText).toContain("APPLICATION UNDER Federal Courts Act, section 18.1");
  });

  it("lists an unreproducible physical exhibit without inventing a source page", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const physical: RecordEntry = {
      id: "physical",
      kindId: "physical-exhibit",
      file: new File([], "description-only"),
      title: "Original scale model in the Registry's custody",
      pageCount: 0,
      searchable: null,
      encrypted: null,
      descriptionOnly: true,
    };
    const result = await buildCourtRecord({
      profile,
      cover,
      preparationDate: "2026-08-29",
      entries: [
        { ...await entry("notice", "notice-application"), date: "May 1, 2026" },
        physical,
        { ...await entry("memorandum", "memorandum"), date: "May 2, 2026" },
      ],
    });
    const artifact = result.artifacts[0];
    const output = await PDFDocument.load(artifact.bytes);
    expect(output.getPageCount()).toBe(4);
    expect(await pdfText(artifact.bytes, 2)).toContain(physical.title);
    expect(output.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(2);
    expect(result.receipt.sources.map((source) => source.entryId)).toEqual(["notice", "memorandum"]);
  });

  it("assembles a Word source from its prepared PDF while receipting the original", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const original = new File(["word source"], "motion.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const motion: RecordEntry = {
      ...await entry("motion", "notice-motion"),
      file: original,
      pdfRendition: await sourcePdf("converted motion"),
    };
    const result = await buildCourtRecord({
      profile,
      cover,
      preparationDate: "2026-08-29",
      entries: [motion, await entry("argument", "written-representations")],
    });
    const artifact = result.artifacts[0];
    expect(await pdfText(artifact.bytes, 3)).toContain("converted motion page 1");
    expect(result.receipt.sources[0]).toMatchObject({
      filename: "motion.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  it("inserts an exhibit certificate and generates an auditable receipt", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-affidavit-exhibits")!;
    const affidavit = await entry("affidavit", "affidavit");
    const exhibit = { ...await entry("contract", "exhibit", 2), exhibitLabel: "A" };
    const result = await buildCourtRecord({
      profile,
      cover: { ...cover, deponent: "Ada Applicant", swornDate: "August 29, 2026" },
      preparationDate: "2026-08-29",
      entries: [affidavit, exhibit],
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    const output = await PDFDocument.load(artifact.bytes);
    expect(output.getPageCount()).toBe(4);
    expect(result.receipt.automatic_steps).toContain(
      "Inserted an exhibit certificate before each exhibit",
    );
    expect(result.receipt.schema_version).toBe("beaver.court-record-receipt.v2");
    expect(result.receipt.profile).toMatchObject({ jurisdiction: "ca", court_id: "fc",
      language: "en", document_family: "affidavit-with-exhibits",
      variant: "standard" });
    expect(result.receipt.profile.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.sources.map(({ order }) => order)).toEqual([0, 1]);
    expect(result.receipt.outputs[0].role).toBe("record");
    expect(result.receipt.profile.source_ids).toContain("fc-rules");
    expect(result.artifacts.some((item) => item.mimeType === "text/markdown")).toBe(false);
  });

  it("assembles affidavit exhibits by their assigned labels, not upload order", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!;
    const result = await buildCourtRecord({
      profile,
      cover: { ...cover, deponent: "Ada Applicant", swornDate: "August 29, 2026" },
      preparationDate: "2026-08-29",
      entries: [
        await entry("affidavit", "affidavit"),
        { ...await entry("exhibit-b", "exhibit"), exhibitLabel: "B" },
        { ...await entry("exhibit-a", "exhibit"), exhibitLabel: "A" },
      ],
    });
    const bytes = result.artifacts[0].bytes;
    expect(await pdfText(bytes.slice(), 3)).toContain("exhibit-a page 1");
    expect(await pdfText(bytes.slice(), 5)).toContain("exhibit-b page 1");
  });

  it("keeps the no-preset affidavit path court-neutral", async () => {
    const profile = COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!;
    const result = await buildCourtRecord({
      profile,
      cover: { courtName: "Superior Court", courtFileNumber: "CV-1",
        deponent: "Ada Applicant", swornDate: "August 29, 2026" },
      preparationDate: "2026-08-29",
      entries: [
        await entry("affidavit", "affidavit"),
        { ...await entry("contract", "exhibit", 2), exhibitLabel: "A" },
      ],
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    expect((await PDFDocument.load(artifact.bytes)).getPageCount()).toBe(3);
    expect(result.receipt.automatic_steps).not.toContain(
      "Inserted an exhibit certificate before each exhibit",
    );
  });

  it("fails closed when a source is restricted or not prepared", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const restricted = { ...await entry("notice", "notice-motion"), encrypted: true };
    await expect(buildCourtRecord({
      profile, cover, preparationDate: "2026-08-29",
      entries: [restricted, await entry("argument", "written-representations")],
    })).rejects.toThrow(/password-protected|restricts access/iu);
    const missing = { ...restricted, encrypted: false, inputStatus: "missing" as const };
    await expect(buildCourtRecord({
      profile, cover, preparationDate: "2026-08-29",
      entries: [missing, await entry("argument", "written-representations")],
    })).rejects.toThrow(/no longer available/iu);
  });

  it("generates Form 344 instead of asking the user to upload a fake certificate", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    const kinds = ["notice", "order-reasons", "originating-pleading", "contents-agreement"];
    const result = await buildCourtRecord({
      profile,
      cover,
      preparationDate: "2026-08-29",
      entries: await Promise.all(kinds.map((kind) => entry(kind, kind))),
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    expect((await PDFDocument.load(artifact.bytes)).getPageCount()).toBe(7);
    expect(result.receipt.automatic_steps).toContain(
      "Generated the Form 344 certificate for signature",
    );
  });

  it("preserves Alberta roles below and appeal status for every party group", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const result = await buildCourtRecord({
      profile,
      cover: { ...cover, partyStyleId: "application-respondent" },
      preparationDate: "2026-08-29",
      entries: await Promise.all([
        ["pleading", "part-1-pleading"],
        ["reasons", "part-2-reasons"],
        ["order", "part-2-order"],
        ["notice", "part-2-notice"],
        ["transcript", "part-3-transcript"],
      ].map(([id, kindId]) => entry(id, kindId))),
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    const text = await pdfText(artifact.bytes.slice());
    expect(text).toContain("RESPONDENT:");
    expect(text).toContain("APPLICANT:");
    expect(text).toContain("Appellant");
    expect(text).toContain("Respondent");
    expect(text).toContain("Intervener");
    expect(await pdfText(artifact.bytes.slice(), 2)).toContain("transcript");
  });

  it("preserves an editable Alberta proposed order byte-for-byte", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!;
    const orderBytes = new TextEncoder().encode("PK\u0003\u0004 editable order fixture");
    const order: RecordEntry = {
      id: "order",
      kindId: "proposed-order",
      file: new File([orderBytes], "proposed-order.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      title: "Proposed order",
      pageCount: null,
      searchable: null,
      encrypted: null,
    };
    const result = await buildCourtRecord({
      profile,
      cover: {},
      preparationDate: "2026-08-29",
      entries: [await entry("application", "application"), order],
    });
    const artifact = result.artifacts.find((item) => item.mimeType.includes("wordprocessingml"))!;
    expect(artifact.filename).toBe("proposed-order.docx");
    expect([...artifact.bytes]).toEqual([...orderBytes]);
    expect(result.receipt.outputs.find((item) => item.filename === artifact.filename)).toMatchObject({
      mime_type: artifact.mimeType,
      page_count: null,
      sha256: artifact.sha256,
    });
    expect(result.receipt.automatic_steps).toContain(
      "Preserved editable Word filing artifacts byte-for-byte",
    );
  });

  it("builds every Alberta and federal preset into openable filing artifacts", async () => {
    for (const profile of COURT_PROFILES.filter((item) => item.jurisdiction !== "general")) {
      const result = await buildCourtRecord({
        profile,
        cover: profileCover(profile),
        preparationDate: "2026-08-29",
        entries: await profileEntries(profile),
      });
      expect(result.artifacts.length, profile.id).toBeGreaterThan(0);
      expect(result.artifacts.some((artifact) => artifact.mimeType === "text/markdown"), profile.id)
        .toBe(false);
      expect(result.receipt.outputs, profile.id).toHaveLength(result.artifacts.length);
      for (const artifact of result.artifacts.filter((item) => item.mimeType === "application/pdf")) {
        const output = await PDFDocument.load(artifact.bytes);
        expect(output.getPageCount(), `${profile.id}:${artifact.filename}`).toBeGreaterThan(0);
        if (profile.technical.pdfPageLabelsMatch) {
          expect(output.catalog.get(PDFName.of("PageLabels")), profile.id).toBeTruthy();
        }
      }
      if (profile.technical.indexDate === "required") {
        const record = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
        expect(await pdfText(record.bytes, 2), profile.id).toContain("dated May 31, 2023");
      }
    }
  }, 30_000);

  it.each([
    ["ab-ca-appeal-record", [255, 0, 0]],
    ["ab-ca-extracts-appellant", [244, 221, 118]],
    ["ab-ca-extracts-respondent", [255, 170, 191]],
    ["ab-ca-extracts-intervener", [159, 197, 220]],
    ["fca-appeal-book", [190, 194, 198]],
  ] as const)("renders the prescribed cover colour for %s", async (profileId, expected) => {
    const profile = COURT_PROFILE_BY_ID.get(profileId)!;
    const result = await buildCourtRecord({
      profile,
      cover: profileCover(profile),
      preparationDate: "2026-08-29",
      entries: await profileEntries(profile),
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    expect(await firstPageFill(artifact.bytes)).toEqual(expected);
  });
});
