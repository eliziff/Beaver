import { apiRequest } from "@/app/lib/api/client";
import { acceptedSourceFormats, DOCX_MIME, needsPdfRendition, sourceFormat } from "./formats";
import { outputFilename, sortedEntries, validateCourtRecord } from "./validation";
import { courtProfileForCover } from "./profiles";
import { ap5BookTitle, ap5PartyGroups, ap5PartyLabel, captionPartyGroups, contactGroups, coverPartyGroups, exhibitName,
  filingPartyNames, groupNames, hasMatchingExhibitCertificate, partyNames } from "./types";
import type { BuildArtifact, BuildResult, CasePartyGroup, CourtProfile, CourtRecordReceipt, CoverValues,
  RecordEntry } from "./types";
import type { CourtCover } from "../../../../shared/engine-types/CourtCover";
import type { CourtItem } from "../../../../shared/engine-types/CourtItem";
import type { CourtRecord } from "../../../../shared/engine-types/CourtRecord";
import type { FederalHeading } from "../../../../shared/engine-types/FederalHeading";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

type Progress = (message: string, completed: number, total: number) => void;
/** A record as the engine lays it out (assembly/court.rs), its sources and fonts as the files they are. */
type RecordPlan = Omit<CourtRecord, "items" | "fonts"> & {
  items: Array<Omit<CourtItem, "bytes"> & { bytes?: Blob | null }>; fonts: Blob[] | null };

export type BuildCourtRecordInput = {
  profile: CourtProfile;
  entries: RecordEntry[];
  cover: CoverValues;
  preparationDate: string;
  needsAttention?: Array<{ title: string; detail: string }>;
  onProgress?: Progress;
};

