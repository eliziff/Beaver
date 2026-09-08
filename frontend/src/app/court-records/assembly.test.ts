// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream,
  StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
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

async function abcaTranscript(id = "transcript") {
  const document = await PDFDocument.load(await (await sourcePdf("transcript", 4)).arrayBuffer());
  const labels = document.context.obj({ Nums: [
    0, document.context.obj({ P: PDFHexString.fromText("") }),
    1, document.context.obj({ S: "r", St: 1 }),
    3, document.context.obj({ S: "D", St: 1 }),
  ] });
  document.catalog.set(PDFName.of("PageLabels"), document.context.register(labels));
  return {
    id, kindId: "part-3-transcript", title: "Transcript", pageCount: 4,
    searchable: true, encrypted: false,
    file: new File([await document.save()], "EVK26DOEJ.pdf", { type: "application/pdf" }),
    pageLabels: ["", "i", "ii", "1"],
  };
}

const cover: CoverValues = {
  courtFileNumber: "S-12345",
  registry: "Vancouver",
  partyStyleId: "application",
  partyGroups: [
    { id: "party-a", role: "Applicant", parties: [
      { id: "ada", name: "Ada Applicant" },
      { id: "acme", name: "François Œuvre" },
    ] },
    { id: "party-b", role: "Respondent", parties: [{ id: "riley", name: "Riley Respondent" }] },
    { id: "intervener", role: "Intervener", parties: [{ id: "justice", name: "Justice Centre" }] },
  ],
  filingPartyIds: ["ada", "acme"],
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
      contact: { name: `${group.role} counsel`, address: "1 Court Street",
        phone: "555-0100" },
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
    filingPartyIds: filingGroup?.parties.map(({ id }) => id),
    counselFax: "N/A",
  };
}

const pdfJsOptions = {
  standardFontDataUrl: resolve("node_modules/pdfjs-dist/standard_fonts") + sep,
};

async function pdfText(bytes: Uint8Array, pageNumber = 1) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes, ...pdfJsOptions }).promise;
  const content = await (await document.getPage(pageNumber)).getTextContent();
  return content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ");
}

async function pdfPageLabels(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return (await getDocument({ data: bytes, ...pdfJsOptions }).promise).getPageLabels();
}

async function pageOperators(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes), contents = document.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream))
    : contents instanceof PDFRawStream ? [contents] : [];
  return streams.map((stream) => new TextDecoder().decode(
    decodePDFRawStream(stream).decode())).join("\n");
}

async function pdfOutline(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes, ...pdfJsOptions }).promise;
  return Promise.all((await document.getOutline() ?? []).map(async (item) => {
    const destination = typeof item.dest === "string"
      ? await document.getDestination(item.dest) : item.dest;
    return { title: item.title, pageIndex: destination
      ? await document.getPageIndex(destination[0]) : -1 };
  }));
}

async function withCourtFontAssets<T>(run: () => Promise<T>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: URL) => {
    const filename = new URL(String(input)).pathname.split("/").at(-1)!;
    const bytes = await readFile(resolve("public", "court-fonts", filename));
    requested.push(filename);
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    ) } as Response;
  });
  try {
    return { value: await run(), requested };
  } finally {
    vi.unstubAllGlobals();
  }
}

async function firstPageFill(bytes: Uint8Array) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes, ...pdfJsOptions }).promise;
  const operators = await (await document.getPage(1)).getOperatorList();
  const index = operators.fnArray.indexOf(OPS.setFillRGBColor);
  return index < 0 ? [] : Array.from(operators.argsArray[index] as Uint8Array);
}

async function pageTextLayout(bytes: Uint8Array, pageNumber: number) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const page = await (await getDocument({ data: bytes, ...pdfJsOptions }).promise).getPage(pageNumber);
  const [operators, content] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
  return {
    sizes: operators.fnArray.flatMap((operator, index) => operator === OPS.setFont
      ? [Number(operators.argsArray[index]?.[1])] : []),
    items: content.items.flatMap((item) => "str" in item
      ? [{ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width }] : []),
  };
}

function linkedPageIndexes(document: PDFDocument, pageIndex: number) {
  const annotations = document.getPage(pageIndex).node.lookup(PDFName.of("Annots"), PDFArray);
  return Array.from({ length: annotations.size() }, (_, index) => {
    const annotation = annotations.lookup(index, PDFDict);
    const target = annotation.lookup(PDFName.of("Dest"), PDFArray).get(0).toString();
    return document.getPages().findIndex((page) => page.ref.toString() === target);
  });
}

