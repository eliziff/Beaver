import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { drawCourtCover, drawCourtExhibitCertificate, drawFederalForm344 } from "./courtForms";
import { acceptedSourceFormats, DOCX_MIME, needsPdfRendition, sourceFormat } from "./formats";
import { indexChunks } from "./layout";
import { outputFilename, sortedEntries, validateCourtRecord } from "./validation";
import { courtProfileForCover } from "./profiles";
import { exhibitName, hasMatchingExhibitCertificate } from "./types";
import type {
  BuildArtifact,
  BuildResult,
  CourtProfile,
  CourtRecordReceipt,
  CoverValues,
  RecordEntry,
  SourceBookmark,
} from "./types";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import {
  courtPdfText as latin,
  courtPdfTextWidth,
  drawCourtPdfText,
  registerCourtPdfFonts,
} from "./pdfText";

const LETTER: [number, number] = [612, 792];
const GENERATED_OVERHEAD_BYTES = 160_000;

type Progress = (message: string, completed: number, total: number) => void;

type AssemblyItem = {
  id: string;
  tab: number;
  kindId: string;
  title: string;
  baseTitle?: string;
  group?: string;
  date?: string;
  pageCount: number;
  bytes: number;
  entry?: RecordEntry;
  sourcePageStart?: number;
  sourcePageEnd?: number;
  generated?: "federal-form-344-certificate" | "exhibit-certificate";
  exhibitLabel?: string;
  descriptionOnly?: boolean;
  indexLines?: string[];
  indexChildren?: Array<{ id: string; title: string; pageOffset: number; lines: string[] }>;
  indexParentId?: string;
  indexPageOffset?: number;
  descriptionLines?: string[];
};

type Outline = {
  title: string;
  pageIndex: number;
  children?: Outline[];
};

type IndexTarget = {
  page: PDFPage;
  rect: [number, number, number, number];
  targetPageIndex: number;
};

type VolumePlan = {
  items: AssemblyItem[];
  startNumber: number;
  number: number;
  count: number;
};

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
  const uploadItems = recordEntries.map<AssemblyItem>((entry) => {
    const kind = allowedKinds.get(entry.kindId);
    return {
      id: entry.id,
      tab: 0,
      kindId: entry.kindId,
      title: entry.title.trim() || kind!.label,
      baseTitle: entry.title.trim() || kind!.label,
      group: kind!.group,
      date: entry.date,
      pageCount: entry.descriptionOnly ? (kind!.renderDescriptionPage ? 1 : 0) : entry.pageCount ?? 0,
      bytes: entry.descriptionOnly ? 0 : (entry.pdfRendition ?? entry.file).size,
      entry: entry.descriptionOnly ? undefined : entry,
      descriptionOnly: entry.descriptionOnly,
    };
  });
  const generated = profile.documentKinds.flatMap<AssemblyItem>((kind) =>
    kind.generated && !entries.some((entry) => entry.kindId === kind.id) ? [{
    id: `generated:${kind.id}`,
    tab: 0,
    kindId: kind.id,
    title: kind.label,
    group: kind.group,
    pageCount: 1,
    bytes: 0,
    generated: kind.generated,
  }] : []);
  const order = new Map(profile.documentKinds.map((kind) => [kind.id, kind.order]));
  const items = [...uploadItems, ...generated].sort((left, right) =>
    (order.get(left.kindId) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.kindId) ?? Number.MAX_SAFE_INTEGER))
    .map((item, index) => ({ ...item, tab: index + 1 }));

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
    outputArtifacts = await buildSeparateFiles(profile, entries, cover, input.onProgress, true);
  } else {
    const records = profile.outputMode === "affidavit-with-exhibits"
      ? [await buildAffidavit(profile, recordEntries, cover, input.onProgress)]
      : await buildMeasuredVolumes(profile, items, cover, input.onProgress);
    volumeCount = records.length;
    const separate = await buildSeparateFiles(profile, separateEntries, cover, input.onProgress, true);
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
  preserve = false,
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
    if (attachments.length) {
      if (format !== "pdf") throw new Error(`${entry.file.name} must be converted to PDF before attaching related filing material.`);
      artifacts.push(await buildAttachedPdf(profile, entry, attachments, filename));
      continue;
    }
    const raw = await fileBytes(input);
    if (format === "docx") {
      artifacts.push(await fileArtifact(filename, DOCX_MIME, raw));
      continue;
    }
    if (preserve) {
      if (!entry.ocrTextByPage?.some((text) => text?.trim())) {
        artifacts.push(await pdfArtifact(filename, raw, entry.pageCount ?? 0));
        continue;
      }
      const output = await PDFDocument.load(raw);
      const font = await output.embedFont(StandardFonts.Helvetica);
      output.getPages().forEach((page, pageIndex) =>
        applyOcrText(page, font, entry.ocrTextByPage?.[pageIndex]));
      artifacts.push(await pdfArtifact(filename, await output.save(), output.getPageCount()));
      continue;
    }
    const output = await PDFDocument.create();
    const font = await output.embedFont(StandardFonts.Helvetica);
    const source = await PDFDocument.load(raw);
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page, pageIndex) => {
      output.addPage(page);
      applyOcrText(page, font, entry.ocrTextByPage?.[pageIndex]);
      if (profile.technical.continuousPageNumbers) {
        drawPageNumber(page, pageIndex + 1, font, profile.technical.pageNumberPosition,
          profile.technical.pageNumberSize, profile.technical.pageNumberInset,
          profile.technical.pageNumberOffset);
      }
    });
    if (profile.technical.pdfPageLabelsMatch) applyPageLabels(output, 1);
    applyOutlines(output, [{ title: entry.title, pageIndex: 0,
      children: sourceOutlines(entry.sourceBookmarks, 0) }], profile.technical.bookmarksPanelOpen);
    setMetadata(output, `${profile.label} — ${entry.title}`);
    const bytes = await output.save();
    artifacts.push(await pdfArtifact(filename, bytes, pages.length));
  }
  return artifacts.map((artifact, index) => ({ ...artifact,
    role: entryOutputRole(filingEntries[index], index) }));
}

