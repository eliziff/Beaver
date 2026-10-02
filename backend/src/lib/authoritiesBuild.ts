import { writeAuthorityAnnotations } from 'mike/shared/pdf-annotation-writer.mjs';
import { resolvePrintedPages, type PdfPageBinding } from "./pdfPagination";
import * as pdfLibrary from "pdf-lib";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes } from "mdast";
import { nestedOutline, pdfAssembly, sourceOutline, type PdfOutline } from "./pdfAssembly";
import { renderAuthoritiesBook, fit, pdfNormalized, pdfText, wrapped,
  type BookRow, type PreparedAuthoritiesBook } from "./authoritiesBook";
const { addInternalLink: addLink, applyOutlines, appendPages, readOutlines } = pdfAssembly(pdfLibrary);
import { footnotePropositions, markedQuotations, singleSourceFootnote } from "./authoritiesQuotations";
import { legalSourceLocatorAnchor, sourceUrl as legalSourceUrl } from "./legalSourceLinks";
import type { A2AJLocatorKind } from "./legalSources/a2aj";
import type { AuthoritiesBuildReceipt,
  AuthoritiesOutputRole } from "mike/shared/authorities-contract.d.ts";
import {
  authoritiesBookPdfs,
  attachedAuthoritySources,
  authoritiesProfile,
  validateAuthoritiesDraft,
  authorityCitationForms,
  authorityReproducedInBook,
  authoritySourceRequirement,
  authoritySourceUrl,
  type AttachedAuthoritySource,
  type AuthoritiesBoundPdf,
  type AuthoritiesDraft,
  type AuthorityIdentity,
  type AuthorityKind,
} from "./authoritiesDomain";
import { annotationSetForSource } from "mike/shared/pdf-annotations.mjs";
import { hasPrintedParagraphLocator, initialAuthorityAnnotations } from "./authoritiesAnnotations";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { applyTableOfAuthorities, type DocxAuthorityMark } from "./docxOperations";
import { structureNative, type NativeOutlineEntry, type NativePdfPassageGeometry,
  type NativePdfPassageTarget } from "./structureNative";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput } from "./workProduct";
import { authorityProcedureInput, deriveAuthorityProcedure, tabLabel, tabReference } from "mike/shared/authorities-order.mjs";
import { isCanliiUrl, urlHostname } from "./canliiUrls";
import { assembleFinalAuthoritiesPdf, assertBriefPdfMatches, briefOccurrencePages, filingLinkUrl,
  filingTabText } from "./authoritiesFinalPdf";
import { authoritiesBriefPdf } from "mike/shared/authorities-sources.mjs";

export type { AuthoritiesBuildReceipt, AuthoritiesOutputRole };
export type AuthoritiesBuildArtifact = {
  role: AuthoritiesOutputRole;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  pageCount: number | null;
  receipt: WorkProductBuildReceipt;
  bookPlacements?: import("./authoritiesBook").BuiltAuthorityBook["placements"];
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
    pageTextByPage?: string[]; ocrTextByPage?: string[]; pageLabels?: (string | null)[]; pageBindings?: PdfPageBinding[];
    passageGeometry?: NativePdfPassageGeometry; outline?: NativeOutlineEntry[] }>;
  signal?: AbortSignal;
  finalPdfSource?: (bytes: Uint8Array, filename: string) => Promise<Uint8Array>;
  /** Told what the build is doing, as it starts each part. */
  progress?: (message: string) => void;
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
  const units = new Map(draft.units.map((unit) => [unit.id, unit]));
  for (const occurrence of Object.values(draft.occurrences)) {
    if (occurrence.authorityId !== authorityId) continue;
    const locators = occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text }))
      .filter(valid);
    if (!locators.length) continue;
    const unit = units.get(occurrence.unitId);
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

/** A quote with its neighbouring words, so one citation cited twice on a page stays two. A note
 *  number printed against the first word, or a mark after the last, breaks one side only. */
const inContext = (text: string, start: number, end: number) => [[4, 4], [0, 4], [4, 0]].map(([before, after]) => {
  let from = start, to = end;
  for (let n = 0; n < before && from > 0; n++) from = text.lastIndexOf(" ", from - 2) + 1;
  for (let n = 0; n < after && to < text.length; n++) { const next = text.indexOf(" ", to + 1); to = next < 0 ? text.length : next; }
  return { text: text.slice(from, to), start: start - from, end: end - from };
});

/** Exact reviewed text on known physical filing pages; ambiguity is retained by the parser.
 *  A PDF saved from a Word brief has no recorded pages: its text places each citation. */