export async function buildCourtRecord(input: BuildCourtRecordInput): Promise<BuildResult> {
  const cover = input.cover, profile = courtProfileForCover(input.profile, cover);
  const entries = sortedEntries(profile, input.entries);
  const blocked = validateCourtRecord({ profile, entries, cover }).blockers[0];
  if (blocked) throw new Error(blocked.detail);
  if (!entries.length) throw new Error("Add the required documents before building.");
  if (profile.outputMode !== "separate-files" && entries.some((entry) =>
    !entry.descriptionOnly && (!entry.pageCount || entry.pageCount < 1))) {
    throw new Error("Every source file must be prepared before building.");
  }
  const allowedKinds = new Map(profile.documentKinds
    .filter((kind) => kind.requirement !== "forbidden")
    .map((kind) => [kind.id, kind]));
  for (const entry of entries) {
    const kind = allowedKinds.get(entry.kindId);
    if (!kind) throw new Error(`${entry.title || entry.file.name} is not permitted in this preset.`);
    if (entry.descriptionOnly) {
      if (!(kind.descriptionOnly || kind.allowUnavailableNote)) {
        throw new Error(`${entry.title} requires a source file.`);
      }
      continue;
    }
    if (!entry.file) throw new Error(`${entry.title} requires a source file.`);
    const format = sourceFormat(entry.file);
    if (!format || !acceptedSourceFormats(kind).includes(format)) {
      throw new Error(`${entry.file.name} is not an accepted source format for ${kind.label}.`);
    }
    if (profile.outputMode === "separate-files" && format === "docx" &&
        !preservesWord(profile, entry) && (!entry.pdfRendition ||
          sourceFormat(entry.pdfRendition) !== "pdf")) {
      throw new Error(`${entry.file.name} must be converted to PDF before building.`);
    }
    if (profile.outputMode !== "separate-files" &&
        sourceFormat(entry.pdfRendition ?? entry.file) !== "pdf") {
      throw new Error("Combined court records require prepared PDF sources.");
    }
  }
  const separateEntries = entries.filter((entry) => allowedKinds.get(entry.kindId)?.separateFile);
  const recordEntries = entries.filter((entry) => !allowedKinds.get(entry.kindId)?.separateFile);

  const sourceReceipts = await Promise.all(entries.filter((entry) => !entry.descriptionOnly).map(async (entry, order) => ({
    order,
    entryId: entry.id,
    filename: entry.file.name,
    title: entry.title,
    kindId: entry.kindId,
    sha256: entry.origin?.sourceSha256 ?? await sha256Bytes(await fileBytes(entry.file)),
    mimeType: entry.file.type || (sourceFormat(entry.file) === "docx" ? DOCX_MIME : "application/pdf"),
    byteCount: entry.file.size,
    pageCount: entry.pageCount,
    origin: entry.origin ?? { kind: "device" as const },
    ocrAppliedPages: (entry.ocrTextByPage ?? [])
      .flatMap((text, index) => text?.trim() ? [index + 1] : []),
  })));

  let outputArtifacts: BuildArtifact[], volumeCount = 1;
  if (profile.outputMode === "separate-files") {
    outputArtifacts = await buildSeparateFiles(profile, entries, cover, input.onProgress);
  } else {
    input.onProgress?.("Building the record", 0, 1);
    const records = await render(profile, profile.outputMode === "affidavit-with-exhibits"
      ? affidavit(profile, recordEntries, cover) : record(profile, recordEntries, cover));
    volumeCount = records.length;
    const separate = await buildSeparateFiles(profile, separateEntries, cover, input.onProgress);
    outputArtifacts = [
      ...records.map((artifact, index) => ({ ...artifact,
        role: index ? `record-${index + 1}` : "record" })),
      ...separate,
    ];
  }

  outputArtifacts = uniqueArtifactFilenames(outputArtifacts);
  enforceOutputLimits(profile, outputArtifacts);
  const profileSha256 = await sha256Bytes(new TextEncoder().encode(canonicalJson(profile)));

  const receipt: CourtRecordReceipt = {
    schema_version: "beaver.court-record-receipt.v2",
    created_at: new Date().toISOString(),
    profile: {
      id: profile.id,
      sha256: profileSha256,
      jurisdiction: profile.jurisdiction,
      court_id: profile.courtId,
      division: profile.division ?? null,
      language: profile.language,
      document_family: profile.documentFamily,
      variant: profile.variant,
      label: profile.label,
      effective: profile.effective,
      source_ids: profile.sourceIds,
    },
    preparation_date: input.preparationDate,
    cover,
    sources: sourceReceipts,
    outputs: outputArtifacts.map((artifact) => ({
      role: artifact.role ?? "record",
      filename: artifact.filename,
      mime_type: artifact.mimeType,
      byte_count: artifact.bytes.byteLength,
      sha256: artifact.sha256,
      page_count: artifact.pageCount ?? null,
    })),
    automatic_steps: automaticSteps(profile, entries, volumeCount),
    needs_attention: input.needsAttention ?? [],
  };
  input.onProgress?.("Record ready", 1, 1);
  return { artifacts: outputArtifacts, receipt };
}

function entryOutputRole(entry: RecordEntry | undefined, index: number) {
  if (!entry) return `file-${index + 1}`;
  return `${entry.kindId}:${entry.id}`;
}