async function buildAttachedPdf(
  profile: CourtProfile,
  entry: RecordEntry,
  attachments: RecordEntry[],
  filename: string,
) {
  const document = await PDFDocument.create();
  const sources = [entry, ...attachments];
  const font = sources.some((source) => source.ocrTextByPage?.some((text) => text?.trim()))
    ? await document.embedFont(StandardFonts.Helvetica) : undefined;
  const outlines: Outline[] = [];
  for (const sourceEntry of sources) {
    const input = filingInput(profile, sourceEntry);
    if (!input || sourceFormat(input) !== "pdf") {
      throw new Error(`${sourceEntry.file.name} must be prepared as a PDF before it can be attached.`);
    }
    const source = await PDFDocument.load(await fileBytes(input));
    const start = document.getPageCount();
    const pages = await document.copyPages(source, source.getPageIndices());
    pages.forEach((page, pageIndex) => {
      document.addPage(page);
      if (font) applyOcrText(page, font, sourceEntry.ocrTextByPage?.[pageIndex]);
    });
    const kind = profile.documentKinds.find(({ id }) => id === sourceEntry.kindId);
    outlines.push({ title: sourceEntry === entry ? sourceEntry.title : kind?.label ?? sourceEntry.title,
      pageIndex: start, children: sourceOutlines(sourceEntry.sourceBookmarks, start) });
  }
  applyOutlines(document, outlines, profile.technical.bookmarksPanelOpen);
  setMetadata(document, `${profile.label} — ${entry.title}`);
  return pdfArtifact(filename, await document.save(), document.getPageCount());
}

function filingInput(profile: CourtProfile, entry: RecordEntry) {
  return sourceFormat(entry.file) === "docx" && !preservesWord(profile, entry)
    ? entry.pdfRendition : entry.file;
}

async function buildAffidavit(
  profile: CourtProfile,
  entries: RecordEntry[],
  cover: CoverValues,
  progress?: Progress,
) {
  const output = await PDFDocument.create();
  const regular = await output.embedFont(StandardFonts.TimesRoman);
  const bold = await output.embedFont(StandardFonts.TimesRomanBold);
  await registerCourtPdfFonts(output, [regular, bold], { profile,
    deponent: cover.deponent, swornDate: cover.swornDate,
    exhibitLabels: entries.map(({ exhibitLabel }) => exhibitLabel) }, profile.jurisdiction !== "ca");
  const outlines: Outline[] = [];
  let pageNumber = 1;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    progress?.(`Adding ${entry.title}`, entryIndex, entries.length);
    if (entry.kindId === "exhibit" && profile.exhibitCertificate &&
        !hasMatchingExhibitCertificate(entry)) {
      const label = entry.exhibitLabel?.trim() || exhibitName(
        entries.slice(0, entryIndex).filter((item) => item.kindId === "exhibit").length,
      );
      const certificate = output.addPage(LETTER);
      drawCourtExhibitCertificate(certificate, regular, bold, profile, cover, label);
      drawPageNumber(certificate, pageNumber++, regular, profile.technical.pageNumberPosition,
        profile.technical.pageNumberSize, profile.technical.pageNumberInset,
        profile.technical.pageNumberOffset);
      outlines.push({ title: `Exhibit ${label} certificate`, pageIndex: output.getPageCount() - 1 });
    }
    const start = output.getPageCount();
    const source = await PDFDocument.load(await fileBytes(entry.pdfRendition ?? entry.file));
    const copied = await output.copyPages(source, source.getPageIndices());
    copied.forEach((page, localIndex) => {
      output.addPage(page);
      applyOcrText(page, regular, entry.ocrTextByPage?.[localIndex]);
      drawPageNumber(page, pageNumber++, regular, profile.technical.pageNumberPosition,
        profile.technical.pageNumberSize, profile.technical.pageNumberInset,
        profile.technical.pageNumberOffset);
    });
    outlines.push({
      title: entry.kindId === "exhibit"
        ? `Exhibit ${entry.exhibitLabel?.trim() || exhibitName(entries.slice(0, entryIndex)
          .filter((item) => item.kindId === "exhibit").length)} — ${entry.title}`
        : entry.title,
      pageIndex: start,
      children: sourceOutlines(entry.sourceBookmarks, start),
    });
  }
  applyPageLabels(output, 1);
  applyOutlines(output, outlines, profile.technical.bookmarksPanelOpen);
  setMetadata(output, profile.label);
  const bytes = await output.save();
  return pdfArtifact(outputFilename(profile, cover), bytes, output.getPageCount());
}

