import * as pdfLibrary from "pdf-lib";
import { pdfAssembly } from "./pdfAssembly";
import { renderAuthoritiesBook, fit, pdfNormalized, pdfText, wrapped,
  type BookRow, type PreparedAuthoritiesBook } from "./authoritiesBook";
const { addInternalLink: addLink, applyOutlines, appendPages } = pdfAssembly(pdfLibrary);
import { footnotePropositions, markedQuotations, singleSourceFootnote } from "./authoritiesQuotations";
import { legalSourceLocatorAnchor, sourceUrl as legalSourceUrl } from "./legalSourceLinks";
import type { A2AJLocatorKind } from "./legalSources/a2aj";
import {
  authoritiesBookPdfs,
  attachedAuthoritySources,
  authoritiesProfile,
  validateAuthoritiesDraft,
  authorityCitationForms,
  federalEnactmentCitation,
  hasBilingualAuthoritySource,
  type AttachedAuthoritySource,
  type AuthoritiesBookParts,
  type AuthoritiesBoundPdf,
  type AuthoritiesDraft,
  type AuthoritiesDocumentSnapshot,
  type AuthoritiesSettings,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthoritySourceDecision,
  type AuthoritySourceIdentity,
} from "./authoritiesDomain";
import { annotationSetForSource } from "mike/shared/pdf-annotations.mjs";
import { initialAuthorityAnnotations, writeAuthorityAnnotations } from "./authoritiesAnnotations";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { applyTableOfAuthorities, type DocxAuthorityMark } from "./docxOperations";
import type { NativePdfPassageGeometry, NativePdfPassageTarget } from "./structureNative";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput } from "./workProduct";
import { authorityProcedureInput, deriveAuthorityProcedure, tabLabel } from "mike/shared/authorities-order.mjs";

export type AuthoritiesOutputRole = "table" | "book" | `book-${number}` |
  "annotated-document";
export type AuthoritiesBuildArtifact = {
  role: AuthoritiesOutputRole;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  pageCount: number | null;
  receipt: WorkProductBuildReceipt;
};
export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  workProduct: { id: string; kind: "authorities"; revision: number };
  inputs: WorkProductBuildReceipt["inputs"];
  draft: { schemaVersion: AuthoritiesDraft["schemaVersion"];
    outputMode: AuthoritiesDraft["outputMode"];
    settings: AuthoritiesSettings;
    cover: AuthoritiesDraft["cover"];
    bookParts: AuthoritiesBookParts;
    insertIntoDocument: boolean;
    document: AuthoritiesDocumentSnapshot | null };
  authorities: Array<{
    id: string; key: string; kind: AuthorityKind; citation: string; name: string;
    tab: string; excluded: boolean; source: AuthoritySourceDecision;
    sourceIdentity: AuthoritySourceIdentity | null;
    evidenceIds: string[]; locators: Array<{ kind: string; label: string }>;
    bindings: WorkProductInput[];
  }>;
  outputs: Partial<Record<AuthoritiesOutputRole, {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
export type AuthoritiesBuildResult = {
  artifacts: Partial<Record<AuthoritiesOutputRole, AuthoritiesBuildArtifact>>;
  receipt: AuthoritiesBuildReceipt;
};
export type AuthoritiesBuildInput = {
  draft: AuthoritiesDraft;
  title: string;
  workProduct: { id: string; revision: number };
  sources?: Record<string, { bytes?: Uint8Array; resolved?: ResolvedWorkProductInput;
    pageTextByPage?: string[]; ocrTextByPage?: string[];
    passageGeometry?: NativePdfPassageGeometry }>;
  signal?: AbortSignal;
};

export type AuthorityPassageRequest = {
  locators: Array<{ kind: "paragraph" | "section" | "page"; label: string }>;
  exactQuotes: string[];
};

/** Explicit source locators and exact quoted passages tied to each citation context. */
export function authorityPassageRequests(draft: AuthoritiesDraft, authorityId: string) {
  const quoteByFootnote = footnotePropositions(draft.units), requests: AuthorityPassageRequest[] = [];
  const valid = (locator: { kind: string; label: string }): locator is AuthorityPassageRequest["locators"][number] =>
    ["paragraph", "section", "page"].includes(locator.kind) && !!locator.label.trim();
  const authority = draft.authorities[authorityId];
  const direct = authority?.locators.filter(valid) ?? [];
  if (direct.length) requests.push({ locators: direct, exactQuotes: [] });
  for (const occurrence of Object.values(draft.occurrences)) {
    if (occurrence.authorityId !== authorityId) continue;
    const locators = occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text }))
      .filter(valid);
    if (!locators.length) continue;
    const unit = draft.units.find(({ id }) => id === occurrence.unitId);
    requests.push({ locators, exactQuotes: unit?.footnoteId && singleSourceFootnote(draft, unit)?.id === occurrence.id
      ? markedQuotations(quoteByFootnote.get(unit.footnoteId)?.text ?? "") : [] });
  }
  return requests;
}

export function authorityPassageTargets(draft: AuthoritiesDraft, authorityId: string) {
  const grouped = new Map<string, Omit<NativePdfPassageTarget, "id"> & { quotes: Set<string> }>();
  for (const request of authorityPassageRequests(draft, authorityId)) {
    for (const locator of request.locators) {
      const key = `${locator.kind}\0${locator.label}`;
      const target = grouped.get(key) ?? { locatorKind: locator.kind, locator: locator.label,
        quotes: new Set<string>() };
      request.exactQuotes.forEach((quote) => target.quotes.add(quote)); grouped.set(key, target);
    }
  }
  return [...grouped.values()].flatMap(({ quotes, ...target }) => {
    const values = [...quotes];
    return Array.from({ length: Math.max(1, Math.ceil(values.length / 20)) }, (_, index) =>
      ({ ...target, exactQuotes: values.slice(index * 20, index * 20 + 20) }));
  }).map((target, index) => ({ id: `passage:${index + 1}`, ...target }));
}

export function authoritiesTextRoles(draft: AuthoritiesDraft) {
  if (draft.outputMode === "table") return new Set<string>();
  const federal = authoritiesProfile(draft.settings.profileId).requirements?.federalFormatting;
  return new Set(Object.values(draft.authorities).flatMap((authority) => {
    if (authority.excluded || authority.source.kind !== "attached") return [];
    const paperExtract = federal && draft.settings.filingMedium === "paper" &&
      freePublicDatabaseReference(authority);
    const requests = authorityPassageRequests(draft, authority.id);
    const locatorKinds = new Set(requests.flatMap(({ locators }) =>
      locators.map(({ kind }) => kind)));
    const needsOcr = draft.settings.scannedPdfPolicy !== "page-margin";
    const needsLocatorText = draft.settings.passageMarking !== "none" &&
      (locatorKinds.has("paragraph") || locatorKinds.has("section"));
    const needsQuoteText = ["margin", "text"].includes(draft.settings.passageMarking) &&
      requests.some(({ exactQuotes }) => exactQuotes.length);
    return authority.source.sources.flatMap(source => {
      const saved = annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
      return paperExtract || needsOcr || !saved && (needsLocatorText || needsQuoteText)
        ? [source.bindingRole] : [];
    });
  }));
}