async function buildSeparateFiles(
  profile: CourtProfile,
  entries: RecordEntry[],
  cover: CoverValues,
  progress?: Progress,
) {
  const artifacts: BuildArtifact[] = [];
  const filenames = new Set<string>();
  const kinds = new Map(profile.documentKinds.map((kind) => [kind.id, kind]));
  const filingEntries = entries.filter((entry) => !kinds.get(entry.kindId)?.appendTo);
  for (let index = 0; index < filingEntries.length; index += 1) {
    const entry = filingEntries[index];
    progress?.(`Preparing ${entry.title}`, index, filingEntries.length);
    if (!entry.file) throw new Error(`${entry.title} requires a source file.`);
    const input = filingInput(profile, entry);
    if (!input) throw new Error(`${entry.file.name} must be converted to PDF before building.`);
    const format = sourceFormat(input);
    if (!format) throw new Error(`${entry.file.name} is not a supported filing artifact.`);
    const patterned = profile.outputMode === "separate-files"
      ? outputFilename(profile, cover, entry.kindId) : `${entry.kindId}.pdf`;
    const filename = uniqueFilename(kinds.get(entry.kindId)?.preserveFilename
      ? entry.file.name : patterned.replace(/\.[^.]+$/u, `.${format}`), filenames);
    const attachments = entries.filter((candidate) =>
      kinds.get(candidate.kindId)?.appendTo === entry.kindId);
    if (format === "docx") {
      if (attachments.length) throw new Error(`${entry.file.name} must be converted to PDF before attaching related filing material.`);
      artifacts.push(await fileArtifact(filename, DOCX_MIME, await fileBytes(input)));
    } else if (!attachments.length && !entry.ocrTextByPage?.some((text) => text?.trim())) {
      artifacts.push(await pdfArtifact(filename, await fileBytes(input), entry.pageCount ?? 0));
    } else {
      // Related filing material follows in the same bookmarked PDF; recognized text goes under its pages.
      const sources = [entry, ...attachments];
      artifacts.push(...await render(profile, { layout: "pdf", filename,
        title: attachments.length ? `${profile.label} — ${entry.title}` : entry.title,
        items: sources.map((source) => {
          const pdf = filingInput(profile, source);
          if (!pdf || sourceFormat(pdf) !== "pdf") throw new Error(`${source.file.name} must be prepared as a PDF before it can be attached.`);
          return item(source, !attachments.length ? "" : source === entry ? source.title
            : kinds.get(source.kindId)?.label ?? source.title, pdf);
        }) }));
    }
  }
  return artifacts.map((artifact, index) => ({ ...artifact,
    role: entryOutputRole(filingEntries[index], index) }));
}

function filingInput(profile: CourtProfile, entry: RecordEntry) {
  return sourceFormat(entry.file) === "docx" && !preservesWord(profile, entry)
    ? entry.pdfRendition : entry.file;
}

const item = (entry: RecordEntry | undefined, title: string, bytes = entry && (entry.pdfRendition ?? entry.file)) => ({
  title, tab: 0, bytes, ocrTextByPage: entry?.ocrTextByPage ?? [], output: entry?.binding?.kind === "work-product-output",
  described: false, form344: false });

const BLANK = "____________________________";

/** An affidavit and its exhibits, each exhibit behind its certificate where it carries none of its own. */
function affidavit(profile: CourtProfile, entries: RecordEntry[], cover: CoverValues): Omit<RecordPlan, "technical" | "colour" | "fonts"> {
  return { layout: "affidavit", filename: outputFilename(profile, cover), title: profile.label,
    certificate: { deponent: cover.deponent || BLANK, date: cover.swornDate || BLANK, alberta: profile.jurisdiction === "ab" },
    items: entries.map((entry, index) => {
      if (entry.kindId !== "exhibit") return item(entry, entry.title);
      const label = entry.exhibitLabel?.trim() || exhibitName(entries.slice(0, index).filter(({ kindId }) => kindId === "exhibit").length);
      return { ...item(entry, `Exhibit ${label} — ${entry.title}`),
        certificate: profile.exhibitCertificate && !hasMatchingExhibitCertificate(entry) ? label : null };
    }) };
}

/** A record with its cover and index, its documents in the court's order behind their tabs. */
function record(profile: CourtProfile, entries: RecordEntry[], cover: CoverValues): Omit<RecordPlan, "technical" | "colour" | "fonts"> {
  const kinds = new Map(profile.documentKinds.map((kind) => [kind.id, kind]));
  const order = (kindId: string) => kinds.get(kindId)?.order ?? Number.MAX_SAFE_INTEGER;
  const documents: Array<Pick<RecordEntry, "kindId" | "title"> & Partial<RecordEntry>> = [...entries, ...profile.documentKinds
    .filter((kind) => kind.generated && !entries.some((entry) => entry.kindId === kind.id)).map((kind) => ({ kindId: kind.id, title: kind.label }))]
    .sort((left, right) => order(left.kindId) - order(right.kindId));
  return { layout: "record", filename: outputFilename(profile, cover), title: profile.label,
    cover: profile.cover.generated ? courtCover(profile, cover) : null,
    form344: { heading: federalHeading(profile, cover), name: cover.counselName || filingPartyNames(profile, cover) || BLANK,
      contact: [cover.counselName, cover.counselAddress, cover.counselPhone && `Telephone: ${cover.counselPhone}`,
        cover.counselFax && `Fax: ${cover.counselFax}`].filter((value): value is string => !!value) },
    items: documents.map((document, index) => {
      const kind = kinds.get(document.kindId)!, entry = document.file && !document.descriptionOnly ? document as RecordEntry : undefined;
      return { ...item(entry, document.title.trim() || kind.label), tab: index + 1, group: kind.group, date: document.date,
        described: !!document.descriptionOnly && !!kind.renderDescriptionPage,
        form344: kind.generated === "federal-form-344-certificate" };
    }) };
}