async function buildMeasuredVolumes(
  profile: CourtProfile,
  items: AssemblyItem[],
  cover: CoverValues,
  progress?: Progress,
) {
  items = await measureIndexItems(profile, items);
  const plans = planVolumes(profile, items);
  const maximumSplits = items.reduce((sum, item) => sum + item.pageCount, 0) + 1;
  for (let attempt = 0; attempt < maximumSplits; attempt += 1) {
    const global = numberVolumePlans(profile, plans);
    const artifacts: BuildArtifact[] = [];
    for (const plan of plans) {
      progress?.(
        plan.count > 1 ? `Building volume ${plan.number} of ${plan.count}` : "Building the record",
        plan.number - 1,
        plan.count,
      );
      artifacts.push(await buildCombinedVolume(profile, plan, cover, global));
    }
    const oversizedIndex = artifacts.findIndex((artifact) => exceedsOutputLimit(profile, artifact));
    if (oversizedIndex < 0) return artifacts;
    if (!profile.technical.volumeInstructions) {
      throw outputLimitError(profile, artifacts[oversizedIndex]);
    }
    const split = splitVolumePlan(plans[oversizedIndex]);
    if (!split) throw outputLimitError(profile, artifacts[oversizedIndex]);
    plans.splice(oversizedIndex, 1, ...split);
  }
  throw new Error("The record could not be divided into filing-sized volumes.");
}

async function measureIndexItems(profile: CourtProfile, items: AssemblyItem[]) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.TimesRoman);
  const sans = await document.embedFont(StandardFonts.Helvetica);
  await registerCourtPdfFonts(document, [regular, sans], { profile, items },
    profile.jurisdiction !== "ca");
  const style = profile.technical.indexStyle;
  const font = style === "federal" ? regular : sans;
  const width = style === "federal" ? 297 : style === "abca" ? 400 : 322;
  const size = style === "federal" || style === "abca" ? 12 : 8.5;
  const described = new Set(profile.documentKinds.filter(({ renderDescriptionPage }) =>
    renderDescriptionPage).map(({ id }) => id));
  return items.map((item) => {
    const descriptionLines = item.descriptionOnly && described.has(item.kindId)
      ? wrap(latin(item.title), regular, 12, 612 - 198.42) : undefined;
    const sourceStart = item.sourcePageStart ?? 0;
    const sourceEnd = item.sourcePageEnd ?? item.entry?.pageCount ?? item.pageCount;
    const bookmarks = (item.entry?.sourceBookmarks ?? []).filter(({ pageIndex }) =>
      pageIndex >= sourceStart && pageIndex < sourceEnd);
    const compound = bookmarks.length > 1 && (item.entry?.binding?.kind === "work-product-output" ||
      bookmarks.some(({ title }) => /^Exhibit\b/iu.test(title)));
    const indexChildren = compound ? bookmarks.map((bookmark, index) => ({
      id: `${item.id}:bookmark:${index}`,
      title: latin(bookmark.title),
      pageOffset: bookmark.pageIndex - sourceStart,
      lines: wrap(latin(bookmark.title), font, size, width - 14),
    })) : undefined;
    return { ...item,
      ...(descriptionLines && { descriptionLines,
        pageCount: Math.ceil(descriptionLines.length / 36) }),
      ...(indexChildren?.length && { indexChildren }),
      indexLines: [
        ...wrap(latin(item.title), font, size, width),
        ...(item.date && (style === "abca" ||
          style === "federal" && profile.technical.indexDate !== "none")
          ? [`Dated ${latin(item.date)}`] : []),
      ] };
  });
}

function expandedIndexItems(profile: CourtProfile, items: AssemblyItem[]) {
  const maxLines = profile.technical.indexStyle === "federal" ||
    profile.technical.indexStyle === "abca" ? 20 : 40;
  const split = (item: AssemblyItem) => {
    const lines = item.indexLines ?? [latin(item.title)];
    const parts = Array.from({ length: Math.ceil(lines.length / maxLines) }, (_, index) =>
      lines.slice(index * maxLines, (index + 1) * maxLines));
    return parts.map((indexLines) => ({ ...item, indexLines }));
  };
  return items.flatMap((item) => [...split(item), ...(item.indexChildren ?? []).flatMap((child) =>
    split({ ...item, id: child.id, title: child.title, date: undefined, bytes: 0,
      pageCount: 1, indexLines: child.lines, indexChildren: undefined,
      indexParentId: item.id, indexPageOffset: child.pageOffset }))]);
}

function indexRange(item: AssemblyItem, ranges: Map<string, { start: number; end: number }>) {
  const range = ranges.get(item.indexParentId ?? item.id)!;
  return item.indexPageOffset === undefined ? range : {
    start: range.start + item.indexPageOffset,
    end: range.start + item.indexPageOffset,
  };
}

const indexIsLocal = (item: AssemblyItem, localIds: Set<string>) =>
  localIds.has(item.indexParentId ?? item.id);

function indexRowUnits(profile: CourtProfile, item: AssemblyItem) {
  const lines = Math.max(1, item.indexLines?.length ?? 1);
  if (profile.technical.indexStyle === "federal") return Math.max(32, lines * 15 + 10) / 32;
  if (profile.technical.indexStyle === "abca") return 1 + Math.max(0, lines - 2) * 16 / 39.6;
  return Math.max(24, lines * 11 + 13) / 24;
}

function plannedIndexChunks(profile: CourtProfile, items: AssemblyItem[]) {
  const groupRows = profile.technical.indexStyle === "federal" ? 22 / 32
    : profile.technical.indexStyle === "abca" ? 1 : 21 / 24;
  return indexChunks(expandedIndexItems(profile, items), profile.technical.indexRowsPerPage,
    (item) => indexRowUnits(profile, item), groupRows);
}

const plannedIndexPageCount = (profile: CourtProfile, items: AssemblyItem[]) =>
  plannedIndexChunks(profile, items).length;