type BareArtifact = Omit<AuthoritiesBuildArtifact, "receipt">;

type Entry = {
  authority: AuthorityIdentity;
  name: string;
  citedAt: string;
  tab: string;
  sourceUrl: string | null;
};
type Group = { label: string; entries: Entry[] };
type PdfModule = typeof import("pdf-lib");
type PdfDocument = import("pdf-lib").PDFDocument;
type PdfPage = import("pdf-lib").PDFPage;

type RequestedRole = Exclude<AuthoritiesOutputRole, `book-${number}`>;
const RENDERERS: Record<RequestedRole, string> = {
  table: "beaver.authorities.table-docx.v1",
  book: "beaver.authorities.book-pdf.v3",
  "annotated-document": "beaver.authorities.filing-output.v1",
};

function authorityName(draft: AuthoritiesDraft, authority: AuthorityIdentity) {
  const forms = authorityCitationForms(draft, authority.id), values: string[] = [];
  const add = (value: string | null | undefined) => {
    const exact = value?.trim();
    if (!exact || values.some((item) => item.toLocaleLowerCase("en-CA")
      .includes(exact.toLocaleLowerCase("en-CA")))) return;
    values.push(exact);
  };
  const heading = authority.displayName ?? authority.name;
  if (!heading || !forms.some((form) => form.toLocaleLowerCase("en-CA")
    .includes(heading.trim().toLocaleLowerCase("en-CA")))) add(heading);
  forms.forEach(add);
  return values.join(", ");
}

function citedPages(draft: AuthoritiesDraft, authorityId: string) {
  return [...new Set(draft.units.flatMap((unit) => unit.occurrenceIds.some((id) =>
    draft.occurrences[id]?.authorityId === authorityId) ? unit.pageNumbers : []))]
    .sort((left, right) => left - right).join(", ");
}

function citedPinpoints(draft: AuthoritiesDraft, authorityId: string) {
  const labels = Object.values(draft.occurrences).flatMap((occurrence) =>
    occurrence.authorityId === authorityId ? occurrence.pinpoints.map(({ kind, text }) =>
      `${kind === "paragraph" ? "para" : kind === "section" ? "s" : "p"} ${text}`) : []);
  return [...new Set(labels)].join(", ");
}

function citedAt(draft: AuthoritiesDraft, authorityId: string) {
  const pages = citedPages(draft, authorityId), pinpoints = citedPinpoints(draft, authorityId);
  const value = draft.settings.tableLocation === "pages" ? pages
    : draft.settings.tableLocation === "pinpoints" ? pinpoints
      : [pages, pinpoints].filter(Boolean).join("; ");
  return value || "—";
}

const reproducedInBook = (draft: AuthoritiesDraft, authority: AuthorityIdentity) =>
  !authority.excluded && (authority.source.kind === "attached" ||
    (draft.settings.allowIncomplete || draft.settings.missingSourcePolicy === "placeholder"));

const authorityProcedure = (draft: AuthoritiesDraft, purpose: "table" | "book") =>
  deriveAuthorityProcedure(authorityProcedureInput(draft, {
    purpose, reproduced: (authority) => reproducedInBook(draft, authority),
  }));

function authoritySourceUrl(authority: AuthorityIdentity) {
  const value = authority.source.kind === "attached"
    ? authority.source.sources.find(({ sourceUrl }) => sourceUrl)?.sourceUrl ?? null
    : authority.source.kind === "pending-canlii" ? authority.source.pageUrl
      : authority.sourceIdentity?.externalUrl ?? null;
  if (!value) return null;
  // Same canonicalization every other legal link gets: the Decisia iframe and
  // mobile parameters without which the document text never renders, the
  // CanLII PDF and Justice Laws path rewrites, and the pinpoint anchor when
  // the authority cites exactly one.
  const [locator] = authority.locators;
  const only = authority.locators.length === 1 && locator &&
    ["paragraph", "page", "section"].includes(locator.kind)
    ? legalSourceLocatorAnchor(value, locator.kind as A2AJLocatorKind, locator.label)
    : undefined;
  return legalSourceUrl(value, only);
}

function freePublicDatabaseReference(authority: AuthorityIdentity) {
  if (authority.kind !== "case") return null;
  const value = authoritySourceUrl(authority);
  if (!value) return null;
  const host = new URL(value).hostname.toLowerCase().replace(/\.+$/u, "");
  const canlii = ["canlii.ca", "canlii.org"].some((domain) =>
    host === domain || host.endsWith(`.${domain}`));
  return authority.sourceIdentity?.provider === "a2aj" || canlii
    ? { url: value, host } : null;
}

function groupedEntries(draft: AuthoritiesDraft, purpose: "table" | "book") {
  const planned = authorityProcedure(draft, purpose);
  const entry = ({ id, tab }: typeof planned[number]): Entry => {
    const authority = draft.authorities[id]; return { authority,
    name: authorityName(draft, authority), citedAt: citedAt(draft, authority.id),
    tab, sourceUrl: authoritySourceUrl(authority) }; };
  return [...new Set(planned.map(({ group }) => group))].map((label): Group =>
    ({ label, entries: planned.filter(({ group }) => group === label).map(entry) }));
}

async function tableArtifact(groups: Group[], filename: string, subtitle: string,
  linked = false, tabs = false) {
  const { BorderStyle, Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph,
    Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const border = { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" };
  const cell = (value: string, width: number, bold = false) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: value, bold, size: 19 })] })],
  });
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [
    new Paragraph({ text: linked ? "TABLE OF AUTHORITIES" : "Table of Authorities",
      heading: HeadingLevel.TITLE }),
    ...(linked ? [] : [new Paragraph({ children: [new TextRun({ text: subtitle, italics: true,
      color: "666666", size: 22 })] })]),
  ];
  if (!groups.length) children.push(new Paragraph("No authorities."));
  if (linked) groups.flatMap(({ entries }) => entries).forEach((entry, index) => {
    children.push(new Paragraph({ children: [new TextRun(`${index + 1}. `),
      ...(entry.sourceUrl ? [new ExternalHyperlink({ link: entry.sourceUrl,
        children: [new TextRun({ text: entry.name, style: "Hyperlink" })] })]
        : [new TextRun(entry.name)])] }));
  });
  else for (const group of groups) {
    children.push(new Paragraph({ text: group.label, heading: HeadingLevel.HEADING_1,
      keepNext: true }));
    children.push(new Table({ width: { size: 9360, type: WidthType.DXA },
      borders: { top: border, bottom: border, left: border, right: border,
        insideHorizontal: border, insideVertical: border }, rows: [
        new TableRow({ tableHeader: true, children: [
          ...(tabs ? [cell("Tab", 1050, true)] : []),
          cell("Authority", tabs ? 4800 : 5850, true),
          cell("Cited at", 1850, true), cell("Source", 1660, true),
        ] }),
        ...group.entries.map((entry) => new TableRow({ cantSplit: true, children: [
          ...(tabs ? [cell(entry.tab, 1050)] : []),
          cell(entry.name, tabs ? 4800 : 5850), cell(entry.citedAt, 1850),
          new TableCell({ width: { size: 1660, type: WidthType.DXA }, children: [
            new Paragraph({ children: entry.sourceUrl ? [new ExternalHyperlink({
              link: entry.sourceUrl, children: [new TextRun({ text: "Open source",
                style: "Hyperlink", size: 19 })],
            })] : [new TextRun({ text: "—", size: 19 })] }),
          ] }),
        ] })),
      ] }));
  }
  const document = new Document({ creator: "Beaver", title: "Table of Authorities",
    description: "Legal authorities",
    styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
    sections: [{ properties: { page: { margin: {
      top: 1440, right: 1440, bottom: 1440, left: 1440,
    } } }, children }],
  });
  const bytes = await Packer.toBuffer(document);
  return artifact("table", filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes, null);
}

