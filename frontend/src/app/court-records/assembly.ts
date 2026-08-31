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
import { acceptedSourceFormats, DOCX_MIME, sourceFormat } from "./formats";
import { indexChunks, indexPageCount } from "./layout";
import { outputFilename, sortedEntries, validateCourtRecord } from "./validation";
import { exhibitName } from "./types";
import type {
  BuildArtifact,
  BuildResult,
  CourtProfile,
  CourtRecordReceipt,
  CoverValues,
  RecordEntry,
  SourceBookmark,
} from "./types";
import { canonicalJson } from "../../../../shared/canonical-json.cjs";

const LETTER: [number, number] = [612, 792];
const GENERATED_OVERHEAD_BYTES = 160_000;

type Progress = (message: string, completed: number, total: number) => void;

type AssemblyItem = {
  id: string;
  kindId: string;
  title: string;
  baseTitle?: string;
  description: string;
  group?: string;
  date?: string;
  pageCount: number;
  bytes: number;
  entry?: RecordEntry;
  sourcePageStart?: number;
  sourcePageEnd?: number;
  generated?: "fca-form-344-certificate" | "exhibit-certificate";
  exhibitLabel?: string;
  descriptionOnly?: boolean;
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
  const { profile, cover } = input;
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
      if (!kind.descriptionOnly) throw new Error(`${entry.title} requires a source file.`);
      continue;
    }
    const format = sourceFormat(entry.file);
    if (!format || !acceptedSourceFormats(kind).includes(format)) {
      throw new Error(`${entry.file.name} is not an accepted source format for ${kind.label}.`);
    }
    if (profile.outputMode !== "separate-files" &&
        sourceFormat(entry.pdfRendition ?? entry.file) !== "pdf") {
      throw new Error("Combined court records require prepared PDF sources.");
    }
  }
  const uploadItems = entries.map<AssemblyItem>((entry) => {
    const kind = allowedKinds.get(entry.kindId);
    return {
      id: entry.id,
      kindId: entry.kindId,
      title: entry.title.trim() || kind!.label,
      baseTitle: entry.title.trim() || kind!.label,
      description: kind!.description,
      group: kind!.group,
      date: entry.date,
      pageCount: entry.pageCount ?? 0,
      bytes: entry.descriptionOnly ? 0 : (entry.pdfRendition ?? entry.file).size,
      entry: entry.descriptionOnly ? undefined : entry,
      descriptionOnly: entry.descriptionOnly,
    };
  });
  const generated = profile.documentKinds.flatMap<AssemblyItem>((kind) => kind.generated ? [{
    id: `generated:${kind.id}`,
    kindId: kind.id,
    title: kind.label,
    description: kind.description,
    group: kind.group,
    pageCount: 1,
    bytes: 0,
    generated: kind.generated,
  }] : []);
  const order = new Map(profile.documentKinds.map((kind) => [kind.id, kind.order]));
  const items = [...uploadItems, ...generated].sort((left, right) =>
    (order.get(left.kindId) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.kindId) ?? Number.MAX_SAFE_INTEGER));

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

  let outputArtifacts: BuildArtifact[];
  if (profile.outputMode === "separate-files") {
    outputArtifacts = await buildSeparateFiles(profile, entries, input.onProgress);
  } else if (profile.outputMode === "affidavit-with-exhibits") {
    outputArtifacts = [await buildAffidavit(profile, entries, cover, input.onProgress)];
  } else {
    outputArtifacts = await buildMeasuredVolumes(profile, items, cover, input.onProgress);
  }
  outputArtifacts = outputArtifacts.map((artifact, index) => ({
    ...artifact,
    role: outputRole(profile, entries, index),
  }));

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
    automatic_steps: automaticSteps(profile, entries, outputArtifacts.length),
    needs_attention: input.needsAttention ?? [],
  };
  input.onProgress?.("Record ready", 1, 1);
  return { artifacts: outputArtifacts, receipt };
}

function outputRole(profile: CourtProfile, entries: RecordEntry[], index: number) {
  if (profile.outputMode !== "separate-files") return index ? `record-${index + 1}` : "record";
  const entry = entries[index];
  if (!entry) return `file-${index + 1}`;
  const occurrence = entries.slice(0, index + 1).filter((item) => item.kindId === entry.kindId).length;
  const repeated = entries.filter((item) => item.kindId === entry.kindId).length > 1;
  return repeated ? `${entry.kindId}-${occurrence}` : entry.kindId;
}