export function authorityFilingTargets(draft: AuthoritiesDraft, briefPageText?: string[]): NativePdfPassageTarget[] {
  const tabs = new Map(authorityProcedure(draft, "book").map(({ id, tab }) => [id, tab]));
  const located = briefPageText && briefOccurrencePages(draft, briefPageText);
  return draft.units.flatMap((unit) => unit.occurrenceIds.flatMap((id) => {
    const occurrence = draft.occurrences[id], authority = draft.authorities[occurrence?.authorityId ?? ""];
    const pages = located ? located.has(id) ? [located.get(id)!] : [] : unit.pageNumbers;
    if (!authority || authority.excluded || !pages.length) return [];
    const tab = tabs.get(authority.id), tabText = filingTabText(unit.text, occurrence, tab);
    const tabStart = tabText === occurrence.authoritySpan.text ? occurrence.authoritySpan.start
      : unit.text.indexOf(tabText, occurrence.end), suffixText = tab && tabReference(draft.settings, tab);
    return [{ id: `filing:${id}`, locatorKind: "page" as const, locator: String(pages[0]), physicalPages: pages,
      exactQuotes: draft.settings.linkTabs ? [tabText] : [],
      quoteSelections: [...draft.settings.linkTabs ? inContext(unit.text, tabStart, tabStart + tabText.length) : [],
        // A brief saved from the Word output carries the tab reference that output appended.
        ...located && draft.settings.linkTabs && suffixText ? [{ text: `${occurrence.text} ${suffixText}`,
          start: occurrence.text.length + 1, end: occurrence.text.length + 1 + suffixText.length }] : [],
        // A pinpoint may lie outside its citation's range, so it is found by the words around it.
        ...draft.settings.linkPinpoints && occurrence.pinpointSpan
          ? inContext(unit.text, occurrence.pinpointSpan.start, occurrence.pinpointSpan.end) : []] }];
  }));
}