const coverGroup = (group: CasePartyGroup) => ({ names: partyNames(group) || BLANK, role: group.role });

function federalHeading(profile: CourtProfile, cover: CoverValues): FederalHeading {
  return { number: cover.courtFileNumber || "________________",
    court: profile.courtAbbreviation === "FCA" ? "FEDERAL COURT OF APPEAL" : "FEDERAL COURT",
    groups: captionPartyGroups(profile, cover).map(coverGroup),
    under: (cover.partyStyleId ?? profile.cover.partyStyles?.[0]?.id) === "application" ? cover.applicationUnder : null };
}

function courtCover(profile: CourtProfile, cover: CoverValues): CourtCover {
  const [filing, others] = contactGroups(profile, cover);
  const lines = (...values: Array<string | undefined>) => values.map((value) => value ?? "");
  if (profile.cover.template === "federal-record") {
    const column = (strong: string, ...values: Array<string | undefined>) =>
      [[strong, true], ...lines(...values).map((value) => [value, false])] as Array<[string, boolean]>;
    const tagged = (prefix: string, value?: string) => value && `${prefix}: ${value}`;
    return { template: "federal-record", heading: federalHeading(profile, cover),
      title: cover.recordTitle || profile.cover.title,
      subtitles: [cover.recordSubtitle, tagged("Hearing date", cover.hearingDate)].filter((value): value is string => !!value),
      contacts: [column(groupNames(filing), filing?.role, cover.counselName, cover.counselAddress, tagged("Tel", cover.counselPhone),
        tagged("Fax", cover.counselFax), tagged("Email", cover.counselEmail)),
      column(groupNames(...others), others.map((group) => group.role).join(" / "), cover.otherCounselName, cover.otherCounselAddress,
        tagged("Tel", cover.otherCounselPhone), tagged("Fax", cover.otherCounselFax), tagged("Email", cover.otherCounselEmail))] };
  }
  if (profile.cover.template === "abca-ap5") {
    const parties = others.flatMap((group) => group.parties).filter(({ name }) => name.trim());
    return { template: "abca-ap5",
      rows: [["COURT OF APPEAL FILE NUMBER:", cover.courtFileNumber], ["TRIAL COURT FILE NUMBER:", cover.lowerCourtFileNumber],
        ["REGISTRY OFFICE:", cover.registry], ...ap5PartyGroups(profile, cover).flatMap((group) =>
          [[ap5PartyLabel(group), partyNames(group)], ["STATUS ON APPEAL:", group.role]]), ["DOCUMENT:", profile.cover.title]]
        .map(([label, value]): [string, string] => [label ?? "", value ?? ""]),
      rule: `[${profile.cover.ruleReference ?? "Rule 14.87"}]`,
      decision: ["Appeal from the Decision of", cover.decisionMaker || BLANK,
        cover.decisionDate ? `Dated ${legalDate(cover.decisionDate)}` : "Dated ____________________________",
        cover.decisionFileDate ? `Filed ${legalDate(cover.decisionFileDate)}` : "Filed _____________________________"],
      title: ap5BookTitle(profile, cover),
      filing: lines(`Lawyer for ${groupNames(filing) || "________________"}`, cover.counselName, cover.counselAddress,
        cover.counselPhone, cover.counselFax, cover.counselEmail),
      others: parties.length ? parties.map(({ name, contact }) => lines(`Lawyer for ${name}`, contact?.name, contact?.address,
        contact?.phone, contact?.fax, contact?.email)) : [["Lawyer for ________________"]] };
  }
  return { template: "generic", court: cover.courtName || profile.court, groups: coverPartyGroups(profile, cover).map(coverGroup),
    title: cover.recordTitle || profile.cover.title, number: cover.courtFileNumber || "", filer: filingPartyNames(profile, cover) };
}