function numberVolumePlans(profile: CourtProfile, plans: VolumePlan[]) {
  const allItems = plans.flatMap(({ items }) => items);
  const ranges = new Map<string, { start: number; end: number }>();
  let nextNumber = 1;
  plans.forEach((plan, index) => {
    plan.number = index + 1;
    plan.count = plans.length;
  });
  for (const plan of plans) {
    plan.startNumber = nextNumber;
    const indexItems = profile.technical.completeIndexEachVolume ? allItems : plan.items;
    let next = plan.startNumber + frontPageCount(profile, indexItems);
    for (const item of plan.items) {
      ranges.set(item.id, { start: next, end: next + item.pageCount - 1 });
      next += item.pageCount;
    }
    nextNumber = next + backCoverPageCount(profile, plan);
  }
  return { allItems, ranges };
}

function splitVolumePlan(plan: VolumePlan): [VolumePlan, VolumePlan] | undefined {
  const sources = plan.items.filter((item) => !item.generated);
  const generated = plan.items.filter((item) => item.generated);
  let halves: [AssemblyItem[], AssemblyItem[]] | undefined;
  if (sources.length > 1) {
    const total = sources.reduce((sum, item) => sum + Math.max(1, item.bytes), 0);
    let running = 0;
    let splitAt = 1;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < sources.length; index += 1) {
      running += Math.max(1, sources[index - 1].bytes);
      const candidate = Math.abs(total - (2 * running));
      if (candidate < distance) {
        distance = candidate;
        splitAt = index;
      }
    }
    halves = [sources.slice(0, splitAt), sources.slice(splitAt)];
  } else if (sources.length === 1) {
    halves = splitAssemblyItem(sources[0]);
  }
  if (!halves || !halves[0].length || !halves[1].length) return undefined;
  return [
    { ...plan, items: halves[0] },
    { ...plan, items: [...halves[1], ...generated] },
  ];
}

function splitAssemblyItem(item: AssemblyItem): [AssemblyItem[], AssemblyItem[]] | undefined {
  if (item.descriptionLines && item.pageCount > 1) {
    const middle = Math.ceil(item.pageCount / 2) * 36;
    const part = (lines: string[], suffix: string): AssemblyItem => ({ ...item,
      id: `${item.id}:${suffix}`, descriptionLines: lines,
      pageCount: Math.ceil(lines.length / 36) });
    return [[part(item.descriptionLines.slice(0, middle), "part-1")],
      [part(item.descriptionLines.slice(middle), "part-2")]];
  }
  if (!item.entry || item.pageCount < 2) return undefined;
  const start = item.sourcePageStart ?? 0;
  const end = item.sourcePageEnd ?? item.entry.pageCount ?? item.pageCount;
  const middle = start + Math.ceil((end - start) / 2);
  if (middle <= start || middle >= end) return undefined;
  const baseTitle = item.baseTitle ?? item.title;
  const part = (from: number, to: number): AssemblyItem => ({
    ...item,
    id: `${item.entry!.id}:source-pages-${from + 1}-${to}`,
    title: `${baseTitle} — source pages ${from + 1}–${to}`,
    baseTitle,
    sourcePageStart: from,
    sourcePageEnd: to,
    pageCount: to - from,
    bytes: Math.ceil(item.bytes * ((to - from) / (end - start))),
  });
  return [[part(start, middle)], [part(middle, end)]];
}

function exceedsOutputLimit(profile: CourtProfile, artifact: BuildArtifact) {
  const pageLimit = profile.technical.maxOutputPages;
  return (!!profile.technical.maxOutputBytes && artifact.bytes.byteLength > profile.technical.maxOutputBytes) ||
    (!!pageLimit && !!artifact.pageCount && artifact.pageCount > pageLimit);
}

function enforceOutputLimits(profile: CourtProfile, artifacts: BuildArtifact[]) {
  const oversized = artifacts.find((artifact) => artifact.mimeType !== "text/markdown" &&
    exceedsOutputLimit(profile, artifact));
  if (oversized) throw outputLimitError(profile, oversized);
}

function outputLimitError(profile: CourtProfile, artifact: BuildArtifact) {
  const byteLimit = profile.technical.maxOutputBytes;
  if (byteLimit && artifact.bytes.byteLength > byteLimit) {
    return new Error(`${artifact.filename} is larger than the court's ${Math.round(byteLimit / (1024 * 1024))} MB filing limit. Reduce that source file before building.`);
  }
  const pageLimit = profile.technical.maxOutputPages;
  return new Error(`${artifact.filename} exceeds the court's ${pageLimit}-page limit. Reduce or divide the source material before building.`);
}