export function authoritiesTextRoles(draft: AuthoritiesDraft) {
  const brief = authoritiesBriefPdf(draft);
  const filingRoles = brief ? [brief.bindingRole] : draft.settings.finalPdf && (draft.settings.linkTabs ||
    draft.settings.linkPinpoints) && draft.import.kind === "document" && draft.import.fileType === "pdf"
    ? [draft.import.bindingRole] : [];
  if (draft.outputMode === "table" && !draft.settings.finalPdf) return new Set(filingRoles);
  const federal = authoritiesProfile(draft.settings.profileId).requirements?.federalFormatting;
  return new Set([...filingRoles, ...Object.values(draft.authorities).flatMap((authority) => {
    if (authority.excluded || authority.source.kind !== "attached") return [];
    const paperExtract = federal && draft.settings.filingMedium === "paper" &&
      freePublicDatabaseReference(authority);
    const requests = authorityPassageRequests(draft, authority.id);
    const locatorKinds = new Set(requests.flatMap(({ locators }) =>
      locators.map(({ kind }) => kind)));
    const needsOcr = draft.settings.scannedPdfPolicy !== "page-margin";
    const needsLinkGeometry = !!(draft.settings.finalPdf && draft.settings.linkPinpoints && requests.length);
    const needsLocatorText = (draft.settings.passageMarking !== "none" || draft.settings.finalPdf && draft.settings.linkPinpoints) &&
      (locatorKinds.has("paragraph") || locatorKinds.has("section"));
    const needsQuoteText = ["margin", "text"].includes(draft.settings.passageMarking) &&
      requests.some(({ exactQuotes }) => exactQuotes.length);
    return authority.source.sources.flatMap(source => {
      const saved = annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
      return paperExtract || needsOcr || needsLinkGeometry || !saved && (needsLocatorText || needsQuoteText)
        ? [source.bindingRole] : [];
    });
  })]);
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

type RequestedRole = Exclude<AuthoritiesOutputRole, `book-${number}` | "link-report">;
const RENDERERS: Record<RequestedRole, string> = {
  table: "beaver.authorities.table-docx.v1",
  book: "beaver.authorities.book-pdf.v3",
  "annotated-document": "beaver.authorities.filing-output.v2",
  "final-pdf": "beaver.authorities.final-pdf.v1",
};

function authorityName(draft: AuthoritiesDraft, authority: AuthorityIdentity) {
  const forms = authorityCitationForms(draft, authority.id), values: string[] = [];
  // "R. v. Oakes" (a source's title) and "R v Oakes" (the brief) are one name.
  const lower = (value: string) => value.toLocaleLowerCase("en-CA").replace(/\./gu, "").replace(/\s+/gu, " ");
  const add = (value: string | null | undefined) => {
    const exact = value?.trim();
    if (!exact || values.some((item) => lower(item).includes(lower(exact)))) return;
    // A fuller form replaces the shorter forms it already contains, so none repeats.
    values.splice(0, values.length, ...values.filter((item) => !lower(exact).includes(lower(item))), exact);
  };
  const heading = authority.displayName ?? authority.name;
  if (!heading || !forms.some((form) => lower(form).includes(lower(heading.trim())))) add(heading);
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

const authorityProcedure = (draft: AuthoritiesDraft, purpose: "table" | "book") =>
  deriveAuthorityProcedure(authorityProcedureInput(draft, { purpose }));

function authoritySourceLink(authority: AuthorityIdentity) {
  const value = authoritySourceUrl(authority);
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
  const value = authoritySourceLink(authority);
  if (!value) return null;
  const url = new URL(value);
  return authority.sourceIdentity?.provider === "a2aj" || isCanliiUrl(url)
    ? { url: value, host: urlHostname(url) } : null;
}

function groupedEntries(draft: AuthoritiesDraft, purpose: "table" | "book") {
  const planned = authorityProcedure(draft, purpose);
  const entry = ({ id, tab }: typeof planned[number]): Entry => {
    const authority = draft.authorities[id]; return { authority,
    name: authorityName(draft, authority), citedAt: citedAt(draft, authority.id),
    tab, sourceUrl: authoritySourceLink(authority) }; };
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
  bytes: Uint8Array, sourceSha256: string, finalLinks = false) {
  if (!bytes.byteLength || sha256(Buffer.from(bytes)) !== sourceSha256) {
    throw new Error("The imported Word document changed before building.");
  }
  const seen = new Set<string>();
  const tabs = new Map(authorityProcedure(draft, "book").map(({ id, tab }) => [id, tab]));
  const marks = draft.units.flatMap((unit) => unit.occurrenceIds.flatMap((id) => {
    const occurrence = draft.occurrences[id], authority = occurrence?.authorityId
      ? draft.authorities[occurrence.authorityId] : null;
    const key = authority && `${unit.id}\0${occurrence.end}\0${authority.id}`;
    if (!authority || authority.excluded || !key || seen.has(key)) return [];
    seen.add(key);
    const tab = tabs.get(authority.id)!;
    // A linked tab needs its reference to click, even where none was chosen.
    const suffix = tabReference(draft.settings, tab) ?? (finalLinks && draft.settings.linkTabs ? `[${tab}]` : null);
    return [{ ...nativeMark(draft, authority, unit.id, occurrence.end),
      mark: draft.insertIntoDocument,
      ...(suffix && {
        suffix: ` ${suffix}`,
        ...(finalLinks && draft.settings.linkTabs && { tabUrl: filingLinkUrl("tab", occurrence.id) }),
      }),
      ...(finalLinks && draft.settings.linkPinpoints && occurrence.pinpointSpan &&
        authority.source.kind === "attached" && authority.source.sources.some(({ origin }) => origin === "manual") && {
        pinpointLink: { start: occurrence.pinpointSpan.start, end: occurrence.pinpointSpan.end,
          url: filingLinkUrl("pinpoint", occurrence.id) },
      }),
    }];
  }));
  const linked = groups.flatMap(({ entries }) => entries.map(({ name, sourceUrl }) => ({
    label: name, url: sourceUrl,
  })));
  const output = await applyTableOfAuthorities(Buffer.from(bytes), draft.units, marks,
    draft.insertIntoDocument ? finalLinks && draft.settings.tableDelivery === "native-append"
      ? "linked-append" : draft.settings.tableDelivery : "native-marks", linked);
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
  const italic = await document.embedFont(pdf.StandardFonts.TimesRomanItalic);
  const boldItalic = await document.embedFont(pdf.StandardFonts.TimesRomanBoldItalic);
  const mono = await document.embedFont(pdf.StandardFonts.Courier);
  const sans = await document.embedFont(pdf.StandardFonts.Helvetica);
  const width = 612, height = 792, left = 66, right = 66, top = 58, bottom = 54;
  const title = pdfText(input.name?.trim() || input.citation.trim());
  const citation = pdfText(input.citation.trim());
  const pages: PdfPage[] = [];
  const page = () => {
    const item = document.addPage([width, height]); pages.push(item); return item;
  };
  let current = page(), y = height - 180;
  for (const line of wrapped(bold, title, 23, width - left - right)) {
    current.drawText(line, { x: left, y, size: 23, font: bold }); y -= 29;
  }
  y -= 8;
  for (const line of wrapped(serif, citation, 13, width - left - right)) {
    current.drawText(line, { x: left, y, size: 13, font: serif,
      color: pdf.rgb(.2, .2, .2) }); y -= 18;
  }
  current.drawLine({ start: { x: left, y: y - 6 }, end: { x: width - right, y: y - 6 },
    thickness: .8, color: pdf.rgb(.6, .6, .6) });
  y -= 34;
  type Run = { text: string; font: pdfLibrary.PDFFont };
  const inline = (node: Nodes, strong = false, emphasis = false): Run[] => {
    if (node.type === "strong") strong = true;
    if (node.type === "emphasis") emphasis = true;
    const font = strong ? emphasis ? boldItalic : bold : emphasis ? italic : serif;
    if (node.type === "break") return [{ text: "\n", font }];
    if (node.type === "inlineCode" || node.type === "code") return [{ text: node.value, font: mono }];
    if (node.type === "image" || node.type === "imageReference") return [{ text: node.alt ?? "", font }];
    if ("children" in node) return node.children.flatMap(child => inline(child, strong, emphasis));
    return "value" in node ? [{ text: node.value, font }] : [];
  };
  const runsText = (runs: Run[]) => runs.map(run => run.text).join("").split(/\s+/u).join(" ").trim();
  const layout = (runs: Run[], size: number, available: number) => {
    // A line opened by a newline starts a paragraph of its own; one opened by wrapping does not.
    const lines: Array<Run[] & { opens?: boolean }> = [[]];
    let used = 0;
    for (const run of runs) for (const token of pdfText(run.text).split(/(\n|[^\S\n]+)/u)) {
      if (!token) continue;
      if (token === "\n") { lines.push(Object.assign([], { opens: true })); used = 0; continue; }
      const whitespace = /^\s+$/u.test(token), text = whitespace ? " " : token;
      const tokenWidth = run.font.widthOfTextAtSize(text, size);
      if (used && used + tokenWidth > available) { lines.push([]); used = 0; }
      if (whitespace && !used) continue;
      // Split oversized words too, so long URLs and identifiers stay inside the page.
      for (const character of text) {
        const advance = run.font.widthOfTextAtSize(character, size);
        if (used + advance > available && used) { lines.push([]); used = 0; }
        const line = lines[lines.length - 1], last = line[line.length - 1];
        if (last?.font === run.font) last.text += character;
        else line.push({ text: character, font: run.font });
        used += advance;
      }
    }
    return lines;
  };
  const drawLine = (runs: Run[], x: number, size: number) => {
    for (const run of runs) {
      current.drawText(run.text, { x, y, size, font: run.font });
      x += run.font.widthOfTextAtSize(run.text, size);
    }
  };
  // The shared provider grammar reads the source's sections; where each block lands gives
  // the outline its pages, and a provision's depth its indent.
  const structured = input.kind === "case" || input.kind === "legislation" ? await structureNative()
    .deriveDocumentStructure({ kind: "provider_text", input: { provider: "a2aj", citation: input.citation,
      source_kind: input.kind === "case" ? "cases" : "laws", text: input.text } }).catch(() => null) : null;
  const sections = structured ? structureNative().documentOutline(structured) : [];
  const depths = new Map((structured ? structureNative().documentAnchors(structured, input.text.length) : [])
    .filter(anchor => anchor.kind === "section").reverse()
    .map(anchor => [anchor.start, anchor.label.split("(").length - 1]));
  const placed: Array<{ start: number; pageIndex: number; note?: string; heading?: number; title?: string }> = [];
  let placing: Omit<(typeof placed)[number], "pageIndex"> | null = null;
  // Paragraphs sit about half a line apart, whether the source parts them with a blank
  // line or a single newline; a heading takes a little more above it. A gap never opens a page.
  const gap = (size: number) => size * .6, atTop = () => y >= height - top;
  const draw = (runs: Run[], indent = 0, size = 10.5, heading = false) => {
    const leading = size + 4, lines = layout(runs, size, width - left - right - indent);
    if (heading && !atTop()) y -= gap(size);
    const extent = lines.length * leading + lines.filter(line => line.opens).length * gap(size);
    if (extent <= height - top - bottom - 18 && y - extent < bottom + 18) { current = page(); y = height - top; }
    for (const line of lines) {
      if (line.opens && !atTop()) y -= gap(size);
      if (y < bottom + leading) { current = page(); y = height - top; }
      if (placing) { placed.push({ ...placing, pageIndex: pages.length - 1 }); placing = null; }
      drawLine(line, left + indent, size);
      y -= leading;
    }
    y -= gap(heading ? 10.5 : size);
  };
  const block = (node: Nodes, indent = 0) => {
    if (node.type === "definition") return;
    const start = node.position?.start.offset;
    if (start !== undefined && node.type !== "root" && node.type !== "list" && node.type !== "listItem") {
      const text = runsText(inline(node));
      placing = { start, ...(node.type === "heading" ? { heading: node.depth, title: text }
        : node.type === "paragraph" && node.children.length === 1 && node.children[0].type === "strong"
          ? { note: text } : {}) };
      // A paragraph (a) sits under its subsection, a subparagraph (i) under that.
      if (node.type === "paragraph") indent += 14 * Math.max(0, (depths.get(start) ?? 0) - 1);
    }
    if (node.type === "list") {
      node.children.forEach((item, index) => {
        const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : "\u00b7 ";
        item.children.forEach((child, childIndex) => {
          if (childIndex === 0 && child.type === "paragraph")
            draw([{ text: marker, font: serif }, ...inline(child)], indent + 14);
          else block(child, indent + 14);
        });
      });
    } else if (node.type === "blockquote") node.children.forEach(child => block(child, indent + 18));
    else if (node.type === "root" || node.type === "listItem") node.children.forEach(child => block(child, indent));
    else if (node.type === "thematicBreak") {
      if (y < bottom + 20) { current = page(); y = height - top; }
      current.drawLine({ start: { x: left + indent, y }, end: { x: width - right, y }, thickness: .5 });
      y -= 14;
    } else if (node.type === "table") {
      const columnWidth = (width - left - right - indent) / node.children[0].children.length;
      node.children.forEach((row, index) => {
        const cells = row.children.map(cell => layout(inline(cell, index === 0), 10.5, columnWidth - 12));
        const count = Math.max(...cells.map(cell => cell.length));
        if (count * 14.5 < height - top - bottom - 18 && y - count * 14.5 < bottom + 18) {
          current = page(); y = height - top;
        }
        for (let line = 0; line < count; line++) {
          if (y < bottom + 14.5) { current = page(); y = height - top; }
          cells.forEach((cell, column) => drawLine(cell[line] ?? [], left + indent + column * columnWidth, 10.5));
          y -= 14.5;
        }
        current.drawLine({ start: { x: left + indent, y: y + 4 },
          end: { x: width - right, y: y + 4 }, thickness: index ? .25 : .75,
          color: pdf.rgb(.6, .6, .6) });
        y -= 6;
      });
      y -= 3;
    } else draw(inline(node, node.type === "heading"), indent,
      node.type === "heading" ? 17 - node.depth : 10.5, node.type === "heading");
  };
  block(fromMarkdown(input.text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }));
  // Headings below the title, then each top-level section titled with its marginal note.
  let headingLevel = 0;
  const outline = nestedOutline([...placed.filter(item => (item.heading ?? 0) > 1).map(item => ({
    start: item.start, kind: "heading", level: item.heading!, title: item.title!, pageIndex: item.pageIndex })),
  ...sections.filter(entry => entry.kind === "section").map(entry => {
    const at = placed.reduce((last, item, index) => item.start <= entry.start ? index : last, -1);
    const note = placed[at - 1]?.note;
    return { start: entry.start, kind: "section", level: 0, pageIndex: placed[at]?.pageIndex,
      title: pdfText(note ? `${entry.title} ${note}` : entry.title) };
  })].sort((a, b) => a.start - b.start).map(entry => {
    if (entry.kind === "heading") headingLevel = entry.level;
    return { ...entry, title: pdfText(entry.title), level: entry.kind === "heading" ? entry.level : headingLevel + 1 };
  }));
  if (outline.length) applyOutlines(document, outline, false);
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
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, allowIncomplete = false) {
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
      ? [loadAuthorityPdf(pdf, source.sources, entry.name, attached, undefined, allowIncomplete)
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
    // An authority with neither a public link nor an appended PDF is listed without a link.
    if (start !== undefined) addLink(page, rect, document.getPage(start));
    else if (entry.sourceUrl) addLink(page, rect, entry.sourceUrl);
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
  pageTextByPage?: string[]; ocrTextByPage?: string[]; pageLabels?: (string | null)[]; pageBindings?: PdfPageBinding[];
  passageGeometry?: NativePdfPassageGeometry; outline?: PdfOutline[] };
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
  _pdf: PdfModule, document: PdfDocument, draft: AuthoritiesDraft, authority: AuthorityIdentity,
  source: AuthoritiesBoundPdf, text: NonNullable<AuthoritiesBuildInput["sources"]>[string] = {},
  regenerate = false,
) {
  const saved = regenerate ? undefined : annotationSetForSource(authority.annotations,
    source.bindingRole, source.sourceSha256);
  if (saved) return { annotations: saved, pageMarked: [] };
  const pages = document.getPages().map(page => {
    const crop = page.getCropBox(), rotated = Math.abs(page.getRotation().angle % 180) === 90;
    return { width: rotated ? crop.height : crop.width, height: rotated ? crop.width : crop.height };
  });
  const requirePrinted = attachedAuthoritySources(authority.source)
    .find(({ bindingRole }) => bindingRole === source.bindingRole)?.origin === "manual";
  return initialAuthorityAnnotations({ sourceSha256: source.sourceSha256,
    style: draft.settings.passageMarking, geometry: text.passageGeometry, pages,
    requirePrintedParagraphLocator: requirePrinted,
    citedPages: citedSourcePages(draft, authority.id, text.pageTextByPage ?? [],
      text.pageBindings,
      document.getPageCount(), text.passageGeometry, requirePrinted),
    exclusions: new Set((authority.highlightExclusions ?? []).map(({ kind, label }) => `${kind.trim()}\0${label.trim()}`)) });
}

async function loadAuthorityPdf(
  pdf: PdfModule, sources: AttachedAuthoritySource[], label: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>,
  editing?: { draft: AuthoritiesDraft; authority: AuthorityIdentity },
  allowIncomplete = !!editing?.draft.settings.allowIncomplete,
) {
  const loaded = await Promise.all(sources.map(async (source) => ({ source,
    document: allowIncomplete && attached[source.bindingRole]?.bytes === undefined
      ? await missingSourcePdf(pdf, label, false, `${source.filename} is unavailable. This draft is incomplete.`)
      : await loadBookPdf(pdf, source, label, attached),
    text: attached[source.bindingRole] })));
  const markedPages = new Set<number>();
  // Each source keeps its publisher's bookmarks and the headings and sections read from it.
  const outline: PdfOutline[] = [];
  let sourceOffset = 0;
  for (const item of loaded) {
    outline.push(...sourceOutline(readOutlines(item.document, sourceOffset),
      nestedOutline((item.text?.outline ?? []).map(entry => ({ ...entry,
        pageIndex: entry.pageIndex === undefined ? undefined : sourceOffset + entry.pageIndex })))));
    if (editing && attached[item.source.bindingRole]?.bytes !== undefined) {
      const { annotations } = prepareAuthorityAnnotations(pdf, item.document, editing.draft,
        editing.authority, item.source, item.text);
      writeAuthorityAnnotations(pdf, item.document, annotations, item.source.bindingRole);
      annotations.marks.forEach(mark => mark.fragments.forEach(fragment =>
        markedPages.add(sourceOffset + fragment.pageNumber - 1)));
    }
    sourceOffset += item.document.getPageCount();
  }
  if (loaded.length === 1) return { document: loaded[0].document, markedPages, outline,
    pageBindings: loaded[0].text?.pageBindings,
    pageTextByPage: loaded[0].text?.pageTextByPage,
    ocrTextByPage: loaded[0].text?.ocrTextByPage,
    passageGeometry: loaded[0].text?.passageGeometry };
  const document = await pdf.PDFDocument.create();
  const pageTextByPage: string[] = [], ocrTextByPage: string[] = [];
  const pageBindings: PdfPageBinding[] = [];
  const geometries: Array<{ offset: number; value: NativePdfPassageGeometry }> = [];
  let offset = 0;
  for (const item of loaded) {
    const count = item.document.getPageCount();
    await appendPages(document, item.document);
    pageBindings.push(...Array.from({ length: count }, (_, index): PdfPageBinding => ({
      observed: null, label: null, source: null, status: "unknown",
      ...item.text?.pageBindings?.[index], pdfPage: offset + index + 1,
    })));
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
  return { document, pageTextByPage, pageBindings, markedPages, outline,
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
  progress?: (message: string) => void,
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
    authorityReproducedInBook(draft, authority)));
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
  let marked = 0;
  const marking = () => progress?.(`Marking passages · ${marked} of ${authorityRows.length}`);
  marking();
  const [authoritySources, supplementalSources, customCover, customIndex] = await Promise.all([
    Promise.all(authorityRows.map(async (entry): Promise<LoadedBookPdf> => {
      const source = entry.authority.source;
      const loaded = source.kind === "attached"
        ? await loadAuthorityPdf(pdf, source.sources, entry.name, attached,
          { draft, authority: entry.authority })
        : { document: await missingSourcePdf(pdf, entry.name, federal) };
      if (source.kind === "attached" && draft.settings.allowIncomplete &&
          authoritySourceRequirement(draft, entry.authority, profile.requirements) ===
            "incomplete-enactment") {
        const missingLanguage = source.sources.some(({ language }) => language === "en") ? "French" : "English";
        const stub = await missingSourcePdf(pdf, entry.name, federal,
          `${missingLanguage} version not attached. This draft is incomplete.`);
        await appendPages(loaded.document, stub);
      }
      marked += 1; marking();
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
    const extract = federalPaperExtract(draft, source);
    return { ...source, pageIndices: extract?.pageIndices ?? source.document.getPageIndices(),
      databaseReference: extract?.databaseReference ?? null };
  });
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const rowGroups = groups.flatMap(({ label, entries }) => {
    const kept = entries.filter(({ authority }) => authorityReproducedInBook(draft, authority))
      .map(({ authority }) => rowByKey.get(`authority:${authority.id}`)!);
    return kept.length ? [{ label, entries: kept }] : [];
  });
  if (supplementRows.length) rowGroups.push({ label: "Documents", entries: supplementRows });
  progress?.("Preparing the book");
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
      const requirePrinted = source.authority && attachedAuthoritySources(source.authority.source)
        .some(({ origin }) => origin === "manual");
      // One bookmark per cited passage, where it begins, in the order of the pages.
      const bookmarks = (source.passageGeometry?.targets.flatMap((target) =>
        target.status === "found" && (!requirePrinted || hasPrintedParagraphLocator(target))
          ? target.pages.slice(0, 1).flatMap(({ pageNumber }) => {
          const key = `${target.locatorKind}\0${target.locator}`;
          if (seen.has(key)) return []; seen.add(key);
          const title = target.locatorKind === "paragraph" ? "para" : target.locatorKind === "section" ? "s" : "p";
          return [{ title: `${title} ${target.locator}`, pageIndex: pageNumber - 1 }];
        }) : []) ?? []).sort((left, right) => left.pageIndex - right.pageIndex);
      const cited = source.authority ? citedSourcePages(draft, source.authority.id,
        source.pageTextByPage ?? [], undefined, source.document.getPageCount(), source.passageGeometry,
        !!requirePrinted) : new Set<number>();
      const ocrTextByPage = source.authority ? source.ocrTextByPage?.map((text, index) =>
        draft.settings.scannedPdfPolicy === "full" ||
          draft.settings.scannedPdfPolicy === "cited-pages" && cited.has(index)
          ? pdfNormalized(text).replace(/[^\x20-\x7e\u00a0-\u00ff\r\n]/gu, "?") : "") : undefined;
      return { key: source.key, name: source.name, tab: source.tab, sourceUrl: source.sourceUrl,
        bytes: await source.document.save({ useObjectStreams: false }),
        pageIndices: source.pageIndices, databaseReference: source.databaseReference, ocrTextByPage, bookmarks,
        ...(source.outline?.length ? { outline: source.outline } : {}) };
    })),
  };
}