function pageLabelStart(document: PDFDocument) {
  const labels = document.context.lookup(
    document.catalog.get(PDFName.of("PageLabels")), PDFDict,
  ).lookup(PDFName.of("Nums"), PDFArray);
  return Number(labels.lookup(1, PDFDict).get(PDFName.of("St"))?.toString());
}

async function indexTabs(bytes: Uint8Array) {
  const { items } = await pageTextLayout(bytes, 2);
  return items.filter(({ text, x }) => /^\d+$/u.test(text) && x < 150).map(({ text }) => text);
}

async function profileEntries(profile: CourtProfile) {
  const required = profile.documentKinds.filter((kind) =>
    kind.requirement === "required" && !kind.generated);
  const base = required.length ? required : profile.documentKinds.filter((kind) =>
    kind.requirement !== "forbidden" && !kind.generated).slice(0, 1);
  const kinds = [...base, ...(profile.oneOf ?? []).flatMap((choice) => {
    const selected = profile.documentKinds.find((kind) => kind.id === choice.slots[0]);
    return selected && !base.some((kind) => kind.id === selected.id) ? [selected] : [];
  })];
  return Promise.all(kinds.map(async (kind, index) => {
    const value = kind.pageLabelScheme === "abca-transcript"
      ? await abcaTranscript(`${profile.id}-${index + 1}`)
      : await entry(`${profile.id}-${index + 1}`, kind.id);
    return {
      ...value,
      ...(kind.acceptedFormats?.length === 1 && kind.acceptedFormats[0] === "docx" && {
        file: new File(["editable"], `${value.id}.docx`, { type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
        pageCount: null, searchable: null, encrypted: null,
      }),
      ...(profile.technical.indexDate === "required" || kind.chronological
        ? { date: "May 31, 2023" } : {}),
    };
  }));
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
      "Linked each table-of-contents row whose document is in the same output",
    );
    const coverText = await pdfText(artifact.bytes);
    expect(coverText).toContain("Ada Applicant");
    expect(coverText).toContain("François Œuvre");
    expect(coverText).toContain("Riley Respondent");
    expect(coverText).toContain("Justice Centre");
    expect(coverText).toContain("Applicant");
    expect(coverText).toContain("Respondent");
    expect(coverText).not.toContain("Moving Party");
    expect(coverText).not.toContain("Responding Party");
    expect(coverText).toContain("APPLICATION UNDER Federal Courts Act, section 18.1");
  });

  it("indexes constituent documents in a nested affidavit output", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const affidavit = await entry("Affidavit package", "moving-evidence", 3);
    affidavit.binding = { kind: "work-product-output", workProductId: "affidavit-draft",
      role: "record" };
    affidavit.sourceBookmarks = [
      { title: "Affidavit of Ada Applicant", pageIndex: 0, children: [] },
      { title: "Exhibit A certificate", pageIndex: 1, children: [] },
      { title: "Exhibit A — January order", pageIndex: 2, children: [] },
    ];
    const result = await buildCourtRecord({ profile, cover, preparationDate: "2026-08-29",
      entries: [await entry("notice", "notice-motion", 2), affidavit,
        await entry("argument", "written-representations")] });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    const output = await PDFDocument.load(artifact.bytes);
    const contents = await pdfText(artifact.bytes, 2);
    expect(contents).toContain("Affidavit of Ada Applicant");
    expect(contents).toContain("Exhibit A certificate");
    expect(contents).toContain("Exhibit A — January order");
    expect(linkedPageIndexes(output, 1)).toEqual(expect.arrayContaining([4, 5, 6]));
  });

  it("paginates a complete filing description instead of truncating it", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const tokens = Array.from({ length: 60 }, (_, index) =>
      `WWWWWWWWWW${String(index + 1).padStart(2, "0")}`);
    const argument = await entry("argument", "written-representations");
    argument.title = tokens.join(" ");

    const result = await buildCourtRecord({ profile, cover, preparationDate: "2026-09-04",
      entries: [await entry("notice", "notice-motion"), argument] });
    const output = await PDFDocument.load(result.artifacts[0].bytes);
    const text = (await Promise.all(Array.from({ length: output.getPageCount() }, (_, index) =>
      pdfText(result.artifacts[0].bytes.slice(), index + 1)))).join(" ");

    expect(output.getPageCount()).toBeGreaterThan(4);
    expect(tokens.every((token) => text.includes(token))).toBe(true);
    expect(text).not.toContain("…");
  });

  it.each([
    [0, (item: { x: number; y: number; width: number }) =>
      [item.x + item.width, item.y], [501, 725]],
    [90, (item: { x: number; y: number; width: number }) =>
      [item.y + item.width, item.x], [681, 67]],
    [180, (item: { x: number; y: number; width: number }) =>
      [item.x - item.width, item.y], [111, 67]],
    [270, (item: { x: number; y: number; width: number }) =>
      [item.y - item.width, item.x], [111, 545]],
  ])("keeps configured page-number geometry on a %d-degree source page",
  async (rotation, edge, expected) => {
    const base = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const profile: CourtProfile = { ...base, technical: { ...base.technical,
      pageNumberPosition: "top-right", pageNumberInset: 111, pageNumberOffset: 67 } };
    const notice = await entry("notice", "notice-motion");
    notice.file = await sourcePdf("notice", 1, rotation);
    const result = await buildCourtRecord({ profile, cover, preparationDate: "2026-08-29",
      entries: [notice, await entry("argument", "written-representations")] });
    const { items } = await pageTextLayout(result.artifacts[0].bytes.slice(), 3);
    const number = items.find(({ text }) => text === "3")!;

    expect(edge(number)[0]).toBeCloseTo(expected[0], 3);
    expect(edge(number)[1]).toBeCloseTo(expected[1], 3);
  });

  it("prints Cree, Arabic, and Chinese names on Alberta covers, indexes, and certificates", async () => {
    const names = {
      cree: "\u140A\u14C2\u1511\u14C8\u142F",
      arabic: "\u0645\u062D\u0645\u062F \u0639\u0644\u064A",
      chinese: "\u5F20\u4F1F",
    };
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!;
    const baseCover = profileCover(profile);
    const [filingGroup, ...otherGroups] = baseCover.partyGroups!;
    const unicodeCover = { ...baseCover, partyGroups: [
      { ...filingGroup, parties: [
        { id: "cree", name: names.cree },
        { id: "arabic", name: names.arabic },
        { id: "chinese", name: names.chinese },
      ] },
      ...otherGroups,
    ], filingPartyIds: ["cree", "arabic", "chinese"] };
    const { value: result, requested } = await withCourtFontAssets(async () => buildCourtRecord({
      profile,
      cover: unicodeCover,
      preparationDate: "2026-09-04",
      entries: [{ ...await entry("extract", "transcript-extract"),
        title: `Transcript of ${names.chinese}` }],
    }));

    const text = await pdfText(result.artifacts[0].bytes.slice());
    expect(text).toContain(names.cree);
    expect(text).toContain(names.arabic);
    expect(text).toContain(names.chinese);
    expect(await pdfText(result.artifacts[0].bytes.slice(), 2)).toContain(names.chinese);
    expect(result.artifacts[0].bytes.byteLength).toBeLessThan(10 * 1024 * 1024);
    expect([...new Set(requested)].sort()).toEqual([
      "NotoNaskhArabic-Regular.ttf",
      "NotoSansCanadianAboriginal-Regular.ttf",
      "NotoSerifSC-Regular.ttf",
    ]);

    const affidavitProfile = COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!;
    const { value: affidavit, requested: certificateFonts } = await withCourtFontAssets(async () =>
      buildCourtRecord({
        profile: affidavitProfile,
        cover: { ...profileCover(affidavitProfile), deponent: names.arabic,
          swornDate: "September 4, 2026" },
        preparationDate: "2026-09-04",
        entries: [
          await entry("affidavit", "affidavit"),
          { ...await entry("exhibit", "exhibit"), exhibitLabel: "A" },
        ],
      }));
    expect(await pdfText(affidavit.artifacts[0].bytes.slice(), 2)).toContain(names.arabic);
    expect(certificateFonts).toEqual(["NotoNaskhArabic-Regular.ttf"]);
  });

  it("rejects unsupported Federal generated-page glyphs instead of using a forbidden font", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
    const federalCover = profileCover(profile);
    federalCover.partyGroups![0].parties[0].name = "\u5F20\u4F1F";
    await expect(buildCourtRecord({ profile, cover: federalCover,
      preparationDate: "2026-09-04", entries: [
        await entry("notice", "notice-motion"),
        await entry("argument", "written-representations"),
      ] })).rejects.toThrow("Federal Court generated pages contain characters unavailable in the permitted fonts");
  });

  it("builds every split Federal Court volume with the complete global record plan", async () => {
    const source = COURT_PROFILE_BY_ID.get("fc-trial-record")!;
    const profile = { ...source, technical: { ...source.technical, maxOutputPages: 7 } };
    const entries = await Promise.all(["Pleading A", "Pleading B", "Pleading C", "Pleading D"]
      .map(async (title, index) => ({ ...await entry(`pleading-${index + 1}`, "pleading", 2),
        title })));
    const result = await buildCourtRecord({ profile, cover: profileCover(profile),
      preparationDate: "2026-09-04", entries });

    expect(result.artifacts).toHaveLength(2);
    const ranges = ["3-4", "5-6", "10-11", "12-13"];
    for (const [volumeIndex, artifact] of result.artifacts.entries()) {
      const document = await PDFDocument.load(artifact.bytes);
      expect(document.getPageCount()).toBe(7);
      expect(pageLabelStart(document)).toBe(volumeIndex ? 8 : 1);
      expect(linkedPageIndexes(document, 1)).toEqual([2, 4]);
      const indexText = await pdfText(artifact.bytes.slice(), 2);
      for (const [itemIndex, item] of entries.entries()) {
        expect(indexText).toContain(item.title);
        expect(indexText).toContain(ranges[itemIndex]);
      }
      expect(await indexTabs(artifact.bytes.slice())).toEqual(["1", "2", "3", "4"]);
      const label = `VOLUME ${volumeIndex + 1} OF 2`;
      expect(await pdfText(artifact.bytes.slice(), 1)).toContain(label);
      expect(await pdfText(artifact.bytes.slice(), 7)).toContain(label);
      for (const [localPage, globalPage] of [[3, volumeIndex ? 10 : 3],
        [5, volumeIndex ? 12 : 5]] as const) {
        expect((await pdfText(artifact.bytes.slice(), localPage)).trim().endsWith(String(globalPage)))
          .toBe(true);
      }
    }
  });

  it("keeps complete global entries and ranges in every split Alberta extracts volume", async () => {
    const source = COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!;
    const profile = { ...source, technical: { ...source.technical, maxOutputPages: 6 } };
    const entries = await Promise.all(["Transcript A", "Transcript B", "Transcript C", "Transcript D"]
      .map(async (title, index) => ({ ...await entry(`extract-${index + 1}`,
        "transcript-extract", 2), title: index ? title : `${title} with a deliberately long but valid description that must not hide its date`,
        ...(index ? {} : { date: "September 4, 2026" }) })));
    const result = await buildCourtRecord({ profile, cover: profileCover(profile),
      preparationDate: "2026-09-04", entries });

    expect(result.artifacts).toHaveLength(2);
    const ranges = ["3-4", "5-6", "9-10", "11-12"];
    for (const [volumeIndex, artifact] of result.artifacts.entries()) {
      const document = await PDFDocument.load(artifact.bytes);
      expect(document.getPageCount()).toBe(6);
      expect(pageLabelStart(document)).toBe(volumeIndex ? 7 : 1);
      expect(linkedPageIndexes(document, 1)).toEqual([2, 4]);
      const indexText = await pdfText(artifact.bytes.slice(), 2);
      for (const [itemIndex, item] of entries.entries()) {
        expect(indexText).toContain(item.title.split(" with ")[0]);
        expect(indexText).toContain(ranges[itemIndex]);
      }
      expect(indexText).toContain("Dated September 4, 2026");
      expect(await indexTabs(artifact.bytes.slice())).toEqual([]);
      const coverText = await pdfText(artifact.bytes.slice(), 1);
      expect(coverText).toContain(`VOLUME ${volumeIndex + 1} OF 2`);
      expect(coverText).not.toContain("PAGES ");
    }
  });

  it("keeps complete FCA indexes, service proof, and volume labels in split records", async () => {
    const source = COURT_PROFILE_BY_ID.get("fca-motion-record-moving")!;
    expect(source.technical.volumeInstructions).toBeTruthy();
    const profile = { ...source, technical: { ...source.technical, maxOutputPages: 8 } };
    const result = await buildCourtRecord({ profile, cover: profileCover(profile),
      preparationDate: "2026-09-04", entries: [
        await entry("oral hearing request", "oral-hearing-request"),
        await entry("other material", "other-filed-material", 2),
        await entry("service", "proof-service"),
        await entry("representations", "written-representations", 2),
        await entry("notice", "notice-motion", 2),
      ] });

    expect(result.artifacts.length).toBeGreaterThan(1);
    let nextPage = 1;
    const contents: string[] = [];
    for (const [volumeIndex, artifact] of result.artifacts.entries()) {
      const document = await PDFDocument.load(artifact.bytes);
      expect(pageLabelStart(document)).toBe(nextPage);
      nextPage += document.getPageCount();
      expect(await indexTabs(artifact.bytes.slice())).toEqual(["1", "2", "3", "4", "5"]);
      expect(linkedPageIndexes(document, 1).length).toBeGreaterThan(0);
      const label = `VOLUME ${volumeIndex + 1} OF ${result.artifacts.length}`;
      expect(await pdfText(artifact.bytes.slice(), 1)).toContain(label);
      expect(await pdfText(artifact.bytes.slice(), artifact.pageCount!)).toContain(label);
      for (let page = 1; page <= document.getPageCount(); page++)
        contents.push(await pdfText(artifact.bytes.slice(), page));
    }
    expect(contents.filter((text) => text.includes("service page 1"))).toHaveLength(1);
    expect(contents.filter((text) => text.includes("oral hearing request page 1"))).toHaveLength(1);
  });

  it("includes a physical-exhibit description as consecutively paginated record content", async () => {
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
    expect(output.getPageCount()).toBe(5);
    expect(await pdfText(artifact.bytes.slice(), 2)).toContain(physical.title);
    expect(await pdfText(artifact.bytes.slice(), 4)).toContain(physical.title);
    expect(output.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(3);
    expect((await pdfOutline(artifact.bytes.slice())).map(({ title }) => title)).toContain(physical.title);
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
      "Generated an exhibit certificate for signature before each exhibit",
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
    const certificate = await pageTextLayout(artifact.bytes.slice(), 2);
    expect(new Set(certificate.sizes)).toEqual(new Set([12]));
    expect(certificate.items.every(({ x, width }) => x >= 99 && x + width <= 513)).toBe(true);
  });

  it("preserves an exhibit's matching certificate instead of inserting a duplicate", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-affidavit-exhibits")!;
    const exhibit = { ...await entry("contract", "exhibit", 2), exhibitLabel: "A",
      sourceFields: { cover: {}, exhibitLabels: [], explicitExhibitLabel: "A" } };

    const result = await buildCourtRecord({ profile,
      cover: { ...cover, deponent: "Ada Applicant", swornDate: "August 29, 2026" },
      preparationDate: "2026-08-29", entries: [await entry("affidavit", "affidavit"), exhibit] });

    expect((await PDFDocument.load(result.artifacts[0].bytes)).getPageCount()).toBe(3);
    expect(result.receipt.automatic_steps.some((step) =>
      step.includes("exhibit certificate for signature"))).toBe(false);
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

  it("generates the unsigned FCA Form 344 when no signed PDF is supplied", async () => {
    const kinds = ["notice", "order-reasons", "originating-pleading", "contents-agreement"];
    const result = await buildCourtRecord({
      profile: COURT_PROFILE_BY_ID.get("fca-appeal-book")!, cover,
      preparationDate: "2026-08-29",
      entries: await Promise.all(kinds.map((kind) => entry(kind, kind))),
    });
    const artifact = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
    expect((await PDFDocument.load(artifact.bytes)).getPageCount()).toBe(7);
    expect(result.receipt.automatic_steps).toContain(
      "Generated the Form 344 certificate for signature",
    );
    expect(await pdfText(artifact.bytes.slice(), 7)).toContain(
      "solicitor for the appellant (or appellant)",
    );
  });

  it("preserves Alberta roles below and appeal status for every party group", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const transcript = await abcaTranscript();
    const result = await buildCourtRecord({
      profile,
      cover: { ...profileCover(profile), partyStyleId: "application-respondent" },
      preparationDate: "2026-08-29",
      entries: await Promise.all([
        ["pleading", "part-1-pleading"],
        ["reasons", "part-2-reasons"],
        ["order", "part-2-order"],
        ["notice", "part-2-notice"],
      ].map(async ([id, kindId]) => ({ ...await entry(id, kindId),
        ...(kindId === "part-1-pleading" && { date: "May 1, 2026" }) })))
        .then((items) => [...items, transcript]),
    });
    const artifact = result.artifacts.find((item) => item.role === "record")!;
    const transcriptArtifact = result.artifacts.find((item) =>
      item.role?.startsWith("part-3-transcript:"))!;
    expect(transcriptArtifact.filename).toBe("EVK26DOEJ.pdf");
    expect(await pdfPageLabels(transcriptArtifact.bytes.slice())).toEqual(["", "i", "ii", "1"]);
    const text = await pdfText(artifact.bytes.slice());
    expect(text).toContain("RESPONDENT:");
    expect(text).toContain("APPLICANT:");
    expect(text).toContain("Appellant");
    expect(text).toContain("Respondent");
    expect(text).toContain("Intervener");
    expect(text).toMatch(/DOCUMENT:\s+APPEAL RECORD/u);
    expect(text.match(/APPEAL RECORD/gu)).toHaveLength(2);
    expect(text).not.toContain("APPEAL RECORD \u2014");
    expect(text).not.toContain("PAGES ");
    expect(await pdfText(artifact.bytes.slice(), 2)).not.toContain("transcript");
    expect([...transcriptArtifact.bytes]).toEqual([...new Uint8Array(await transcript.file.arrayBuffer())]);
  });

  it.each(["action-defendant", "application-respondent"])(
    "prints %s AP-5 parties in originating-proceeding order",
    async (partyStyleId) => {
      const profile = COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!;
      const style = profile.cover.partyStyles!.find(({ id }) => id === partyStyleId)!;
      const partyGroups = style.groups.map((group) => ({ ...group,
        parties: [{ id: group.id, name: `Originating ${group.roleBelow}`,
          contact: { name: "Counsel", address: "1 Court Street", phone: "555-0100" } }] }));
      const result = await buildCourtRecord({ profile,
        cover: { ...profileCover(profile), partyStyleId, partyGroups,
          filingPartyIds: partyGroups.filter(({ id }) => id === profile.cover.filingGroupId)
            .flatMap(({ parties }) => parties.map(({ id }) => id)) },
        preparationDate: "2026-09-04",
        entries: [await entry("extract", "transcript-extract")],
      });
      const text = await pdfText(result.artifacts[0].bytes.slice());
      const first = text.indexOf("PLAINTIFF/APPLICANT:");
      const firstName = text.indexOf(`Originating ${partyStyleId.startsWith("action")
        ? "Plaintiff" : "Applicant"}`);
      const second = text.indexOf("DEFENDANT/RESPONDENT:");
      const secondName = text.indexOf(`Originating ${partyStyleId.startsWith("action")
        ? "Defendant" : "Respondent"}`);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(firstName);
      expect(firstName).toBeLessThan(second);
      expect(second).toBeLessThan(secondName);
    },
  );

  it("derives the AP-5 book title and repeats separately represented contacts", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!;
    const ap5Cover = profileCover(profile);
    delete ap5Cover.recordTitle;
    ap5Cover.partyGroups = [
      { id: "party-a", role: "Appellant", roleBelow: "Plaintiff",
        parties: [{ id: "appellant", name: "Ada North" }] },
      { id: "party-b", role: "Respondent", roleBelow: "Defendant", parties: [
        { id: "respondent", name: "River South",
          contact: { name: "R. Counsel", address: "2 River Road", phone: "555-0200",
            fax: "555-0201", email: "river@example.test" } },
      ] },
      { id: "intervener", role: "Intervener", roleBelow: "Intervener", parties: [
        { id: "intervener", name: "Justice Centre",
          contact: { name: "I. Counsel", address: "3 Justice Way", phone: "555-0300",
            fax: "555-0301", email: "justice@example.test" } },
      ] },
    ];
    ap5Cover.filingPartyIds = ["appellant"];

    const result = await buildCourtRecord({ profile, cover: ap5Cover,
      preparationDate: "2026-09-04",
      entries: [await entry("extract", "transcript-extract")] });
    const text = await pdfText(result.artifacts[0].bytes.slice());
    expect(text).toContain("EXTRACTS OF KEY EVIDENCE OF ADA NORTH, APPELLANT");
    expect(text).toMatch(/Lawyer for River South\s+R\. Counsel\s+2 River Road/u);
    expect(text).toMatch(/Lawyer for Justice Centre\s+I\. Counsel\s+3 Justice Way/u);
    expect(text).toContain("river@example.test");
    expect(text).toContain("justice@example.test");
  });

  it.each([
    ["party-b-1", "0.6627450980392157 0.8196078431372549 0.5568627450980392 rg"],
    ["intervener-1", "0.6235294117647059 0.7725490196078432 0.8627450980392157 rg"],
  ])("uses the selected filing party's factum colour on a condensed book", async (
    filingPartyId, colourOperator,
  ) => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-condensed-book")!;
    const selectedCover = { ...profileCover(profile), filingPartyIds: [filingPartyId] };
    const result = await buildCourtRecord({ profile, cover: selectedCover,
      preparationDate: "2026-09-04",
      entries: [await entry("extract", "filed-extract")] });
    expect(await pageOperators(result.artifacts[0].bytes.slice())).toContain(colourOperator);
  });

  it.each(["fc-motion-record-moving", "ab-ca-extracts-appellant"])(
    "refuses to truncate a style of cause that cannot fit the %s cover",
    async (profileId) => {
      const profile = COURT_PROFILE_BY_ID.get(profileId)!;
      const crowded = profileCover(profile);
      crowded.partyGroups = crowded.partyGroups!.map((group) => ({ ...group,
        parties: Array.from({ length: 24 }, (_, index) => ({
          id: `${group.id}-${index}`,
          name: `${group.role} ${index + 1} with a deliberately complete corporate legal name`,
          contact: { name: "Counsel", address: "1 Court Street", phone: "555-0100" },
        })),
      }));
      crowded.filingPartyIds = [crowded.partyGroups[0].parties[0].id];
      const required = profile.documentKinds.filter((kind) =>
        kind.requirement === "required" && !kind.generated);
      const kinds = required.length ? required : [profile.documentKinds.find((kind) =>
        kind.requirement !== "forbidden" && !kind.generated)!];
      const entries = await Promise.all(kinds.map((kind) => entry(kind.id, kind.id)));

      await expect(buildCourtRecord({ profile, cover: crowded, entries,
        preparationDate: "2026-09-04" })).rejects.toThrow(
        "do not fit the prescribed one-page cover",
      );
    },
  );

  it("writes unavailable and no-oral-record notes into the Alberta appeal-record index", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const files = await Promise.all(profile.documentKinds.filter((kind) =>
      kind.requirement === "required" && kind.id !== "part-2-order")
      .map(async (kind) => ({ ...await entry(kind.id, kind.id),
        ...(kind.chronological && { date: "May 1, 2026" }) })));
    const note = (id: string, kindId: string, title: string): RecordEntry => ({
      id, kindId, title, file: new File([], "description-only"), pageCount: 0,
      searchable: null, encrypted: null, descriptionOnly: true,
    });
    const result = await buildCourtRecord({ profile, cover: profileCover(profile),
      preparationDate: "2026-08-29", entries: [...files,
        note("order-note", "part-2-order", "The formal order was not available when this appeal record was prepared."),
        note("no-oral", "part-3-no-oral-record",
          "There is no oral record that can be transcribed for Part 3, Transcripts")] });
    expect(result.artifacts).toHaveLength(1);
    const index = await pdfText(result.artifacts[0].bytes.slice(), 2);
    expect(index).toContain("The formal order was not available");
    expect(index).toContain("There is no oral record that can be transcribed for Part 3, Transcripts");
    expect(await pdfText(result.artifacts[0].bytes.slice()))
      .not.toContain("DESCRIPTION OF PHYSICAL EXHIBIT");
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
    const application = await entry("application", "application");
    const result = await buildCourtRecord({
      profile,
      cover: {},
      preparationDate: "2026-08-29",
      entries: [application, order],
    });
    const applicationArtifact = result.artifacts.find((item) =>
      item.mimeType === "application/pdf")!;
    expect([...applicationArtifact.bytes])
      .toEqual([...new Uint8Array(await application.file.arrayBuffer())]);
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
    expect(result.receipt.automatic_steps.some((step) => step.startsWith("Split the record")))
      .toBe(false);
  });

  it("keeps separate-file output identity stable when an earlier repeated file is removed", async () => {
    const profile = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-respondent-set")!;
    const first = await entry("first-stable-id", "responding-affidavit");
    const second = await entry("second-stable-id", "responding-affidavit");
    const build = (entries: RecordEntry[]) => buildCourtRecord({ profile, cover: {}, entries,
      preparationDate: "2026-09-04" });
    const before = await build([first, second]);
    const after = await build([second]);
    expect(before.artifacts.find(({ filename }) => filename === "responding-affidavit-2.pdf")?.role)
      .toBe(`responding-affidavit:${second.id}`);
    expect(after.artifacts[0].filename).toBe("responding-affidavit.pdf");
    expect(after.artifacts[0].role).toBe(`responding-affidavit:${second.id}`);
  });

  it.each([
    ["fc-motion-reply", "written-reply"],
    ["fca-motion-reply", "written-reply"],
    ["fca-leave-reply", "written-reply"],
    ["fca-leave-response-set", "memorandum"],
  ] as const)("appends proof of service to the served document for %s", async (
    profileId,
    targetKind,
  ) => {
    const profile = COURT_PROFILE_BY_ID.get(profileId)!;
    const served = { ...await entry("served", targetKind, 2), title: "Served document" };
    const proof = { ...await entry("proof", "proof-service"), title: "Affidavit of service" };
    const result = await buildCourtRecord({ profile, cover: {}, preparationDate: "2026-09-04",
      entries: [proof, served] });

    expect(result.artifacts.map(({ filename }) => filename))
      .toEqual([`${targetKind}.pdf`]);
    expect(result.artifacts.map(({ role }) => role))
      .toEqual([`${targetKind}:${served.id}`]);
    const servedPdf = await PDFDocument.load(result.artifacts[0].bytes);
    expect(servedPdf.getPageCount()).toBe(3);
    expect(await pdfText(result.artifacts[0].bytes.slice(), 3)).toContain("proof page 1");
    expect(await pdfOutline(result.artifacts[0].bytes.slice())).toEqual([
      { title: "Served document", pageIndex: 0 },
      { title: "Proof of service", pageIndex: 2 },
    ]);
    expect(result.receipt.sources).toHaveLength(2);
    expect(result.receipt.outputs).toHaveLength(1);
    expect(result.receipt.automatic_steps)
      .toContain("Appended related filing material in the same bookmarked PDF");
  });

  it("uses the prepared PDF rendition for Word inputs that must be filed as PDF", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-motion-reply")!;
    const rendition = await sourcePdf("written-reply");
    const source = new File(["PK\u0003\u0004 editable reply"], "written-reply.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const result = await buildCourtRecord({ profile, cover: {}, preparationDate: "2026-08-29",
      entries: [{ id: "reply", kindId: "written-reply", file: source,
        pdfRendition: rendition, title: "Written representations in reply", pageCount: 1,
        searchable: true, encrypted: false }] });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ filename: "written-reply.pdf",
      mimeType: "application/pdf" });
    expect([...result.artifacts[0].bytes])
      .toEqual([...new Uint8Array(await rendition.arrayBuffer())]);
    expect(result.receipt.automatic_steps).not.toContain(
      "Preserved editable Word filing artifacts byte-for-byte");
  });

  it("uses a supplied signed Form 344 once, in the appeal book's final slot", async () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    const entries = await profileEntries(profile);
    const input = { profile, cover: profileCover(profile), preparationDate: "2026-09-04" };
    const fallback = await buildCourtRecord({ ...input, entries });
    const signedForm = { ...await entry("signed-form-344", "form-344", 2),
      title: "Form 344 certificate" };
    const signed = await buildCourtRecord({ ...input, entries: [...entries, signedForm] });
    const fallbackPdf = await PDFDocument.load(fallback.artifacts[0].bytes);
    const signedPdf = await PDFDocument.load(signed.artifacts[0].bytes);

    expect(signedPdf.getPageCount()).toBe(fallbackPdf.getPageCount() + 1);
    expect(await pdfText(signed.artifacts[0].bytes.slice(), signedPdf.getPageCount() - 1))
      .toContain("signed-form-344 page 1");
    expect(await pdfText(signed.artifacts[0].bytes.slice(), signedPdf.getPageCount()))
      .toContain("signed-form-344 page 2");
    expect((await pdfOutline(signed.artifacts[0].bytes.slice()))
      .filter(({ title }) => title === "Form 344 certificate")).toHaveLength(1);
    expect(fallback.receipt.automatic_steps)
      .toContain("Generated the Form 344 certificate for signature");
    expect(signed.receipt.automatic_steps)
      .not.toContain("Generated the Form 344 certificate for signature");
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
        if (profile.technical.pdfPageLabelsMatch && artifact.role?.startsWith("record")) {
          expect(output.catalog.get(PDFName.of("PageLabels")), profile.id).toBeTruthy();
        }
      }
      if (profile.technical.indexDate === "required") {
        const record = result.artifacts.find((item) => item.mimeType === "application/pdf")!;
        expect(await pdfText(record.bytes, 2), profile.id).toContain("Dated May 31, 2023");
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