async function buildCombinedVolume(
  profile: CourtProfile,
  plan: VolumePlan,
  cover: CoverValues,
  global: ReturnType<typeof numberVolumePlans>,
) {
  const output = await PDFDocument.create();
  const regular = await output.embedFont(StandardFonts.TimesRoman);
  const bold = await output.embedFont(StandardFonts.TimesRomanBold);
  const sans = await output.embedFont(StandardFonts.Helvetica);
  const sansBold = await output.embedFont(StandardFonts.HelveticaBold);
  await registerCourtPdfFonts(output, [regular, bold, sans, sansBold], { profile, cover,
    items: global.allItems.map(({ title, group, date, exhibitLabel }) =>
      ({ title, group, date, exhibitLabel })) }, profile.jurisdiction !== "ca");
  const indexItems = profile.technical.completeIndexEachVolume ? global.allItems : plan.items;
  const chunks = plannedIndexChunks(profile, indexItems);
  const indexPages = chunks.length;
  const localIds = new Set(plan.items.map(({ id }) => id));

  if (profile.cover.generated) {
    const sansCover = profile.cover.template === "abca-ap5";
    drawCourtCover(output.addPage(LETTER), sansCover ? sans : regular,
      sansCover ? sansBold : bold, profile, cover, {
        number: plan.number,
        count: plan.count,
      });
  }
  const indexTargets: IndexTarget[] = [];
  for (let index = 0; index < indexPages; index += 1) {
    const page = output.addPage(LETTER);
    drawIndexPage(
      page,
      regular,
      bold,
      sans,
      sansBold,
      profile,
      plan,
      chunks[index],
      global.ranges,
      localIds,
      indexTargets,
      index,
      indexPages,
    );
  }

  const outlines: Outline[] = [{ title: profile.technical.indexTitle ?? "Table of contents",
    pageIndex: profile.cover.generated ? 1 : 0 }];
  const groupOutlines = new Map<string, Outline>();
  for (const item of plan.items) {
    if (item.descriptionOnly && !item.descriptionLines) continue;
    const pageIndex = output.getPageCount();
    if (item.descriptionLines) {
      Array.from({ length: item.pageCount }, (_, index) =>
        item.descriptionLines!.slice(index * 36, (index + 1) * 36))
        .forEach((lines, index) => drawPhysicalExhibitDescription(
          output.addPage(LETTER), regular, bold, lines, index,
        ));
    } else if (item.entry) {
      const source = await PDFDocument.load(await fileBytes(
        item.entry.pdfRendition ?? item.entry.file,
      ));
      const sourceStart = item.sourcePageStart ?? 0;
      const sourceEnd = item.sourcePageEnd ?? source.getPageCount();
      const copied = await output.copyPages(source, source.getPageIndices().slice(sourceStart, sourceEnd));
      copied.forEach((page, localIndex) => {
        output.addPage(page);
        applyOcrText(page, sans, item.entry?.ocrTextByPage?.[sourceStart + localIndex]);
      });
    } else if (item.generated === "federal-form-344-certificate") {
      drawFederalForm344(output.addPage(LETTER), regular, bold, profile, cover);
    }
    const outline: Outline = {
      title: item.title,
      pageIndex,
      children: sourceOutlinesForItem(item, pageIndex),
    };
    if (item.group) {
      let group = groupOutlines.get(item.group);
      if (!group) {
        group = { title: item.group, pageIndex, children: [] };
        groupOutlines.set(item.group, group);
        outlines.push(group);
      }
      group.children!.push(outline);
    } else {
      outlines.push(outline);
    }
  }

  if (backCoverPageCount(profile, plan)) {
    const page = output.addPage(LETTER);
    page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(),
      color: hex(profile.cover.colourHex) });
    centredText(page, `VOLUME ${plan.number} OF ${plan.count}`, page.getHeight() / 2,
      bold, 12);
  }

  const numberFont = profile.technical.indexStyle === "abca" ? sans : regular;
  output.getPages().forEach((page, index) =>
    drawPageNumber(page, plan.startNumber + index, numberFont,
      profile.technical.pageNumberPosition, profile.technical.pageNumberSize,
      profile.technical.pageNumberInset, profile.technical.pageNumberOffset));
  for (const target of indexTargets) {
    addInternalLink(target.page, target.rect, output.getPage(target.targetPageIndex));
  }
  applyPageLabels(output, plan.startNumber);
  applyOutlines(output, outlines, profile.technical.bookmarksPanelOpen);
  setMetadata(output, profile.label);
  const bytes = await output.save();
  const base = outputFilename(profile, cover);
  const filename = plan.count > 1
    ? base.replace(/\.pdf$/iu, `-Volume-${plan.number}-of-${plan.count}.pdf`)
    : base;
  return pdfArtifact(filename, bytes, output.getPageCount());
}

function planVolumes(profile: CourtProfile, items: AssemblyItem[]): VolumePlan[] {
  const maxPages = profile.technical.maxOutputPages;
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0) + GENERATED_OVERHEAD_BYTES;
  const maxBytes = profile.technical.maxOutputBytes && totalBytes > profile.technical.maxOutputBytes
    ? Math.floor(profile.technical.maxOutputBytes * 0.92)
    : undefined;
  if (!maxPages && !maxBytes) return [{ items, startNumber: 1, number: 1, count: 1 }];
  const generatedTail = items.filter((item) => item.generated);
  const sourceItems = items.filter((item) => !item.generated);
  const volumes: AssemblyItem[][] = [];
  let current: AssemblyItem[] = [];
  let currentPages = 0;
  let currentBytes = GENERATED_OVERHEAD_BYTES;
  for (const item of sourceItems) {
    const front = (profile.cover.generated ? 1 : 0) +
      plannedIndexPageCount(profile, [...current, item]);
    const tooManyPages = maxPages !== undefined && current.length > 0 &&
      currentPages + item.pageCount + front > maxPages;
    const tooManyBytes = maxBytes !== undefined && current.length > 0 &&
      currentBytes + item.bytes > maxBytes;
    if (tooManyPages || tooManyBytes) {
      volumes.push(current);
      current = [];
      currentPages = 0;
      currentBytes = GENERATED_OVERHEAD_BYTES;
    }
    current.push(item);
    currentPages += item.pageCount;
    currentBytes += item.bytes;
  }
  if (current.length) volumes.push(current);
  if (!volumes.length) volumes.push([]);
  volumes[volumes.length - 1].push(...generatedTail);
  return volumes.map((volumeItems) => ({
    items: volumeItems,
    startNumber: 1,
    number: 1,
    count: volumes.length,
  }));
}

function frontPageCount(profile: CourtProfile, indexItems: AssemblyItem[]) {
  return (profile.cover.generated ? 1 : 0) +
    plannedIndexPageCount(profile, indexItems);
}