async function bookArtifacts(plan: PreparedAuthoritiesBook, signal?: AbortSignal) {
  return (await renderAuthoritiesBook(pdfLibrary, plan, signal)).map((item) =>
    ({ ...artifact(item.role, item.filename, item.mimeType, Buffer.from(item.bytes), item.pageCount),
      bookPlacements: item.placements }));
}

export function citedSourcePages(draft: AuthoritiesDraft, authorityId: string, pages: string[],
  pageBindings?: readonly PdfPageBinding[], pageCount = pages.length, geometry?: NativePdfPassageGeometry,
  requirePrintedParagraphLocator = false) {
  const authority = draft.authorities[authorityId];
  const locators = [...(authority?.locators ?? []), ...Object.values(draft.occurrences)
    .flatMap((occurrence) => occurrence.authorityId === authorityId
      ? occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text })) : [])];
  const result = new Set<number>();
  const found = (target: NativePdfPassageGeometry['targets'][number]) => target.status === "found" &&
    (!requirePrintedParagraphLocator || hasPrintedParagraphLocator(target));
  for (const { kind, label } of locators) {
    if (kind === "page") {
      if (pageBindings?.length === pageCount) resolvePrintedPages(label, pageBindings).forEach(index => result.add(index));
    }
    // A paragraph the geometry could not place still has a page: the one whose
    // text prints its number. That page carries the mark instead of nothing.
    if (kind === "paragraph" && !geometry?.targets.some((target) => found(target) &&
        target.locatorKind === kind && target.locator.trim() === label.trim())) {
      const number = /\d+/u.exec(label)?.[0];
      const index = number ? pages.findIndex((text) =>
        new RegExp(String.raw`(?:^|\s)\[\s*${number}\s*\]`, "u").test(text)) : -1;
      if (index >= 0) result.add(index);
    }
  }
  geometry?.targets.filter(found).forEach(target =>
    target.pages.forEach(({ pageNumber }) => { if (pageNumber > 0 && pageNumber <= pageCount) result.add(pageNumber - 1); }));
  return result;
}