async function buildSeparateFiles(
  profile: CourtProfile,
  entries: RecordEntry[],
  progress?: Progress,
) {
  const artifacts: BuildArtifact[] = [];
  const filenames = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    progress?.(`Preparing ${entry.title}`, index, entries.length);
    const format = sourceFormat(entry.file);
    if (!format) throw new Error(`${entry.file.name} is not a supported filing artifact.`);
    const raw = await fileBytes(entry.file);
    const filename = uniqueFilename(entry.file.name, filenames);
    if (format === "docx") {
      artifacts.push(await fileArtifact(filename, DOCX_MIME, raw));
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
  return artifacts;
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
  const outlines: Outline[] = [];
  let pageNumber = 1;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    progress?.(`Adding ${entry.title}`, entryIndex, entries.length);
    if (entry.kindId === "exhibit" && profile.exhibitCertificate) {
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
  const plans = planVolumes(profile, items);
  const maximumSplits = items.reduce((sum, item) => sum + item.pageCount, 0) + 1;
  for (let attempt = 0; attempt < maximumSplits; attempt += 1) {
    numberVolumePlans(profile, plans);
    const artifacts: BuildArtifact[] = [];
    for (const plan of plans) {
      progress?.(
        plan.count > 1 ? `Building volume ${plan.number} of ${plan.count}` : "Building the record",
        plan.number - 1,
        plan.count,
      );
      artifacts.push(await buildCombinedVolume(profile, plan, cover));
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

function numberVolumePlans(profile: CourtProfile, plans: VolumePlan[]) {
  let nextNumber = 1;
  plans.forEach((plan, index) => {
    plan.startNumber = nextNumber;
    plan.number = index + 1;
    plan.count = plans.length;
    nextNumber += volumePageCount(profile, plan.items);
  });
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
) {
  const output = await PDFDocument.create();
  const regular = await output.embedFont(StandardFonts.TimesRoman);
  const bold = await output.embedFont(StandardFonts.TimesRomanBold);
  const sans = await output.embedFont(StandardFonts.Helvetica);
  const sansBold = await output.embedFont(StandardFonts.HelveticaBold);
  const chunks = indexChunks(plan.items, profile.technical.indexRowsPerPage);
  const indexPages = chunks.length;
  const frontPages = (profile.cover.generated ? 1 : 0) + indexPages;
  const ranges = new Map<string, { start: number; end: number }>();
  let next = plan.startNumber + frontPages;
  for (const item of plan.items) {
    ranges.set(item.id, { start: next, end: next + item.pageCount - 1 });
    next += item.pageCount;
  }

  if (profile.cover.generated) {
    const sansCover = profile.cover.template === "abca-ap5";
    drawCourtCover(output.addPage(LETTER), sansCover ? sans : regular,
      sansCover ? sansBold : bold, profile, cover, plan);
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
      ranges,
      indexTargets,
      index,
      indexPages,
    );
  }

  const outlines: Outline[] = [{ title: profile.technical.indexTitle ?? "Table of contents",
    pageIndex: profile.cover.generated ? 1 : 0 }];
  const groupOutlines = new Map<string, Outline>();
  for (const item of plan.items) {
    if (item.descriptionOnly) continue;
    const pageIndex = output.getPageCount();
    if (item.entry) {
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
    } else if (item.generated === "fca-form-344-certificate") {
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
      indexPageCount([...current, item], profile.technical.indexRowsPerPage);
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

function volumePageCount(profile: CourtProfile, items: AssemblyItem[]) {
  return (profile.cover.generated ? 1 : 0) +
    indexPageCount(items, profile.technical.indexRowsPerPage) +
    items.reduce((sum, item) => sum + item.pageCount, 0);
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
  links: IndexTarget[],
  indexPage: number,
  indexPageCount: number,
) {
  if (profile.technical.indexStyle === "federal") {
    drawFederalIndexPage(page, regular, bold, profile, plan, items, ranges, links);
    return;
  }
  if (profile.technical.indexStyle === "abca") {
    drawAbcaIndexPage(page, sans, sansBold, profile, plan, items, ranges, links);
    return;
  }
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 44, y: height - 92, width: 8, height: 40,
    color: hex(profile.cover.colourHex) });
  page.drawText(profile.technical.indexTitle ?? "TABLE OF CONTENTS", {
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
  page.drawText(profile.technical.indexDocumentLabel ?? "DOCUMENT", {
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
      page.drawText(latin(item.group), { x: 56, y: y + 2, font: sansBold, size: 8,
        color: rgb(0.22, 0.24, 0.27) });
      y -= 21;
      lastGroup = item.group;
    }
    const range = ranges.get(item.id)!;
    const rowTop = y + 10;
    const title = truncate(latin(item.title), sans, 8.5, 322);
    const visible = item.descriptionOnly ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}–${range.end}`;
    page.drawText(String(plan.items.indexOf(item) + 1), { x: 57, y, font: sans, size: 8.5 });
    page.drawText(title, { x: 96, y, font: sans, size: 8.5 });
    page.drawText(latin(item.date ?? ""), { x: 430, y, font: sans, size: 8.2 });
    drawRight(page, visible, width - 56, y, sans, 8.5, rgb(0.12, 0.12, 0.12));
    line(page, 48, y - 7, width - 48, y - 7, rgb(0.86, 0.87, 0.89), 0.5);
    if (!item.descriptionOnly) links.push({
      page, rect: [48, y - 7, width - 48, rowTop],
      targetPageIndex: range.start - plan.startNumber,
    });
    y -= 24;
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
  page.drawText(profile.technical.indexDocumentLabel ?? "DOCUMENT", {
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
    const range = ranges.get(item.id)!;
    const description = `${latin(item.title)}${item.date ? `, dated ${latin(item.date)}` : ""}`;
    const lines = wrap(description, regular, 12, right - pageWidth - left - tabWidth - 16).slice(0, 2);
    const rowHeight = Math.max(32, lines.length * 15 + 10);
    const bottom = top - rowHeight;
    page.drawRectangle({ x: left, y: bottom, width: right - left, height: rowHeight,
      borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.7 });
    vertical(page, left + tabWidth, bottom, top);
    vertical(page, right - pageWidth, bottom, top);
    centredAt(page, String(plan.items.indexOf(item) + 1), left + (tabWidth / 2), top - 20,
      regular, 12);
    lines.forEach((text, index) => page.drawText(text, {
      x: left + tabWidth + 8, y: top - 20 - index * 15, font: regular, size: 12,
    }));
    const visible = item.descriptionOnly ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}-${range.end}`;
    centredAt(page, visible, right - (pageWidth / 2), top - 20, regular, 12);
    if (!item.descriptionOnly) links.push({ page, rect: [left, bottom, right, top],
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
    const range = ranges.get(item.id)!;
    const description = `${latin(item.title)}${item.date ? `, dated ${latin(item.date)}` : ""}`;
    const lines = wrap(description, regular, 12, 366).slice(0, 2);
    const top = y + 12;
    lines.forEach((text, index) => page.drawText(text, {
      x: left, y: y - index * 16, font: regular, size: 12,
    }));
    const visible = item.descriptionOnly ? "" : range.start === range.end
      ? `${range.start}` : `${range.start}-${range.end}`;
    drawRight(page, visible, pageRight, y, regular, 12, rgb(0.05, 0.05, 0.05));
    const bottom = y - (Math.max(1, lines.length) * 16) - 8;
    if (!item.descriptionOnly) links.push({ page, rect: [left, bottom, pageRight, top],
      targetPageIndex: range.start - plan.startNumber });
  }
}

function centredText(page: PDFPage, value: string, y: number, font: PDFFont, size: number) {
  page.drawText(value, { x: (page.getWidth() - font.widthOfTextAtSize(value, size)) / 2,
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
  page.drawText(value, { x: x - (font.widthOfTextAtSize(value, size) / 2), y, font, size });
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
      x: top ? width - 20 : 12,
      y: right ? height - 36 - textWidth : (height - textWidth) / 2,
      size,
      font,
      rotate: degrees(90),
      color: rgb(0.12, 0.12, 0.12),
    });
  } else if (angle === 180) {
    page.drawText(text, {
      x: right ? 36 + textWidth : (width + textWidth) / 2,
      y: top ? 12 : height - 20,
      size,
      font,
      rotate: degrees(180),
      color: rgb(0.12, 0.12, 0.12),
    });
  } else if (angle === 270) {
    page.drawText(text, {
      x: top ? 12 : width - 20,
      y: right ? 36 + textWidth : (height + textWidth) / 2,
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
    "Linked each generated table-of-contents row to its document",
  ];
  if (profile.outputMode === "separate-files" && entries.some((entry) => sourceFormat(entry.file) === "docx")) {
    steps.push("Preserved editable Word filing artifacts byte-for-byte");
  }
  if (entries.some((entry) => entry.ocrTextByPage?.some(Boolean))) {
    steps.push("Added locally recognized text to source pages selected for OCR");
  }
  if (profile.exhibitCertificate) {
    steps.push("Inserted an exhibit certificate before each exhibit");
  }
  if (profile.documentKinds.some((kind) => kind.generated === "fca-form-344-certificate")) {
    steps.push("Generated the Form 344 certificate for signature");
  }
  if (volumes > 1) steps.push(`Split the record into ${volumes} continuously numbered volumes`);
  return steps;
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

function uniqueFilename(filename: string, used: Map<string, number>) {
  const key = filename.toLocaleLowerCase("en-CA");
  const next = (used.get(key) ?? 0) + 1;
  used.set(key, next);
  if (next === 1) return filename;
  return filename.replace(/(\.[^.]+)$/u, `-${next}$1`);
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
  page.drawText(text, { x: right - font.widthOfTextAtSize(text, size), y, font, size, color });
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
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !current) current = next;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let value = text;
  while (value && font.widthOfTextAtSize(`${value}…`, size) > maxWidth) value = value.slice(0, -1);
  return `${value.trimEnd()}…`;
}

function latin(value: string) {
  return value.normalize("NFKC")
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[–—]/gu, "-")
    .replace(/…/gu, "...")
    .split(/\r?\n/u)
    .map((line) => line.replace(/[^\x20-\x7e\u00a0-\u00ff]/gu, "?"))
    .join("\n");
}

function hex(value: string) {
  const match = value.match(/^#([0-9a-f]{6})$/iu);
  if (!match) return rgb(1, 1, 1);
  const number = Number.parseInt(match[1], 16);
  return rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}