function backCoverPageCount(profile: CourtProfile, plan: VolumePlan) {
  return plan.count > 1 && profile.technical.volumeLabelOnBackCover ? 1 : 0;
}

function drawPhysicalExhibitDescription(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  lines: string[],
  index: number,
) {
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
  centredText(page, `DESCRIPTION OF PHYSICAL EXHIBIT${index ? " — CONTINUED" : ""}`,
    708, bold, 12);
  lines.forEach((text, lineIndex) => drawCourtPdfText(page, text, {
    x: 99.21, y: 660 - lineIndex * 16, font: regular, size: 12,
  }));
}

function drawIndexPage(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  sans: PDFFont,
  sansBold: PDFFont,
  profile: CourtProfile,
  plan: VolumePlan,
  items: AssemblyItem[],
  ranges: Map<string, { start: number; end: number }>,
  localIds: Set<string>,
  links: IndexTarget[],
  indexPage: number,
  indexPageCount: number,
) {
  if (profile.technical.indexStyle === "federal") {
    drawFederalIndexPage(page, regular, bold, profile, plan, items, ranges, localIds, links);
    return;
  }
  if (profile.technical.indexStyle === "abca") {
    drawAbcaIndexPage(page, sans, sansBold, profile, plan, items, ranges, localIds, links);
    return;
  }
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 44, y: height - 92, width: 8, height: 40,
    color: hex(profile.cover.colourHex) });
  drawCourtPdfText(page, profile.technical.indexTitle ?? "TABLE OF CONTENTS", {
    x: 64, y: height - 70, font: bold, size: 15,
  });
  const suffix = [plan.count > 1 ? `Volume ${plan.number} of ${plan.count}` : "",
    indexPageCount > 1 ? `Page ${indexPage + 1} of ${indexPageCount}` : ""]
    .filter(Boolean).join(" · ");
  if (suffix) drawRight(page, suffix, width - 48, height - 69, regular, 9, rgb(0.3, 0.3, 0.3));
  const top = height - 112;
  page.drawRectangle({ x: 48, y: top - 19, width: width - 96, height: 22,
    color: rgb(0.12, 0.14, 0.17) });
  page.drawText("TAB", { x: 56, y: top - 12, font: sansBold, size: 8, color: rgb(1, 1, 1) });
  drawCourtPdfText(page, profile.technical.indexDocumentLabel ?? "DOCUMENT", {
    x: 96, y: top - 12, font: sansBold, size: 8, color: rgb(1, 1, 1),
  });
  page.drawText("DATE", { x: 430, y: top - 12, font: sansBold, size: 8, color: rgb(1, 1, 1) });
  drawRight(page, "PAGE", width - 56, top - 12, sansBold, 8, rgb(1, 1, 1));
  let y = top - 37;
  let lastGroup: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== lastGroup) {
      page.drawRectangle({ x: 48, y: y - 3, width: width - 96, height: 18,
        color: rgb(0.94, 0.95, 0.96) });
      drawCourtPdfText(page, latin(item.group), { x: 56, y: y + 2, font: sansBold, size: 8,
        color: rgb(0.22, 0.24, 0.27) });
      y -= 21;
      lastGroup = item.group;
    }
    const range = indexRange(item, ranges);
    const rowTop = y + 10;
    const lines = item.indexLines ?? [latin(item.title)];
    const rowHeight = Math.max(24, lines.length * 11 + 13);
    const visible = !item.pageCount ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}–${range.end}`;
    page.drawText(item.indexParentId ? "" : String(item.tab), { x: 57, y, font: sans, size: 8.5 });
    lines.forEach((text, index) => drawCourtPdfText(page, text, {
      x: 96 + (item.indexParentId ? 12 : 0), y: y - index * 11, font: sans, size: 8.5,
    }));
    drawCourtPdfText(page, latin(item.date ?? ""), { x: 430, y, font: sans, size: 8.2 });
    drawRight(page, visible, width - 56, y, sans, 8.5, rgb(0.12, 0.12, 0.12));
    const bottom = y - (lines.length - 1) * 11 - 7;
    line(page, 48, bottom, width - 48, bottom, rgb(0.86, 0.87, 0.89), 0.5);
    if (item.pageCount && indexIsLocal(item, localIds)) links.push({
      page, rect: [48, bottom, width - 48, rowTop],
      targetPageIndex: range.start - plan.startNumber,
    });
    y -= rowHeight;
  }
}

function drawFederalIndexPage(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  plan: VolumePlan,
  items: AssemblyItem[],
  ranges: Map<string, { start: number; end: number }>,
  localIds: Set<string>,
  links: IndexTarget[],
) {
  const { width, height } = page.getSize();
  const left = 99.21;
  const right = width - left;
  const tabWidth = 48;
  const pageWidth = 50;
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  centredText(page, profile.technical.indexTitle ?? "TABLE OF CONTENTS", height - 78, bold, 12);
  let top = height - 110;
  const headerBottom = top - 24;
  page.drawRectangle({ x: left, y: headerBottom, width: right - left, height: 24,
    color: rgb(0.82, 0.82, 0.82), borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.7 });
  vertical(page, left + tabWidth, headerBottom, top);
  vertical(page, right - pageWidth, headerBottom, top);
  page.drawText("TAB", { x: left + 8, y: headerBottom + 7, font: bold, size: 12 });
  drawCourtPdfText(page, profile.technical.indexDocumentLabel ?? "DOCUMENT", {
    x: left + tabWidth + 8, y: headerBottom + 7, font: bold, size: 12,
  });
  drawRight(page, "PAGE", right - 8, headerBottom + 7, bold, 12, rgb(0.05, 0.05, 0.05));
  top = headerBottom;
  let lastGroup: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== lastGroup) {
      const bottom = top - 22;
      page.drawRectangle({ x: left, y: bottom, width: right - left, height: 22,
        color: rgb(0.93, 0.93, 0.93), borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.7 });
      centredText(page, latin(item.group), bottom + 6, bold, 12);
      top = bottom;
      lastGroup = item.group;
    }
    const range = indexRange(item, ranges);
    const lines = item.indexLines ?? [latin(item.title)];
    const rowHeight = Math.max(32, lines.length * 15 + 10);
    const bottom = top - rowHeight;
    page.drawRectangle({ x: left, y: bottom, width: right - left, height: rowHeight,
      borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.7 });
    vertical(page, left + tabWidth, bottom, top);
    vertical(page, right - pageWidth, bottom, top);
    centredAt(page, item.indexParentId ? "" : String(item.tab), left + (tabWidth / 2), top - 20,
      regular, 12);
    lines.forEach((text, index) => drawCourtPdfText(page, text, {
      x: left + tabWidth + 8 + (item.indexParentId ? 12 : 0),
      y: top - 20 - index * 15, font: regular, size: 12,
    }));
    const visible = !item.pageCount ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}-${range.end}`;
    centredAt(page, visible, right - (pageWidth / 2), top - 20, regular, 12);
    if (item.pageCount && indexIsLocal(item, localIds)) links.push({ page, rect: [left, bottom, right, top],
      targetPageIndex: range.start - plan.startNumber });
    top = bottom;
  }
}