function federalPaperExtract(draft: AuthoritiesDraft, source: LoadedBookPdf) {
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
  const cited = citedSourcePages(draft, source.authority.id, text, source.pageBindings, pageCount, source.passageGeometry,
    attachedAuthoritySources(source.authority.source).some(({ origin }) => origin === "manual"));
  source.markedPages?.forEach(index => cited.add(index));
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
  if (input.draft.settings.finalPdf && !wanted.includes("book")) wanted.push("book");
  const profile = authoritiesProfile(input.draft.settings.profileId);
  const strictBook = wanted.includes("book") && !input.draft.settings.allowIncomplete;
  const requirements = {
    completeBookSources: strictBook && !!profile.requirements?.completeBookSources,
    bilingualEnactments: strictBook && !!profile.requirements?.bilingualEnactments,
    unlinkedPdfTableSources: !input.draft.settings.allowIncomplete && !!profile.requirements?.unlinkedPdfTableSources,
  };
  const owed = (authority: AuthorityIdentity) => authorityName(input.draft, authority);
  const sourceMessage = {
    missing: (authority: AuthorityIdentity) =>
      `Attach a complete PDF or exclude ${owed(authority)} before building this ${profile.label} book.`,
    "incomplete-enactment": (authority: AuthorityIdentity) =>
      `Attach one bilingual PDF or both English and French PDFs for ${owed(authority)}.`,
    unlinked: (authority: AuthorityIdentity) => input.draft.import.kind === "document" &&
      input.draft.import.fileType === "docx" && authority.source.kind === "attached"
      ? `Add a publicly accessible source link for ${owed(authority)}. To append an unlinked authority, use the final filing PDF.`
      : `Add a publicly accessible source link or PDF for ${owed(authority)}.`,
  };
  // Book obligations are reported in the user's book order, the table's link
  // obligation in the order the court reads the table.
  for (const [reason, order] of [["missing", "book"], ["incomplete-enactment", "book"],
    ["unlinked", "table"]] as const) {
    const owing = (order === "book"
      ? input.draft.authorityOrder.map((id) => input.draft.authorities[id])
      : tableGroups.flatMap(({ entries }) => entries).map(({ authority }) => authority))
      .find((authority) => authoritySourceRequirement(input.draft, authority, requirements) === reason);
    if (owing) throw new Error(sourceMessage[reason](owing));
  }
  // A Word brief's copy carries the chosen marks, its tab references, or both.
  const tabbed = (input.draft.settings.citationSuffix ?? "none") !== "none" &&
    input.draft.import.kind === "document" && input.draft.import.fileType === "docx";
  if (input.draft.insertIntoDocument || tabbed) wanted.push("annotated-document");
  const brief = authoritiesBriefPdf(input.draft), briefSource = brief ? sources[brief.bindingRole] : undefined;
  // A Word brief reaches the final PDF through the host's converter or a PDF the user saved from Word;
  // until that PDF is added the final PDF waits for it, and the other outputs build without it.
  const briefInput = input.draft.import.kind === "document" && input.draft.settings.finalPdf &&
    input.draft.import.fileType === "docx" && (briefSource?.bytes || !input.finalPdfSource)
    ? ((filename: string) => {
      if (!brief) return null;
      if (!briefSource?.bytes) throw new Error(`${brief.filename} is unavailable. In Word, save ${filename} as PDF, then add it again.`);
      assertBriefPdfMatches(input.draft, briefSource.pageTextByPage ?? [], brief.filename);
      return { role: brief.bindingRole, bytes: briefSource.bytes, resolved: resolvedInput(brief.bindingRole,
        input.draft.bindings[brief.bindingRole], brief.filename, brief.sourceSha256, briefSource.resolved) };
    })(input.draft.import.filename) : undefined;
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
  const inputs = [...imported, ...briefInput ? [{ role: briefInput.role, resolved: briefInput.resolved }] : [],
    ...input.draft.authorityOrder.flatMap((id) => {
    const authority = input.draft.authorities[id];
    if (authority.source.kind !== "attached") return [];
    return authority.source.sources.map((source) => {
      const role = source.bindingRole;
      if (input.draft.settings.allowIncomplete && sources[role]?.bytes === undefined &&
          sources[role]?.resolved === undefined) return null;
      return { role, resolved: resolvedInput(role, input.draft.bindings[role],
        source.filename, source.sourceSha256, sources[role]?.resolved) };
    }).filter((value): value is NonNullable<typeof value> => value !== null);
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
  input.progress?.(wanted.includes("book") ? "Preparing the book" : "Building the table");
  const built = (await Promise.all(wanted.map(async (role) => role === "table"
    ? [await tableArtifact(tableGroups, `${base}.table-of-authorities.docx`, subtitle,
      input.draft.settings.tableDelivery === "linked-append", wanted.includes("book"))]
    : role === "book"
      ? assembleBook(await prepareAuthorityBook(input.draft, bookGroups, `${base}${input.draft.settings.allowIncomplete ? ".draft-incomplete" : ""}.${bookName}.pdf`, subtitle,
        sources, input.signal, input.progress).then((plan) => {
          input.progress?.("Assembling the book"); return plan;
        }), input.signal)
      : input.draft.import.kind === "document" && input.draft.import.fileType === "pdf"
        ? [await filingPdfArtifact(tableGroups,
          `${base}.with-table-of-authorities.pdf`,
          sources[input.draft.import.bindingRole]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "", sources, !!input.draft.settings.allowIncomplete)]
        : [await documentArtifact(input.draft, tableGroups,
          `${base}.${!input.draft.insertIntoDocument ? "with-tab-references"
            : input.draft.settings.tableDelivery === "native-marks" ? "marked-authorities" : "with-table-of-authorities"}.docx`,
          sources[input.draft.import.kind === "document"
            ? input.draft.import.bindingRole : "source"]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "")]))).flat();
  let linkWarnings: AuthoritiesBuildReceipt["linkWarnings"];
  if (input.draft.settings.finalPdf && input.draft.import.kind === "document" && briefInput !== null) {
    input.signal?.throwIfAborted();
    const importedFilename = input.draft.import.filename;
    const source = sources[input.draft.import.bindingRole]?.bytes ?? new Uint8Array();
    if (!source.byteLength || sha256(Buffer.from(source)) !== imported[0]?.resolved.sha256)
      throw new Error("The imported document changed before final PDF export.");
    input.progress?.("Assembling the final PDF");
    const sourcePdf = input.draft.import.fileType === "pdf" ? source : briefInput?.bytes ?? await (async () => {
      if (!input.finalPdfSource) throw new Error("Word-to-PDF conversion is unavailable for final export.");
      if (!input.draft.insertIntoDocument && (!input.draft.settings.citationSuffix || input.draft.settings.citationSuffix === "none") &&
          !input.draft.settings.linkTabs && !input.draft.settings.linkPinpoints)
        return input.finalPdfSource(source, importedFilename);
      const document = await documentArtifact(input.draft, tableGroups,
        importedFilename, source, imported[0].resolved.sha256, true);
      return input.finalPdfSource(document.bytes, importedFilename);
    })();
    const filename = `${base}${input.draft.settings.allowIncomplete ? ".draft-incomplete" : ""}.final.pdf`;
    const combined = await assembleFinalAuthoritiesPdf(input, sourcePdf,
      built.filter(({ role }) => role.startsWith("book")));
    built.push(artifact("final-pdf", filename, "application/pdf", combined.bytes, combined.pageCount));
    wanted.push("final-pdf");
    if (input.draft.settings.linkTabs || input.draft.settings.linkPinpoints) {
      linkWarnings = combined.warnings;
      if (linkWarnings.length) {
        const reasons = { "citation-location": "Citation location could not be verified",
          "source-missing": "Source PDF unavailable", "pinpoint-unlocated": "Pinpoint not located",
          "pinpoint-ambiguous": "Pinpoint is ambiguous", "web-link": "The brief already links it to a web page" };
        const one = linkWarnings.length === 1;
        const report = [filename, `${linkWarnings.length} link${one ? " wasn't" : "s weren't"} added. Add ${one ? "it" : "them"} in a PDF editor.`, "",
          ...linkWarnings.map((row) => `${row.citation}${row.pinpoint ? ` — ${row.pinpoint}` : ""}` +
            `${row.tab ? ` [${row.tab}]` : ""}${row.sourcePageNumber ? `, source PDF page ${row.sourcePageNumber}` : ""}` +
            `: ${reasons[row.reason]}.`)].join("\n");
        built.push(artifact("link-report", `${base}.unlinked-citations.txt`, "text/plain", Buffer.from(report), null));
      }
    }
  }
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
      steps: item.role === "link-report" ? ["Listed citations needing manual PDF links"]
        : item.role === "final-pdf" ? ["Combined the brief and complete Book of Authorities",
          "Preserved book index links and bookmarks",
          ...(input.draft.settings.linkTabs ? ["Linked citations to book tabs"] : []),
          ...(input.draft.settings.linkPinpoints ? ["Linked verified manual PDF pinpoints"] : [])]
        : item.role === "table" ? ["Rendered grouped Table of Authorities"]
        : item.role.startsWith("book")
          ? ["Combined attached PDFs", "Added index links and PDF bookmarks"]
          : item.mimeType === "application/pdf"
            ? ["Appended the linked Table of Authorities",
              ...tableGroups.some(({ entries }) => entries.some(({ sourceUrl }) => !sourceUrl))
                ? ["Appended unlinked authority PDFs with bookmarks"] : []]
          : [...!input.draft.insertIntoDocument ? []
            : input.draft.settings.tableDelivery === "linked-append"
              ? ["Appended the linked Table of Authorities to the Word document"]
              : ["Marked citations with native Word TA fields",
                ...input.draft.settings.tableDelivery === "native-marks" ? []
                  : ["Added a native Word TOA field on a final page"]],
            ...tabbed ? ["Added the tab reference after each citation"] : []],
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
    ...(linkWarnings && { linkWarnings }),
  } };
}