function nativeMark(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  unitId: string, offset: number): DocxAuthorityMark {
  const citation = authority.citation.trim();
  const shortName = (authority.displayName ?? authority.name ?? citation).trim();
  const longName = authorityName(draft, authority);
  return { unitId, offset, longName, shortName: shortName || citation,
    category: authority.kind === "case" ? 1 : authority.kind === "legislation" ? 2
      : authority.kind === "commentary" ? 5 : 3 };
}

async function documentArtifact(draft: AuthoritiesDraft, groups: Group[], filename: string,
  bytes: Uint8Array, sourceSha256: string) {
  if (!bytes.byteLength || sha256(Buffer.from(bytes)) !== sourceSha256) {
    throw new Error("The imported Word document changed before building.");
  }
  const seen = new Set<string>();
  const marks = draft.units.flatMap((unit) => unit.occurrenceIds.flatMap((id) => {
    const occurrence = draft.occurrences[id], authority = occurrence?.authorityId
      ? draft.authorities[occurrence.authorityId] : null;
    const key = authority && `${unit.id}\0${occurrence.end}\0${authority.id}`;
    if (!authority || !key || seen.has(key)) return [];
    seen.add(key);
    return [nativeMark(draft, authority, unit.id, occurrence.end)];
  }));
  const linked = groups.flatMap(({ entries }) => entries.map(({ name, sourceUrl }) => ({
    label: name, url: sourceUrl,
  })));
  const output = await applyTableOfAuthorities(Buffer.from(bytes), draft.units, marks,
    draft.settings.tableDelivery, linked);
  return artifact("annotated-document", filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    output, null);
}