function legalDate(value: string) {
  const prose = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/u);
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!prose && !iso) return value;
  const day = Number(prose?.[2] ?? iso?.[3]);
  const month = prose?.[1] ?? ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"][Number(iso?.[2]) - 1];
  const year = prose?.[3] ?? iso?.[1];
  const suffix = day % 10 === 1 && day !== 11 ? "st"
    : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `the ${day}${suffix} day of ${month}, ${year}`;
}

/** The fonts set what the court's standard fonts cannot, where its pages allow them (the Federal Courts' do not). */
const FALLBACK_FONTS: Array<[string, RegExp]> = [
  ["NotoSansCanadianAboriginal-Regular.ttf", /[᐀-ᙿᢰ-᣿]/u],
  ["NotoNaskhArabic-Regular.ttf", /\p{Script_Extensions=Arabic}/u],
  ["NotoSerifSC-Regular.ttf", /\p{Script_Extensions=Han}/u],
  ["NotoSerif-Regular.ttf", /[^\s\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/u],
];

/** The record's PDFs, laid out by the engine. */
async function render(profile: CourtProfile, plan: Omit<RecordPlan, "technical" | "colour" | "fonts">) {
  const drawn = JSON.stringify(plan, (key, value) => key === "ocrTextByPage" || value instanceof Blob ? undefined : value);
  const fonts = profile.jurisdiction === "ca" ? null : await Promise.all(FALLBACK_FONTS
    .filter(([, script]) => script.test(drawn)).map(async ([file]) => {
      const response = await fetch(new URL(`/court-fonts/${file}`, globalThis.location?.origin ?? "http://localhost"));
      if (!response.ok) throw new Error(`The bundled court PDF font ${file} could not be loaded.`);
      return response.blob();
    }));
  const files: Blob[] = [], body = new FormData();
  body.append("record", JSON.stringify({ ...plan, technical: profile.technical, colour: profile.cover.colourHex, fonts } satisfies RecordPlan,
    (_key, value) => value instanceof Blob ? files.push(value) - 1 : value));
  files.forEach((file) => body.append("files", file));
  const built = await apiRequest<Array<{ filename: string; pageCount: number; bytes: string }>>("/court-records/assembly",
    { method: "POST", body });
  return Promise.all(built.map(({ filename, pageCount, bytes }) =>
    pdfArtifact(filename, Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0)), pageCount)));
}

function exceedsOutputLimit(profile: CourtProfile, artifact: BuildArtifact) {
  const pageLimit = profile.technical.maxOutputPages;
  return (!!profile.technical.maxOutputBytes && artifact.bytes.byteLength > profile.technical.maxOutputBytes) ||
    (!!pageLimit && !!artifact.pageCount && artifact.pageCount > pageLimit);
}

function enforceOutputLimits(profile: CourtProfile, artifacts: BuildArtifact[]) {
  const oversized = artifacts.find((artifact) => artifact.mimeType !== "text/markdown" &&
    exceedsOutputLimit(profile, artifact));
  if (!oversized) return;
  const byteLimit = profile.technical.maxOutputBytes;
  throw new Error(byteLimit && oversized.bytes.byteLength > byteLimit
    ? `${oversized.filename} is larger than the court's ${Math.round(byteLimit / (1024 * 1024))} MB filing limit. Reduce that source file before building.`
    : `${oversized.filename} exceeds the court's ${profile.technical.maxOutputPages}-page limit. Reduce or divide the source material before building.`);
}