function drawAbcaIndexPage(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  profile: CourtProfile,
  plan: VolumePlan,
  items: AssemblyItem[],
  ranges: Map<string, { start: number; end: number }>,
  localIds: Set<string>,
  links: IndexTarget[],
) {
  const { width, height } = page.getSize();
  const left = 76.08;
  const pageRight = 533.26;
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  centredAt(page, profile.technical.indexTitle ?? "Table of Contents", 315.35,
    height - 49.44, regular, 12);
  let y = height - 80.64;
  page.drawText("Page", { x: 512.64, y, font: regular, size: 12 });
  let lastGroup: string | undefined;
  let first = true;
  for (const item of items) {
    if (item.group && item.group !== lastGroup) {
      if (!first) y -= 32.4;
      centredAt(page, latin(item.group), 279.06, y, bold, 12);
      y -= first ? 33.12 : 39.84;
      lastGroup = item.group;
    } else if (first) y -= 33.12;
    else y -= 39.6;
    first = false;
    const range = indexRange(item, ranges);
    const lines = item.indexLines ?? [latin(item.title)];
    const top = y + 12;
    lines.forEach((text, index) => drawCourtPdfText(page, text, {
      x: left + (item.indexParentId ? 12 : 0), y: y - index * 16, font: regular, size: 12,
    }));
    const visible = !item.pageCount ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}-${range.end}`;
    drawRight(page, visible, pageRight, y, regular, 12, rgb(0.05, 0.05, 0.05));
    const bottom = y - (Math.max(1, lines.length) * 16) - 8;
    if (item.pageCount && indexIsLocal(item, localIds)) links.push({ page, rect: [left, bottom, pageRight, top],
      targetPageIndex: range.start - plan.startNumber });
    y -= Math.max(0, lines.length - 2) * 16;
  }
}

function centredText(page: PDFPage, value: string, y: number, font: PDFFont, size: number) {
  drawCourtPdfText(page, value, { x: (page.getWidth() - courtPdfTextWidth(value, font, size)) / 2,
    y, font, size });
}

function centredAt(
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
) {
  drawCourtPdfText(page, value, { x: x - (courtPdfTextWidth(value, font, size) / 2),
    y, font, size });
}

function vertical(page: PDFPage, x: number, bottom: number, top: number) {
  line(page, x, bottom, x, top, rgb(0.25, 0.25, 0.25), 0.7);
}

function drawPageNumber(
  page: PDFPage,
  number: number,
  font: PDFFont,
  position: CourtProfile["technical"]["pageNumberPosition"],
  size = 9,
  inset = 72,
  offset = 36,
) {
  const text = String(number);
  const textWidth = font.widthOfTextAtSize(text, size);
  const { width, height } = page.getSize();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const top = position.startsWith("top");
  const right = position.endsWith("right");
  if (angle === 90) {
    page.drawText(text, {
      x: top ? width - offset : offset,
      y: right ? height - inset - textWidth : (height - textWidth) / 2,
      size,
      font,
      rotate: degrees(90),
      color: rgb(0.12, 0.12, 0.12),
    });
  } else if (angle === 180) {
    page.drawText(text, {
      x: right ? inset + textWidth : (width + textWidth) / 2,
      y: top ? offset : height - offset,
      size,
      font,
      rotate: degrees(180),
      color: rgb(0.12, 0.12, 0.12),
    });
  } else if (angle === 270) {
    page.drawText(text, {
      x: top ? offset : width - offset,
      y: right ? inset + textWidth : (height + textWidth) / 2,
      size,
      font,
      rotate: degrees(270),
      color: rgb(0.12, 0.12, 0.12),
    });
  } else {
    page.drawText(text, {
      x: right ? width - inset - textWidth : (width - textWidth) / 2,
      y: top ? height - offset : offset,
      size,
      font,
      color: rgb(0.12, 0.12, 0.12),
    });
  }
}

function applyOcrText(page: PDFPage, font: PDFFont, value?: string) {
  if (!value?.trim()) return;
  const text = latin(value).slice(0, 60_000);
  const chunks = text.match(/[\s\S]{1,1800}/gu) ?? [];
  chunks.forEach((chunk, index) => page.drawText(chunk, {
    x: 1,
    y: 1 + (index % 4),
    size: 1,
    lineHeight: 1,
    maxWidth: Math.max(1, page.getWidth() - 2),
    font,
    opacity: 0,
  }));
}

function sourceOutlines(bookmarks: SourceBookmark[] | undefined, offset: number): Outline[] {
  return (bookmarks ?? []).flatMap((bookmark) => bookmark.pageIndex < 0 ? [] : [{
    title: bookmark.title,
    pageIndex: offset + bookmark.pageIndex,
    children: sourceOutlines(bookmark.children, offset),
  }]);
}

function sourceOutlinesForItem(item: AssemblyItem, offset: number): Outline[] {
  const start = item.sourcePageStart ?? 0;
  const end = item.sourcePageEnd ?? item.entry?.pageCount ?? item.pageCount;
  const select = (bookmarks: SourceBookmark[] | undefined): Outline[] =>
    (bookmarks ?? []).flatMap((bookmark) => {
      const children = select(bookmark.children);
      if (bookmark.pageIndex < start || bookmark.pageIndex >= end) return children;
      return [{
        title: bookmark.title,
        pageIndex: offset + bookmark.pageIndex - start,
        children,
      }];
    });
  return select(item.entry?.sourceBookmarks);
}

function applyPageLabels(document: PDFDocument, start: number) {
  const labels = document.context.obj({
    Nums: [0, document.context.obj({ S: "D", St: start })],
  });
  document.catalog.set(PDFName.of("PageLabels"), document.context.register(labels));
}

function applyOutlines(document: PDFDocument, outlines: Outline[], open: boolean) {
  const valid = outlines.filter((outline) =>
    outline.pageIndex >= 0 && outline.pageIndex < document.getPageCount());
  if (!valid.length) return;
  const root = document.context.obj({ Type: "Outlines" });
  const rootRef = document.context.register(root);
  const branch = outlineBranch(document, valid, rootRef);
  root.set(PDFName.of("First"), branch.first);
  root.set(PDFName.of("Last"), branch.last);
  root.set(PDFName.of("Count"), document.context.obj(branch.count));
  document.catalog.set(PDFName.of("Outlines"), rootRef);
  if (open) document.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

function outlineBranch(document: PDFDocument, outlines: Outline[], parent: PDFRef) {
  const nodes = outlines.map((outline) => {
    const page = document.getPage(Math.min(outline.pageIndex, document.getPageCount() - 1));
    const dict = document.context.obj({
      Title: PDFHexString.fromText(outline.title.slice(0, 300)),
      Parent: parent,
      Dest: [page.ref, "Fit"],
    });
    return { outline, dict, ref: document.context.register(dict), descendants: 0 };
  });
  nodes.forEach((node, index) => {
    if (index) node.dict.set(PDFName.of("Prev"), nodes[index - 1].ref);
    if (index + 1 < nodes.length) node.dict.set(PDFName.of("Next"), nodes[index + 1].ref);
    const children = node.outline.children?.filter((child) =>
      child.pageIndex >= 0 && child.pageIndex < document.getPageCount()) ?? [];
    if (children.length) {
      const branch = outlineBranch(document, children, node.ref);
      node.dict.set(PDFName.of("First"), branch.first);
      node.dict.set(PDFName.of("Last"), branch.last);
      node.dict.set(PDFName.of("Count"), document.context.obj(branch.count));
      node.descendants = branch.count;
    }
  });
  return {
    first: nodes[0].ref,
    last: nodes[nodes.length - 1].ref,
    count: nodes.reduce((sum, node) => sum + 1 + node.descendants, 0),
  };
}

function addInternalLink(
  page: PDFPage,
  [x1, y1, x2, y2]: [number, number, number, number],
  target: PDFPage,
) {
  const annotation = page.doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [x1, y1, x2, y2],
    Border: [0, 0, 0],
    Dest: [target.ref, "Fit"],
  });
  page.node.addAnnot(page.doc.context.register(annotation));
}

function setMetadata(document: PDFDocument, title: string) {
  document.setTitle(title);
  document.setSubject("Court filing record assembled from user-selected source PDFs");
  document.setCreator("Beaver Court Record Builder");
  document.setProducer("Beaver Court Record Builder · pdf-lib");
  const preferences = document.catalog.getOrCreateViewerPreferences();
  preferences.setDisplayDocTitle(true);
  document.catalog.set(PDFName.of("Lang"), PDFHexString.fromText("en-CA"));
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

function drawRight(
  page: PDFPage,
  text: string,
  right: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  drawCourtPdfText(page, text, { x: right - courtPdfTextWidth(text, font, size),
    y, font, size, color });
}

function line(
  page: PDFPage,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  color: ReturnType<typeof rgb>,
  thickness: number,
) {
  page.drawLine({ start: { x: startX, y: startY }, end: { x: endX, y: endY },
    color, thickness });
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (let word of words) {
    const next = current ? `${current} ${word}` : word;
    if (courtPdfTextWidth(next, font, size) <= maxWidth) { current = next; continue; }
    if (current) lines.push(current);
    while (courtPdfTextWidth(word, font, size) > maxWidth) {
      let split = 1;
      while (split < word.length &&
        courtPdfTextWidth(word.slice(0, split + 1), font, size) <= maxWidth) split += 1;
      lines.push(word.slice(0, split));
      word = word.slice(split);
    }
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function hex(value: string) {
  const match = value.match(/^#([0-9a-f]{6})$/iu);
  if (!match) return rgb(1, 1, 1);
  const number = Number.parseInt(match[1], 16);
  return rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}