/** Creates a local, searchable source rendition when A2AJ has text but no usable original PDF. */
export async function renderAuthoritySourcePdf(input: {
  kind: AuthorityKind; name: string | null; citation: string; date: string | null;
  sourceUrl: string | null; text: string;
}) {
  if (!input.text.trim()) throw new Error("Authority source text is empty.");
  const pdf = await import("pdf-lib"), document = await pdf.PDFDocument.create();
  const serif = await document.embedFont(pdf.StandardFonts.TimesRoman);
  const bold = await document.embedFont(pdf.StandardFonts.TimesRomanBold);
  const sans = await document.embedFont(pdf.StandardFonts.Helvetica);
  const width = 612, height = 792, left = 66, right = 66, top = 58, bottom = 54;
  const title = pdfText(input.name?.trim() || input.citation.trim());
  const citation = pdfText(input.citation.trim());
  const pages: PdfPage[] = [];
  const page = () => {
    const item = document.addPage([width, height]); pages.push(item); return item;
  };
  let current = page(), y = height - 180;
  current.drawText(pdfText(input.kind === "legislation" ? "LEGISLATION" : "AUTHORITY"),
    { x: left, y: height - 72, size: 8, font: sans, color: pdf.rgb(.35, .35, .35) });
  for (const line of wrapped(bold, title, 23, width - left - right)) {
    current.drawText(line, { x: left, y, size: 23, font: bold }); y -= 29;
  }
  y -= 8;
  for (const line of wrapped(serif, citation, 13, width - left - right)) {
    current.drawText(line, { x: left, y, size: 13, font: serif,
      color: pdf.rgb(.2, .2, .2) }); y -= 18;
  }
  const note = [input.date, "Reconstructed from A2AJ source text", input.sourceUrl]
    .filter(Boolean).join("  |  ");
  y -= 12;
  for (const line of wrapped(sans, note, 8, width - left - right)) {
    current.drawText(line, { x: left, y, size: 8, font: sans,
      color: pdf.rgb(.4, .4, .4) }); y -= 11;
  }
  current.drawLine({ start: { x: left, y: y - 6 }, end: { x: width - right, y: y - 6 },
    thickness: .8, color: pdf.rgb(.6, .6, .6) });
  y -= 34;
  const paragraphs = input.text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u)
    .flatMap((part) => part.split(/\n(?=\s*(?:#{1,6}\s+|\[?\d+(?:\]|\.|\))\s+))/u))
    .map((part) => part.trim()).filter(Boolean);
  for (const raw of paragraphs) {
    const heading = /^#{1,6}\s+/u.test(raw);
    const clean = raw.replace(/^#{1,6}\s+/u, "")
      .replace(/\x5b([^\x5d]+)\x5d\([^\s)]+\)/gu, "$1").replace(/[*_`]/gu, "");
    const font = heading ? bold : serif, size = heading ? 12 : 10.5;
    const leading = heading ? 16 : 14.5;
    const lines = wrapped(font, clean, size, width - left - right);
    if (y - lines.length * leading < bottom + 18) { current = page(); y = height - top; }
    for (const line of lines) {
      if (y < bottom + leading) { current = page(); y = height - top; }
      current.drawText(line, { x: left, y, size, font }); y -= leading;
    }
    y -= heading ? 7 : 9;
  }
  pages.forEach((item, index) => {
    if (index) {
      item.drawText(fit(sans, `${title}  |  ${citation}`, 7.5, width - left - right),
        { x: left, y: height - 34, size: 7.5, font: sans, color: pdf.rgb(.42, .42, .42) });
      item.drawLine({ start: { x: left, y: height - 41 }, end: { x: width - right, y: height - 41 },
        thickness: .5, color: pdf.rgb(.75, .75, .75) });
    }
    item.drawText(String(index + 1), { x: width - right - 12, y: 25,
      size: 8, font: sans, color: pdf.rgb(.4, .4, .4) });
  });
  document.setTitle(title); document.setSubject(citation); document.setCreator("Beaver");
  document.setProducer("Beaver · pdf-lib"); document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function filingPdfArtifact(groups: Group[], filename: string,
  bytes: Uint8Array, sourceSha256: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>) {
  const pdf = await import("pdf-lib"), sourceBytes = Buffer.from(bytes);
  if (!sourceBytes.length || sha256(sourceBytes) !== sourceSha256) {
    throw new Error("The imported filing PDF changed before building.");
  }
  let filing: PdfDocument;
  try { filing = await pdf.PDFDocument.load(sourceBytes, { updateMetadata: false }); }
  catch { throw new Error("The imported filing PDF could not be opened."); }
  if (!filing.getPageCount()) throw new Error("The imported filing PDF is empty.");
  const entries = groups.flatMap(({ entries: items }) => items);
  const appended = await Promise.all(entries.flatMap((entry) => {
    const source = entry.authority.source;
    return !entry.sourceUrl && source.kind === "attached"
      ? [loadAuthorityPdf(pdf, source.sources, entry.name, attached)
        .then(({ document }) => ({ entry, document }))]
      : [];
  }));
  const document = await pdf.PDFDocument.create(), regular = await document.embedFont(
    pdf.StandardFonts.TimesRoman), bold = await document.embedFont(pdf.StandardFonts.TimesRomanBold);
  await appendPages(document, filing);
  const tableStart = document.getPageCount(), chunks = Array.from(
    { length: Math.max(1, Math.ceil(entries.length / 24)) }, (_, index) =>
      entries.slice(index * 24, index * 24 + 24));
  const links: Array<{ page: PdfPage; entry: Entry; rect: number[] }> = [];
  chunks.forEach((chunk, index) => {
    const page = document.addPage([612, 792]);
    page.drawText(index ? "TABLE OF AUTHORITIES - CONTINUED" : "TABLE OF AUTHORITIES",
      { x: 54, y: 730, size: 16, font: bold });
    let y = 690;
    chunk.forEach((entry, item) => {
      const number = String(index * 24 + item + 1);
      page.drawText(`${number}.`, { x: 54, y, size: 10, font: regular });
      page.drawText(fit(regular, entry.name, 10, 430), { x: 82, y, size: 10, font: regular,
        color: pdf.rgb(.55, .05, .05) });
      links.push({ page, entry, rect: [78, y - 4, 520, y + 12] });
      y -= 25;
    });
  });
  const starts = new Map<string, number>();
  for (const { entry, document: authority } of appended) {
    starts.set(entry.authority.id, document.getPageCount());
    await appendPages(document, authority);
  }
  links.forEach(({ page, entry, rect }) => {
    const start = starts.get(entry.authority.id);
    if (start === undefined) addLink(page, rect, entry.sourceUrl!);
    else addLink(page, rect, document.getPage(start));
  });
  applyOutlines(document, [
    { title: "Filing document", pageIndex: 0 },
    { title: "Table of Authorities", pageIndex: tableStart },
    ...(appended.length ? [{ title: "Appended authorities", pageIndex: starts.get(
      appended[0].entry.authority.id)!, children: appended.map(({ entry }) => ({
        title: entry.name, pageIndex: starts.get(entry.authority.id)!,
      })) }] : []),
  ], true);
  document.setTitle("Filing with Table of Authorities"); document.setCreator("Beaver");
  document.setProducer("Beaver / pdf-lib"); document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const output = Buffer.from(await document.save({ useObjectStreams: false }));
  return artifact("annotated-document", filename, "application/pdf", output,
    document.getPageCount());
}

type LoadedBookPdf = BookRow & { document: PdfDocument; authority: AuthorityIdentity | null;
  markedPages?: Set<number>;
  pageTextByPage?: string[]; ocrTextByPage?: string[];
  passageGeometry?: NativePdfPassageGeometry };
type PreparedBookPdf = LoadedBookPdf & { pageIndices: number[];
  databaseReference: { url: string; host: string } | null };

const FEDERAL_BOOK_ROLE_LABELS = {
  applicant: "Applicant", respondent: "Respondent", joint: "Joint",
  appellant: "Appellant", intervener: "Intervener", plaintiff: "Plaintiff",
  defendant: "Defendant", "moving-party": "Moving Party",
  "responding-party": "Responding Party",
} as const;
const FEDERAL_APPEAL_PAPER_COVERS = {
  joint: { rgb: [128 / 255, 0, 32 / 255], dark: true },
  appellant: { rgb: [245 / 255, 245 / 255, 220 / 255], dark: false },
  respondent: { rgb: [169 / 255, 209 / 255, 142 / 255], dark: false },
  intervener: { rgb: [159 / 255, 197 / 255, 220 / 255], dark: false },
} as const;

async function loadBookPdf(
  pdf: PdfModule, part: AuthoritiesBoundPdf, label: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>,
) {
  const bytes = Buffer.from(attached[part.bindingRole]?.bytes ?? []);
  if (!bytes.length || sha256(bytes) !== part.sourceSha256) {
    throw new Error(`Attached PDF changed for ${label}.`);
  }
  let document: PdfDocument;
  try {
    document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new Error(`Attached PDF could not be opened for ${label}.`);
  }
  if (!document.getPageCount()) throw new Error(`Attached PDF is empty for ${label}.`);
  return document;
}

/** Preparing highlights does not require assembling a book or emitting an artifact. */
export function prepareAuthorityAnnotations(
  pdf: PdfModule, document: PdfDocument, draft: AuthoritiesDraft, authority: AuthorityIdentity,
  source: AuthoritiesBoundPdf, text: NonNullable<AuthoritiesBuildInput["sources"]>[string] = {},
  regenerate = false,
) {
  const saved = regenerate ? undefined : annotationSetForSource(authority.annotations,
    source.bindingRole, source.sourceSha256);
  if (saved) return { annotations: saved, unresolved: [] };
  const pages = document.getPages().map(page => {
    const crop = page.getCropBox(), rotated = Math.abs(page.getRotation().angle % 180) === 90;
    return { width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height };
  });
  return initialAuthorityAnnotations({ sourceSha256: source.sourceSha256,
    style: draft.settings.passageMarking, geometry: text.passageGeometry, pages,
    citedPages: citedSourcePages(draft, authority.id, text.pageTextByPage ?? [],
      document.catalog.has(pdf.PDFName.of("PageLabels")) ? pdfPageLabelIndices(pdf, document) : undefined,
      document.getPageCount()),
    exclusions: new Set((authority.highlightExclusions ?? []).map(({ kind, label }) => `${kind.trim()}\0${label.trim()}`)) });
}

async function loadAuthorityPdf(
  pdf: PdfModule, sources: AttachedAuthoritySource[], label: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>,
  editing?: { draft: AuthoritiesDraft; authority: AuthorityIdentity },
) {
  const loaded = await Promise.all(sources.map(async (source) => ({ source,
    document: await loadBookPdf(pdf, source, label, attached),
    text: attached[source.bindingRole] })));
  const markedPages = new Set<number>();
  let sourceOffset = 0;
  for (const item of loaded) {
    if (editing) {
      const { annotations } = prepareAuthorityAnnotations(pdf, item.document, editing.draft,
        editing.authority, item.source, item.text);
      writeAuthorityAnnotations(pdf, item.document, annotations, item.source.bindingRole);
      annotations.marks.forEach(mark => mark.fragments.forEach(fragment =>
        markedPages.add(sourceOffset + fragment.pageNumber - 1)));
    }
    sourceOffset += item.document.getPageCount();
  }
  if (loaded.length === 1) return { document: loaded[0].document, markedPages,
    pageTextByPage: loaded[0].text?.pageTextByPage,
    ocrTextByPage: loaded[0].text?.ocrTextByPage,
    passageGeometry: loaded[0].text?.passageGeometry };
  const document = await pdf.PDFDocument.create();
  const pageTextByPage: string[] = [], ocrTextByPage: string[] = [];
  const geometries: Array<{ offset: number; value: NativePdfPassageGeometry }> = [];
  let offset = 0;
  for (const item of loaded) {
    const count = item.document.getPageCount();
    await appendPages(document, item.document);
    pageTextByPage.push(...Array.from({ length: count }, (_, index) =>
      item.text?.pageTextByPage?.[index] ?? ""));
    ocrTextByPage.push(...Array.from({ length: count }, (_, index) =>
      item.text?.ocrTextByPage?.[index] ?? ""));
    if (item.text?.passageGeometry) geometries.push({ offset, value: item.text.passageGeometry });
    offset += count;
  }
  const first = geometries[0]?.value;
  const passageGeometry = first ? { ...first,
    sourceSha256: sha256(Buffer.from(sources.map(({ sourceSha256 }) => sourceSha256).join("\0"))),
    targets: geometries.flatMap(({ offset: pageOffset, value }, sourceIndex) =>
      value.targets.map((target) => ({ ...target, id: `${sourceIndex}:${target.id}`,
        pages: target.pages.map((page) => ({ ...page,
          pageNumber: page.pageNumber + pageOffset })),
        quotes: target.quotes.map((quote) => ({ ...quote,
          ...(quote.pageNumber === undefined ? {} : {
            pageNumber: quote.pageNumber + pageOffset,
          }) })) }))),
  } satisfies NativePdfPassageGeometry : undefined;
  return { document, pageTextByPage, markedPages,
    ocrTextByPage: ocrTextByPage.some(Boolean) ? ocrTextByPage : undefined,
    passageGeometry };
}

async function missingSourcePdf(pdf: PdfModule, label: string, federal = false,
  detail = "No source PDF was attached for this authority.") {
  const document = await pdf.PDFDocument.create();
  const regular = await document.embedFont(federal
    ? pdf.StandardFonts.TimesRoman : pdf.StandardFonts.Helvetica);
  const bold = await document.embedFont(federal
    ? pdf.StandardFonts.TimesRomanBold : pdf.StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  const margin = federal ? 99.21 : 72;
  page.drawText("Source PDF unavailable", { x: margin, y: 620,
    size: federal ? 12 : 24, font: bold });
  let y = 575;
  for (const line of wrapped(regular, label, 12, 612 - (2 * margin))) {
    page.drawText(line, { x: margin, y, size: 12, font: regular }); y -= 18;
  }
  page.drawText(detail,
    { x: margin, y: y - 18, size: federal ? 12 : 10,
      font: regular, color: pdf.rgb(.35, .35, .35) });
  return document;
}

async function prepareAuthorityBook(
  draft: AuthoritiesDraft, groups: Group[], filename: string, subtitle: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, signal?: AbortSignal,
): Promise<PreparedAuthoritiesBook> {
  signal?.throwIfAborted();
  const pdf = await import("pdf-lib");
  const profile = authoritiesProfile(draft.settings.profileId);
  const federal = !!profile.requirements?.federalFormatting;
  const role = draft.settings.bookRole;
  const coverLine = federal && role
    ? role === "joint" ? "Filed jointly" : `Filed by ${FEDERAL_BOOK_ROLE_LABELS[role]}`
    : null;
  const paperCover = profile.requirements?.appealPaperCovers &&
    draft.settings.filingMedium === "paper" && role && role in FEDERAL_APPEAL_PAPER_COVERS
    ? FEDERAL_APPEAL_PAPER_COVERS[role as keyof typeof FEDERAL_APPEAL_PAPER_COVERS] : null;
  const bookTitle = profile.bookTitle ??
    (draft.import.kind === "manual" ? subtitle : "Book of Authorities");
  const documentTitle = (draft.settings.allowIncomplete ? "DRAFT — incomplete sources · " : "") +
    (draft.cover.title || bookTitle);
  if (federal && !draft.bookParts.cover && !role) {
    throw new Error("Choose who is filing the Federal Court book.");
  }
  if (federal && !draft.bookParts.cover && (!draft.cover.courtFileNumber ||
      draft.cover.partyGroups.length < 2 || draft.cover.partyGroups.some(({ role, parties }) =>
        !role || !parties.length || parties.some((party) => !party)))) {
    throw new Error("Add the Court file number and complete party names and roles for the Federal Form 66 cover.");
  }
  const authorityRows = groups.flatMap(({ entries }) => entries.filter(({ authority }) =>
    reproducedInBook(draft, authority)));
  const supplementRows: BookRow[] = draft.bookParts.supplements.map((item, index) => ({
    key: `supplement:${item.id}`,
    name: item.filename.replace(/\.pdf$/iu, "").trim() || item.filename,
    tab: tabLabel(draft.authorityOrder.filter((id) => !draft.authorities[id].excluded).length + index + 1,
      draft.settings.tabStyle, draft.settings),
  }));
  const rows: BookRow[] = [...authorityRows.map((entry) => ({
    key: `authority:${entry.authority.id}`, name: entry.name, tab: entry.tab,
    sourceUrl: entry.sourceUrl,
  })), ...supplementRows];
  if (!rows.length) throw new Error(
    "Add at least one authority or supplemental PDF before building the book.");
  const [authoritySources, supplementalSources, customCover, customIndex] = await Promise.all([
    Promise.all(authorityRows.map(async (entry): Promise<LoadedBookPdf> => {
      const source = entry.authority.source;
      const loaded = source.kind === "attached"
        ? await loadAuthorityPdf(pdf, source.sources, entry.name, attached,
          { draft, authority: entry.authority })
        : { document: await missingSourcePdf(pdf, entry.name, federal) };
      if (draft.settings.allowIncomplete && profile.requirements?.bilingualEnactments &&
          entry.authority.kind === "legislation" && federalEnactmentCitation(entry.authority.citation) &&
          source.kind === "attached" && !hasBilingualAuthoritySource(source)) {
        const missingLanguage = source.sources.some(({ language }) => language === "en") ? "French" : "English";
        const stub = await missingSourcePdf(pdf, entry.name, federal,
          `${missingLanguage} version not attached. This draft is incomplete.`);
        await appendPages(loaded.document, stub);
      }
      return { key: `authority:${entry.authority.id}`, name: entry.name, tab: entry.tab,
        sourceUrl: entry.sourceUrl, authority: entry.authority,
        ...loaded };
    })),
    Promise.all(draft.bookParts.supplements.map(async (item, index): Promise<LoadedBookPdf> => ({
      ...supplementRows[index], authority: null,
      document: await loadBookPdf(pdf, item, item.filename, attached),
    }))),
    draft.bookParts.cover
      ? loadBookPdf(pdf, draft.bookParts.cover, "the custom cover", attached) : null,
    draft.bookParts.index
      ? loadBookPdf(pdf, draft.bookParts.index, "the custom index", attached) : null,
  ]);
  const sources: PreparedBookPdf[] = [...authoritySources, ...supplementalSources].map((source) => {
    const pageLabels = pdfPageLabelIndices(pdf, source.document);
    const extract = federalPaperExtract(draft, source, pageLabels);
    return { ...source, pageIndices: extract?.pageIndices ?? source.document.getPageIndices(),
      databaseReference: extract?.databaseReference ?? null };
  });
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const rowGroups = groups.flatMap(({ label, entries }) => {
    const kept = entries.filter(({ authority }) => reproducedInBook(draft, authority))
      .map(({ authority }) => rowByKey.get(`authority:${authority.id}`)!);
    return kept.length ? [{ label, entries: kept }] : [];
  });
  if (supplementRows.length) rowGroups.push({ label: "Documents", entries: supplementRows });
  return {
    filename, subtitle, documentTitle, bookTitle, federal,
    electronic: draft.settings.filingMedium === "electronic",
    court: profile.courtId === "fca" ? "FEDERAL COURT OF APPEAL" : "FEDERAL COURT",
    cover: draft.cover, allowIncomplete: !!draft.settings.allowIncomplete, coverLine, paperCover,
    customCover: draft.bookParts.cover ? attached[draft.bookParts.cover.bindingRole]?.bytes : undefined,
    customIndex: draft.bookParts.index ? attached[draft.bookParts.index.bindingRole]?.bytes : undefined,
    coverPageCount: customCover?.getPageCount() ?? 1,
    customIndexPages: customIndex?.getPageCount() ?? 0,
    limits: draft.settings.filingMedium === "electronic" ? profile.requirements?.electronicVolumes : undefined,
    groups: rowGroups,
    sources: await Promise.all(sources.map(async (source) => {
      const seen = new Set<string>();
      const bookmarks = source.passageGeometry?.targets.flatMap((target) =>
        target.status === "found" ? target.pages.flatMap(({ pageNumber }) => {
          const key = `${target.locatorKind}\0${target.locator}\0${pageNumber}`;
          if (seen.has(key)) return []; seen.add(key);
          const title = target.locatorKind === "paragraph" ? "para" : target.locatorKind === "section" ? "s" : "p";
          return [{ title: `${title} ${target.locator}`, pageIndex: pageNumber - 1 }];
        }) : []) ?? [];
      const cited = source.authority ? citedSourcePages(draft, source.authority.id,
        source.pageTextByPage ?? [], undefined, source.document.getPageCount()) : new Set<number>();
      const ocrTextByPage = source.authority ? source.ocrTextByPage?.map((text, index) =>
        draft.settings.scannedPdfPolicy === "full" ||
          draft.settings.scannedPdfPolicy === "cited-pages" && cited.has(index)
          ? pdfNormalized(text).replace(/[^\x20-\x7e\u00a0-\u00ff\r\n]/gu, "?") : "") : undefined;
      return { key: source.key, name: source.name, tab: source.tab, sourceUrl: source.sourceUrl,
        bytes: await source.document.save({ useObjectStreams: false }),
        pageIndices: source.pageIndices, databaseReference: source.databaseReference, ocrTextByPage, bookmarks };
    })),
  };
}

async function bookArtifacts(plan: PreparedAuthoritiesBook, signal?: AbortSignal) {
  return (await renderAuthoritiesBook(pdfLibrary, plan, signal)).map((item) =>
    artifact(item.role, item.filename, item.mimeType, Buffer.from(item.bytes), item.pageCount));
}

function citedSourcePages(draft: AuthoritiesDraft, authorityId: string, pages: string[],
  pageLabels?: Map<string, number[]>, pageCount = pages.length) {
  const authority = draft.authorities[authorityId];
  const locators = [...(authority?.locators ?? []), ...Object.values(draft.occurrences)
    .flatMap((occurrence) => occurrence.authorityId === authorityId
      ? occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text })) : [])];
  const result = new Set<number>();
  for (const { kind, label } of locators) {
    if (kind === "page") {
      const numbers = [...label.matchAll(/\d+/gu)].map(([value]) => Number(value));
      const first = numbers[0] ?? 0, last = numbers[1] ?? first;
      for (let number = Math.min(first, last); number <= Math.max(first, last); number += 1) {
        if (pageLabels) pageLabels.get(String(number))?.forEach((index) => result.add(index));
        else if (number > 0 && number <= pageCount) result.add(number - 1);
      }
    }
    if ((kind === "paragraph" || kind === "section") && label.trim()) {
      const values = label.trim().split(/\s+(?:to|[-\u2013\u2014])\s+|\s*[-\u2013\u2014]\s*/u)
        .filter(Boolean).slice(0, 2);
      const matched: number[] = [];
      for (const value of values) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const marker = kind === "paragraph"
          ? new RegExp(`(?:\\[\\s*${escaped}\\s*\\]|(?:^|\\n)\\s*${escaped}(?:\\s|[.)]))`, "iu")
          : new RegExp(`(?:^|\\n|\\s)(?:s(?:ec(?:tion)?)?\\.?\\s*)?${escaped}(?:\\s|[.)])`, "iu");
        pages.forEach((text, index) => { if (marker.test(text)) matched.push(index); });
      }
      if (matched.length) for (let index = Math.min(...matched); index <= Math.max(...matched);
        index += 1) result.add(index);
    }
  }
  return result;
}

function pdfPageLabelIndices(pdf: PdfModule, document: PdfDocument) {
  const result = new Map<string, number[]>();
  if (!document.catalog.has(pdf.PDFName.of("PageLabels"))) return result;
  const rules: Array<{ index: number; prefix: string; style: string; start: number }> = [];
  const visit = (node: import("pdf-lib").PDFDict) => {
    if (node.has(pdf.PDFName.of("Nums"))) {
      const nums = node.lookup(pdf.PDFName.of("Nums"), pdf.PDFArray);
      for (let offset = 0; offset + 1 < nums.size(); offset += 2) {
        const index = nums.lookup(offset, pdf.PDFNumber).asNumber();
        const spec = nums.lookup(offset + 1, pdf.PDFDict);
        const prefix = spec.lookupMaybe(pdf.PDFName.of("P"), pdf.PDFString, pdf.PDFHexString);
        const style = spec.lookupMaybe(pdf.PDFName.of("S"), pdf.PDFName);
        const start = spec.lookupMaybe(pdf.PDFName.of("St"), pdf.PDFNumber);
        rules.push({ index, prefix: prefix?.decodeText() ?? "",
          style: style?.asString().slice(1) ?? "", start: start?.asNumber() ?? 1 });
      }
    }
    if (node.has(pdf.PDFName.of("Kids"))) {
      const kids = node.lookup(pdf.PDFName.of("Kids"), pdf.PDFArray);
      for (let index = 0; index < kids.size(); index += 1)
        visit(kids.lookup(index, pdf.PDFDict));
    }
  };
  visit(document.catalog.lookup(pdf.PDFName.of("PageLabels"), pdf.PDFDict));
  rules.sort((left, right) => left.index - right.index);
  let active = -1;
  for (let index = 0; index < document.getPageCount(); index += 1) {
    if (rules[active + 1]?.index === index) active += 1;
    const rule = rules[active];
    if (!rule || rule.style !== "D") continue;
    const label = `${rule.prefix}${rule.start + index - rule.index}`;
    (result.get(label) ?? result.set(label, []).get(label)!).push(index);
  }
  return result;
}

function federalPaperExtract(draft: AuthoritiesDraft, source: LoadedBookPdf,
  pageLabels = new Map<string, number[]>()) {
  if (!source.authority ||
      !authoritiesProfile(draft.settings.profileId).requirements?.federalFormatting ||
      draft.settings.filingMedium !== "paper") return null;
  const databaseReference = freePublicDatabaseReference(source.authority);
  if (!databaseReference) return null;
  const pageCount = source.document.getPageCount();
  const text = Array.from({ length: pageCount }, (_, index) =>
    source.pageTextByPage?.[index]?.trim() || source.ocrTextByPage?.[index] || "");
  const reasonsStart = text.findIndex((page) =>
    /(?:^|\n)\s*(?:\[\s*1\s*\]|1[.)])(?:\s|$)/u.test(page));
  const cited = citedSourcePages(draft, source.authority.id, text, pageLabels);
  source.markedPages?.forEach(index => cited.add(index));
  source.passageGeometry?.targets.forEach((target) => {
    if (target.status === "found") target.pages.forEach(({ pageNumber }) => {
      if (pageNumber > 0 && pageNumber <= pageCount) cited.add(pageNumber - 1);
    });
  });
  if (reasonsStart < 0 || !cited.size) return null;
  const selected = new Set(Array.from({ length: reasonsStart + 1 }, (_, index) => index));
  cited.forEach((index) => {
    for (let page = index - 1; page <= index + 1; page += 1)
      if (page >= 0 && page < pageCount) selected.add(page);
  });
  return { pageIndices: [...selected].sort((left, right) => left - right), databaseReference };
}

function artifact(
  role: AuthoritiesOutputRole, filename: string, mimeType: string,
  bytes: Buffer, pageCount: number | null,
): BareArtifact {
  return { role, filename, mimeType, bytes, sha256: sha256(bytes), pageCount };
}

function resolvedInput(
  role: string, binding: WorkProductInput, filename: string, sourceSha256: string,
  supplied?: ResolvedWorkProductInput,
): ResolvedWorkProductInput {
  const resolved = supplied ?? (binding.kind === "local-file" &&
    binding.lastSeen.sha256 === sourceSha256
    ? { kind: "local-file" as const, handleId: binding.handleId, filename,
      size: binding.lastSeen.size, modified: binding.lastSeen.modified, sha256: sourceSha256 }
    : binding.kind === "document" && binding.version !== "latest" &&
      binding.version.sha256 === sourceSha256
      ? { kind: "document" as const, documentId: binding.documentId,
        versionId: binding.version.versionId, filename, sha256: sourceSha256 }
      : null);
  if (!resolved || resolved.sha256 !== sourceSha256 ||
      (binding.kind === "local-file" &&
        (resolved.kind !== binding.kind || resolved.handleId !== binding.handleId)) ||
      (binding.kind === "document" &&
        (resolved.kind !== binding.kind || resolved.documentId !== binding.documentId ||
         (binding.version !== "latest" &&
          resolved.versionId !== binding.version.versionId))) ||
      (binding.kind === "work-product-output" &&
        (resolved.kind !== binding.kind || resolved.workProductId !== binding.workProductId ||
         resolved.role !== binding.role))) {
    throw new Error(`Resolve the exact current input for ${role} before building.`);
  }
  return resolved;
}

export async function buildAuthorities(input: AuthoritiesBuildInput,
  assembleBook = bookArtifacts): Promise<AuthoritiesBuildResult> {
  input.signal?.throwIfAborted();
  const errors = validateAuthoritiesDraft(input.draft);
  if (errors.length) throw new Error(errors[0]);
  if (!input.workProduct.id || !Number.isInteger(input.workProduct.revision) ||
      input.workProduct.revision < 1) throw new Error("Valid work-product identity is required.");
  const tableGroups = groupedEntries(input.draft, "table");
  const bookGroups = groupedEntries(input.draft, "book");
  const sources = input.sources ?? {};
  const wanted: RequestedRole[] = input.draft.outputMode === "both"
    ? ["table", "book"] : [input.draft.outputMode];
  const profile = authoritiesProfile(input.draft.settings.profileId);
  const completeBook = profile.requirements?.completeBookSources ? profile.label : null;
  if (wanted.includes("book") && completeBook && !input.draft.settings.allowIncomplete) {
    const missing = input.draft.authorityOrder.map((id) => input.draft.authorities[id])
      .filter((authority) => !authority.excluded && authority.source.kind !== "attached");
    if (missing.length) throw new Error(
      `Attach a complete PDF or exclude ${authorityName(input.draft, missing[0])} before building this ${completeBook} book.`,
    );
  }
  if (wanted.includes("book") && profile.requirements?.bilingualEnactments && !input.draft.settings.allowIncomplete) {
    const incomplete = input.draft.authorityOrder.map((id) => input.draft.authorities[id])
      .find((authority) => !authority.excluded && authority.kind === "legislation" &&
        federalEnactmentCitation(authority.citation) && authority.source.kind === "attached" &&
        !hasBilingualAuthoritySource(authority.source));
    if (incomplete) throw new Error(
      `Attach one bilingual PDF or both English and French PDFs for ${authorityName(input.draft, incomplete)}.`,
    );
  }
  if (profile.requirements?.unlinkedPdfTableSources) {
    const unlinked = tableGroups.flatMap(({ entries }) => entries).find(({ sourceUrl, authority }) =>
      !sourceUrl && !(input.draft.insertIntoDocument &&
        input.draft.import.kind === "document" && input.draft.import.fileType === "pdf" &&
        authority.source.kind === "attached"))?.authority;
    if (unlinked) {
      throw new Error(input.draft.import.kind === "document" &&
        input.draft.import.fileType === "docx" && unlinked.source.kind === "attached"
        ? `Add a publicly accessible source link for ${authorityName(input.draft, unlinked)}. To append an unlinked authority, use the final filing PDF.`
        : `Add a publicly accessible source link or PDF for ${authorityName(input.draft, unlinked)}.`);
    }
  }
  if (input.draft.insertIntoDocument) wanted.push("annotated-document");
  const imported = input.draft.import.kind === "document" ? (() => {
    const { bindingRole: role, filename, snapshot } = input.draft.import;
    const binding = input.draft.bindings[role], supplied = sources[role]?.resolved;
    const bindingSha = binding.kind === "local-file" ? binding.lastSeen.sha256
      : binding.kind === "document" && binding.version !== "latest"
        ? binding.version.sha256 : undefined;
    const resolved = resolvedInput(role, binding, filename,
      snapshot?.sha256 ?? supplied?.sha256 ?? bindingSha ?? "", supplied);
    if (snapshot && (resolved.kind !== "document" ||
        resolved.documentId !== snapshot.documentId || resolved.versionId !== snapshot.versionId)) {
      throw new Error(`Resolve the imported document snapshot for ${role} before building.`);
    }
    return [{ role, resolved }];
  })() : [];
  const inputs = [...imported, ...input.draft.authorityOrder.flatMap((id) => {
    const authority = input.draft.authorities[id];
    if (authority.source.kind !== "attached") return [];
    return authority.source.sources.map((source) => {
      const role = source.bindingRole;
      return { role, resolved: resolvedInput(role, input.draft.bindings[role],
        source.filename, source.sourceSha256, sources[role]?.resolved) };
    });
  }), ...(wanted.includes("book") ? authoritiesBookPdfs(input.draft).map((part) => {
      const role = part.bindingRole;
      return { role, resolved: resolvedInput(role, input.draft.bindings[role],
        part.filename, part.sourceSha256, sources[role]?.resolved) };
    }) : [])];
  const cleaned = input.title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/u, "").slice(0, 120) || "Authorities";
  const base = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu
    .test(cleaned) ? `_${cleaned}` : cleaned;
  const subtitle = input.draft.import.kind === "document"
    ? input.draft.import.filename : input.title;
  const bookName = (profile.bookTitle ?? "Book of Authorities").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const built = (await Promise.all(wanted.map(async (role) => role === "table"
    ? [await tableArtifact(tableGroups, `${base}.table-of-authorities.docx`, subtitle,
      input.draft.settings.tableDelivery === "linked-append", wanted.includes("book"))]
    : role === "book"
      ? assembleBook(await prepareAuthorityBook(input.draft, bookGroups, `${base}${input.draft.settings.allowIncomplete ? ".draft-incomplete" : ""}.${bookName}.pdf`, subtitle,
        sources, input.signal), input.signal)
      : input.draft.import.kind === "document" && input.draft.import.fileType === "pdf"
        ? [await filingPdfArtifact(tableGroups,
          `${base}.with-table-of-authorities.pdf`,
          sources[input.draft.import.bindingRole]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "", sources)]
        : [await documentArtifact(input.draft, tableGroups,
          `${base}.with-table-of-authorities.docx`,
          sources[input.draft.import.kind === "document"
            ? input.draft.import.bindingRole : "source"]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "")]))).flat();
  input.signal?.throwIfAborted();
  const builtAt = new Date().toISOString();
  const settings: WorkProductBuildReceipt["settings"] = {
    profileId: input.draft.settings.profileId, outputMode: input.draft.outputMode,
    stateSha256: canonicalJsonSha256(input.draft),
    settingsSha256: canonicalJsonSha256({
      schemaVersion: "beaver.authorities-build.v1",
      draftSchemaVersion: input.draft.schemaVersion,
      title: input.title,
      outputMode: input.draft.outputMode,
      insertIntoDocument: input.draft.insertIntoDocument,
      settings: input.draft.settings,
      cover: input.draft.cover,
      bookParts: input.draft.bookParts,
      renderers: wanted.map((role) => [role, RENDERERS[role]]),
    }),
    sourceReceiptIds: [...new Set([
      ...(profile.sourceIds ?? []),
      ...Object.values(input.draft.authorities).flatMap(({ evidenceIds }) => evidenceIds),
      ...Object.values(input.draft.occurrences).flatMap(({ evidenceIds }) => evidenceIds),
    ])].sort(),
    audit: { effective: null, valuesJson: canonicalJson({ title: input.title,
      outputMode: input.draft.outputMode, insertIntoDocument: input.draft.insertIntoDocument,
      settings: input.draft.settings, cover: input.draft.cover,
      bookParts: input.draft.bookParts,
      authorityOrder: input.draft.authorityOrder,
      authorities: input.draft.authorityOrder.map((id) => {
        const authority = input.draft.authorities[id];
        return { id, citation: authority.citation, name: authority.name,
          displayName: authority.displayName,
          excluded: authority.excluded,
          source: authority.source };
      }) }) },
  };
  const artifacts = Object.fromEntries(built.map((item) => [item.role, { ...item,
    receipt: { schemaVersion: "beaver.work-product-build.v2", builtAt,
      workProduct: { ...input.workProduct, kind: "authorities" }, inputs, settings,
      steps: item.role === "table" ? ["Rendered grouped Table of Authorities"]
        : item.role.startsWith("book")
          ? ["Combined attached PDFs", "Added index links and PDF bookmarks"]
          : item.mimeType === "application/pdf"
            ? ["Appended the linked Table of Authorities",
              ...tableGroups.some(({ entries }) => entries.some(({ sourceUrl }) => !sourceUrl))
                ? ["Appended unlinked authority PDFs with bookmarks"] : []]
          : input.draft.settings.tableDelivery === "linked-append"
            ? ["Appended the linked Table of Authorities to the Word document"]
            : input.draft.settings.tableDelivery === "native-marks"
            ? ["Marked citations with native Word TA fields"]
              : ["Marked citations with native Word TA fields",
                "Added a native Word TOA field on a final page"],
      output: { role: item.role, filename: item.filename, mimeType: item.mimeType,
        pageCount: item.pageCount, sha256: item.sha256 } },
  }])) as
    AuthoritiesBuildResult["artifacts"];
  const outputs = Object.fromEntries(built.map(({ role, filename, mimeType, sha256, pageCount }) =>
    [role, { filename, mimeType, sha256, pageCount }])) as AuthoritiesBuildReceipt["outputs"];
  const entries = (input.draft.outputMode === "table" ? tableGroups : bookGroups)
    .flatMap(({ entries }) => entries);
  return { artifacts, receipt: {
    schemaVersion: "beaver.authorities-build.v1", builtAt,
    workProduct: { ...input.workProduct, kind: "authorities" }, inputs,
    draft: { schemaVersion: input.draft.schemaVersion, outputMode: input.draft.outputMode,
      settings: structuredClone(input.draft.settings),
      cover: structuredClone(input.draft.cover),
      bookParts: structuredClone(input.draft.bookParts),
      insertIntoDocument: input.draft.insertIntoDocument,
      document: input.draft.import.kind === "document" ? input.draft.import.snapshot : null },
    authorities: entries.map(({ authority, name, tab }) => ({
      id: authority.id, key: authority.key, kind: authority.kind, citation: authority.citation,
      name, tab, excluded: authority.excluded, source: structuredClone(authority.source),
      sourceIdentity: structuredClone(authority.sourceIdentity),
      evidenceIds: [...authority.evidenceIds], locators: structuredClone(authority.locators),
      bindings: attachedAuthoritySources(authority.source).map(({ bindingRole }) =>
        structuredClone(input.draft.bindings[bindingRole])),
    })),
    outputs,
  } };
}