function automaticSteps(profile: CourtProfile, entries: RecordEntry[], volumes: number) {
  const steps = profile.outputMode === "separate-files" ? [
    "Prepared each filing artifact separately in the preset's court order",
  ] : profile.outputMode === "affidavit-with-exhibits" ? [
    "Placed the affidavit and exhibits in the preset's required order",
    `Printed continuous ${profile.technical.pageNumberPosition.replace("-", " ")} page numbers`,
    "Matched PDF page labels to the printed page numbers",
    "Added meaningful affidavit and exhibit bookmarks",
  ] : [
    "Placed permitted documents in the preset's required court order",
    "Generated the cover and table of contents where the preset requires them",
    `Printed continuous ${profile.technical.pageNumberPosition.replace("-", " ")} page numbers`,
    "Matched PDF page labels to the printed page numbers",
    "Added meaningful document bookmarks and opened the bookmarks panel where required",
    "Linked each table-of-contents row whose document is in the same output",
  ];
  if (profile.outputMode === "separate-files" && entries.some((entry) => preservesWord(profile, entry))) {
    steps.push("Preserved editable Word filing artifacts byte-for-byte");
  }
  if (entries.some((entry) => entry.ocrTextByPage?.some(Boolean))) {
    steps.push("Added locally recognized text to source pages selected for OCR");
  }
  const kinds = new Map(profile.documentKinds.map((kind) => [kind.id, kind]));
  if (entries.some((entry) => kinds.get(entry.kindId)?.separateFile)) {
    steps.push("Kept stand-alone source PDFs separate from the assembled record");
  }
  if (entries.some((entry) => kinds.get(entry.kindId)?.appendTo)) {
    steps.push("Appended related filing material in the same bookmarked PDF");
  }
  const exhibits = entries.filter((entry) => entry.kindId === "exhibit");
  const insertedCertificates = exhibits.filter((entry) => !hasMatchingExhibitCertificate(entry));
  if (profile.exhibitCertificate && insertedCertificates.length) {
    steps.push(insertedCertificates.length === exhibits.length
      ? "Generated an exhibit certificate for signature before each exhibit"
      : "Generated an exhibit certificate for signature before each exhibit that did not already include one");
  }
  if (profile.documentKinds.some((kind) => kind.generated === "federal-form-344-certificate" &&
    !entries.some((entry) => entry.kindId === kind.id))) {
    steps.push("Generated the Form 344 certificate for signature");
  }
  if (volumes > 1) steps.push(`Split the record into ${volumes} continuously numbered volumes`);
  return steps;
}

function preservesWord(profile: CourtProfile, entry: RecordEntry) {
  return sourceFormat(entry.file) === "docx" &&
    !needsPdfRendition(profile.documentKinds.find(({ id }) => id === entry.kindId));
}

async function pdfArtifact(filename: string, bytes: Uint8Array, pageCount: number) {
  return {
    filename,
    mimeType: "application/pdf" as const,
    bytes,
    pageCount,
    sha256: await sha256Bytes(bytes),
  };
}

async function fileArtifact(
  filename: string,
  mimeType: BuildArtifact["mimeType"],
  bytes: Uint8Array,
): Promise<BuildArtifact> {
  return { filename, mimeType, bytes, sha256: await sha256Bytes(bytes) };
}

function uniqueArtifactFilenames(artifacts: BuildArtifact[]) {
  const used = new Set<string>();
  return artifacts.map((artifact) => ({ ...artifact,
    filename: uniqueFilename(artifact.filename, used) }));
}

function uniqueFilename(filename: string, used: Set<string>) {
  let candidate = filename, next = 2;
  while (used.has(candidate.toLocaleLowerCase("en-CA"))) {
    candidate = filename.replace(/(\.[^.]+)$/u, `-${next}$1`); next += 1;
  }
  used.add(candidate.toLocaleLowerCase("en-CA"));
  return candidate;
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fileBytes(file: File) {
  return new Uint8Array(await file.arrayBuffer());
}
