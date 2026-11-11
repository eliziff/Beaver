import { annotatePdf } from 'mike/shared/pdf-annotation-writer.mjs';
import { footnotePropositions, markedQuotations, singleSourceFootnote } from "./authoritiesQuotations";
import { legalSourceLocatorAnchor, sourceUrl as legalSourceUrl } from "./legalSourceLinks";
import type { A2AJLocatorKind } from "./legalSources/a2aj";
import type { AuthoritiesBuildReceipt,
  AuthoritiesOutputRole } from "mike/shared/authorities-contract.d.ts";
import {
  authoritiesBookPdfs,
  attachedAuthoritySources,
  authoritiesProfile,
  authorityCitationForms,
  validateAuthoritiesDraft,
  authorityReproducedInBook,
  authoritySourceRequirement,
  authoritySourceUrl,
  type AttachedAuthoritySource,
  type AuthoritiesBoundPdf,
  type AuthoritiesDraft,
  type AuthorityIdentity,
} from "./authoritiesDomain";
import { ANNOTATION_SCHEMA, annotationSetForSource, decodeAnnotationSet } from "mike/shared/pdf-annotations.mjs";
import { locatorLabel } from "./authoritiesAnnotations";
import type { AuthorityPdfReading } from "./authorityPdfText";
import type { BookPart } from "mike/shared/engine-types/BookPart";
import type { BookRow } from "mike/shared/engine-types/BookRow";
import type { PaperCover } from "mike/shared/engine-types/PaperCover";
import type { PassageGeometry } from "mike/shared/engine-types/PassageGeometry";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { applyTableOfAuthorities, entryOrder, type DocxAuthorityMark } from "./docxOperations";
import { structureNative } from "./structureNative";
import type { OutlineEntry } from "mike/shared/engine-types/OutlineEntry";
import type { PassageTarget } from "mike/shared/engine-types/PassageTarget";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput } from "./workProduct";
import { authorityCitation, authorityProcedureInput, deriveAuthorityProcedure, tabLabel, tabReference } from "mike/shared/authorities-order.mjs";
import { urlHostname } from "mike/shared/runtime/canliiPageUrls.mjs";
import { assembleFinalAuthoritiesPdf, assertBriefPdfMatches, briefOccurrencePages, filingLinkUrl,
  filingTabText } from "./authoritiesFinalPdf";
import { authoritiesBriefPdf, authorityExcerpt, authorityTabbed, courtExtract, excerptContext,
  freeDatabaseCase, STATUTE_EXCERPT_PAGES } from "mike/shared/authorities-sources.mjs";

export type { AuthoritiesBuildReceipt, AuthoritiesOutputRole };
export type AuthoritiesBuildArtifact = {
  role: AuthoritiesOutputRole;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  pageCount: number | null;
  receipt: WorkProductBuildReceipt;
  bookPlacements?: Awaited<ReturnType<ReturnType<typeof structureNative>["renderAuthoritiesBook"]>>[number]["placements"];
};
export type AuthoritiesBuildResult = {
  artifacts: Partial<Record<AuthoritiesOutputRole, AuthoritiesBuildArtifact>>;
  receipt: AuthoritiesBuildReceipt;
};
export type AuthoritiesBuildInput = {
  draft: AuthoritiesDraft;
  title: string;
  workProduct: { id: string; revision: number };
  /** Each source as read: an authority's PDF as its reading (`plain`: read for its pages alone), the brief's or
   *  filing's as its pages' text and the citations placed on them. */
  sources?: Record<string, { bytes?: Uint8Array; resolved?: ResolvedWorkProductInput;
    reading?: AuthorityPdfReading & { plain?: boolean }; pageTextByPage?: string[];
    passageGeometry?: PassageGeometry; outline?: Array<OutlineEntry & { title: string }> }>;
  signal?: AbortSignal;
  finalPdfSource?: (bytes: Uint8Array, filename: string) => Promise<Uint8Array>;
  /** Told what the build is doing, as it starts each part. */
  progress?: (message: string) => void;
  /** A statute's text from its provider, for the cited provisions its PDF does not place. */
  statuteText?: StatuteText;
};
export type StatuteText = (authority: AuthorityIdentity, signal?: AbortSignal) =>
  Promise<{ text: string; provider: string } | null>;

export type AuthorityPassageRequest = {
  locators: Array<{ kind: PassageTarget["locatorKind"]; label: string }>;
  exactQuotes: string[];
};

/** Explicit source locators and exact quoted passages tied to each citation context. */
export function authorityPassageRequests(draft: AuthoritiesDraft, authorityId: string) {
  const quoteByFootnote = footnotePropositions(draft.units), requests: AuthorityPassageRequest[] = [];
  const valid = (locator: { kind: string; label: string }): locator is AuthorityPassageRequest["locators"][number] =>
    ["paragraph", "section", "article", "rule", "page"].includes(locator.kind) && !!locator.label.trim();
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
  const grouped = new Map<string, Omit<PassageTarget, "id"> & { quotes: Set<string> }>();
  for (const request of authorityPassageRequests(draft, authorityId)) {
    for (const locator of request.locators) {
      const key = `${locator.kind}\0${locator.label}`;
      const target = grouped.get(key) ?? { locatorKind: locator.kind, locator: locator.label,
        quotes: new Set<string>() };
      request.exactQuotes.forEach((quote) => target.quotes.add(quote)); grouped.set(key, target);
    }
  }
  // A statute's provisions are placed in the Act the brief cites, where its PDF prints several.
  const authority = draft.authorities[authorityId];
  const instrument = authority?.kind === "legislation" ? (authority.displayName ?? authority.name)?.trim() : undefined;
  return [...grouped.values()].flatMap(({ quotes, ...target }) => {
    const values = [...quotes];
    return Array.from({ length: Math.max(1, Math.ceil(values.length / 20)) }, (_, index) =>
      ({ ...target, exactQuotes: values.slice(index * 20, index * 20 + 20),
        ...(instrument && target.locatorKind !== "page" && target.locatorKind !== "paragraph" ? { instrument } : {}) }));
  }).map((target, index) => ({ id: `passage:${index + 1}`, ...target }));
}

/** The paragraphs an excerpted case keeps before and after each cited paragraph, placed as its cited ones are,
 *  under ids of their own ("context:44") that keep them from being marked or bookmarked. The court's extract
 *  keeps its paragraphs 1 and 2 instead: its pages run through the one its reasons begin on, found by either where
 *  the other is printed more than once (a headnote that cites the reasons' paragraph 1). */
export function excerptContextTargets(draft: AuthoritiesDraft, authority: AuthorityIdentity): PassageTarget[] {
  const { paragraphs } = excerptContext(draft.settings);
  if (authority.kind !== "case" || !authorityExcerpt(draft, authority)) return [];
  if (courtExtract(draft, authority)) return ["1", "2"].map((locator) =>
    ({ id: `context:${locator}`, locatorKind: "paragraph", locator, exactQuotes: [] }));
  if (!paragraphs) return [];
  const cited = [...authority.locators.map(({ kind, label }) => ({ kind, first: label, last: label })),
    ...Object.values(draft.occurrences).flatMap((occurrence) => occurrence.authorityId === authority.id
      ? occurrence.pinpoints.map(({ kind, text, first, last }) => ({ kind, first: first ?? text, last: last ?? first ?? text })) : [])];
  const numbers = new Set<number>();
  for (const { kind, first, last } of cited) {
    const [from, to] = [Number(first), Number(last)];
    if (kind !== "paragraph" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
    for (let step = 1; step <= paragraphs; step++) { if (from - step >= 1) numbers.add(from - step); numbers.add(to + step); }
  }
  return [...numbers].map((number) => ({ id: `context:${number}`, locatorKind: "paragraph", locator: String(number), exactQuotes: [] }));
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
export function authorityFilingTargets(draft: AuthoritiesDraft, briefPageText?: string[]): PassageTarget[] {
  const tabs = new Map(authorityProcedure(draft, "book").map(({ id, tab }) => [id, tab]));
  const located = briefPageText && briefOccurrencePages(draft, briefPageText);
  return draft.units.flatMap((unit) => unit.occurrenceIds.flatMap((id) => {
    const occurrence = draft.occurrences[id], authority = draft.authorities[occurrence?.authorityId ?? ""];
    const pages = located ? located.has(id) ? [located.get(id)!] : [] : unit.pageNumbers;
    if (!authority || !authorityTabbed(draft, authority) || !pages.length) return [];
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

/** How the book reads its scans. A book built from PDFs cites no page of them, so where only the
 *  cited pages are to be read, every page is: the pages it shows recognizing are the pages it keeps. */
export function bookScanPolicy(draft: AuthoritiesDraft): AuthoritiesDraft["settings"]["scannedPdfPolicy"] {
  return draft.import.kind === "manual" && draft.settings.scannedPdfPolicy === "cited-pages"
    ? "full" : draft.settings.scannedPdfPolicy;
}

export function authoritiesTextRoles(draft: AuthoritiesDraft) {
  const brief = authoritiesBriefPdf(draft);
  const filingRoles = brief ? [brief.bindingRole] : draft.settings.finalPdf && (draft.settings.linkTabs ||
    draft.settings.linkPinpoints) && draft.import.kind === "document" && draft.import.fileType === "pdf"
    ? [draft.import.bindingRole] : [];
  if (draft.outputMode === "table" && !draft.settings.finalPdf) return new Set(filingRoles);
  return new Set([...filingRoles, ...Object.values(draft.authorities).flatMap((authority) => {
    if (!authorityTabbed(draft, authority) || authority.source.kind !== "attached") return [];
    const requests = authorityPassageRequests(draft, authority.id);
    const locatorKinds = new Set(requests.flatMap(({ locators }) =>
      locators.map(({ kind }) => kind)));
    const needsOcr = draft.settings.scannedPdfPolicy !== "page-margin";
    const needsLinkGeometry = !!(draft.settings.finalPdf && draft.settings.linkPinpoints && requests.length);
    const needsLocatorText = (draft.settings.passageMarking !== "none" || draft.settings.finalPdf && draft.settings.linkPinpoints) &&
      [...locatorKinds].some((kind) => kind !== "page");
    const needsQuoteText = ["margin", "text"].includes(draft.settings.passageMarking) &&
      requests.some(({ exactQuotes }) => exactQuotes.length);
    // An authority that may go in as an excerpt is read for where its cited passages are; a decision the
    // court's extract takes, for where its reasons begin.
    const excerpt = (!!requests.length || courtExtract(draft, authority)) && authorityExcerpt(draft, authority) !== false;
    return authority.source.sources.flatMap(source => {
      const saved = annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
      return excerpt || needsOcr || needsLinkGeometry || !saved && (needsLocatorText || needsQuoteText)
        ? [source.bindingRole] : [];
    });
  })]);
}

type BareArtifact = Omit<AuthoritiesBuildArtifact, "receipt">;

type Entry = {
  authority: AuthorityIdentity;
  name: string;
  /** How many of the name's first characters are italic: its style of cause or title. */
  italic: number;
  citedAt: string;
  tab: string;
  sourceUrl: string | null;
};
type Group = { label: string; entries: Entry[] };

type RequestedRole = Exclude<AuthoritiesOutputRole, `book-${number}` | "link-report">;
const RENDERERS: Record<RequestedRole, string> = {
  table: "beaver.authorities.table-docx.v1",
  book: "beaver.authorities.book-pdf.v3",
  "annotated-document": "beaver.authorities.filing-output.v2",
  "final-pdf": "beaver.authorities.final-pdf.v1",
};

function citedPages(draft: AuthoritiesDraft, authorityId: string) {
  return [...new Set(draft.units.flatMap((unit) => unit.occurrenceIds.some((id) =>
    draft.occurrences[id]?.authorityId === authorityId) ? unit.pageNumbers : []))]
    .sort((left, right) => left - right).join(", ");
}

function citedPinpoints(draft: AuthoritiesDraft, authorityId: string) {
  const labels = Object.values(draft.occurrences).flatMap((occurrence) =>
    occurrence.authorityId === authorityId ? occurrence.pinpoints.map(({ kind, text }) =>
      locatorLabel(kind, text)) : []);
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
  const value = freeDatabaseCase(authority) && authoritySourceLink(authority);
  return value ? { url: value, host: urlHostname(value) } : null;
}

function groupedEntries(draft: AuthoritiesDraft, purpose: "table" | "book") {
  const planned = authorityProcedure(draft, purpose);
  const entry = ({ id, tab }: typeof planned[number]): Entry => {
    const authority = draft.authorities[id], { text, italic } = authorityCitation(draft, authority);
    return { authority, name: text, italic, citedAt: citedAt(draft, authority.id),
    tab, sourceUrl: authoritySourceLink(authority) }; };
  // A table in alphabetical order lists each group as Word sorts the brief's table: by the full citation.
  const alphabetical = purpose === "table" && draft.settings.tableOrder !== "first-reference";
  return [...new Set(planned.map(({ group }) => group))].map((label): Group => {
    const entries = planned.filter(({ group }) => group === label).map(entry);
    return { label, entries: alphabetical ? entries.sort((left, right) => entryOrder(left.name, right.name)) : entries };
  });
}

/** The table of authorities as its own Word document, read as the table in a Word brief reads: a plain
 *  bold heading, each group under a bold heading of its own, and each authority in full, its style of
 *  cause in italics and its link (when it has one) on the citation itself, then after a dotted leader
 *  the pages it is cited on (a PDF brief's) and its tab. A Court of Appeal table numbers each authority
 *  in the order the brief first cites it, its link printed beneath it for a reader on paper. */
async function tableArtifact(groups: Group[], filename: string, subtitle: string,
  linked = false, tabs = false, ruled?: { tabPrefix: string; location: AuthoritiesDraft["settings"]["tableLocation"] }) {
  const { AlignmentType, BorderStyle, Document, ExternalHyperlink, LeaderType, Packer, Paragraph, ShadingType, Tab, Table,
    TableCell, TableLayoutType, TableRow, TabStopType, TextRun, WidthType } = await import("docx");
  const heading = (text: string) => new Paragraph({ keepNext: true, spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true })] });
  const citation = ({ name, italic, sourceUrl }: Entry) => {
    const runs = [name.slice(0, italic), name.slice(italic)].flatMap((text, index) => text
      ? [new TextRun({ text, italics: !index })] : []);
    return sourceUrl ? [new ExternalHyperlink({ link: sourceUrl, children: runs })] : runs;
  };
  // Where an authority is cited is known for a PDF brief (its pages), never for a Word one (Word lays
  // it out): that column goes when no entry has it.
  const citedAt = groups.some(({ entries }) => entries.some(({ citedAt }) => citedAt && citedAt !== "—"));
  const width = 9360, stops = [
    ...citedAt ? [{ type: TabStopType.RIGHT, position: tabs ? width - 1100 : width, leader: LeaderType.DOT }] : [],
    ...tabs ? [{ type: TabStopType.RIGHT, position: width, leader: citedAt ? LeaderType.NONE : LeaderType.DOT }] : [],
  ];
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [heading(linked ? "TABLE OF AUTHORITIES" : "Table of Authorities"),
    ...(linked || !subtitle ? [] : [new Paragraph({ children: [new TextRun({ text: subtitle, italics: true })] })])];
  if (!groups.length) children.push(new Paragraph("No authorities."));
  // The ruled table, as court filings set it out: the tab, the authority and where it is cited, under
  // a header row Word repeats on each page, each group under a row of its own.
  else if (ruled) {
    const columns = [...tabs ? [864] : [], width - (tabs ? 864 : 0) - (citedAt ? 1872 : 0), ...citedAt ? [1872] : []];
    const cell = (runs: Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>>, column: number,
      { center = false, header = false, span = 1 } = {}) => new TableCell({ width: { size: columns[column], type: WidthType.DXA },
      columnSpan: span, ...header && { shading: { type: ShadingType.CLEAR, color: "auto", fill: "D9D9D9" } },
      children: [new Paragraph({ alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT, keepNext: span > 1,
        spacing: { before: 40, after: 40 }, children: runs })] });
    const line = { style: BorderStyle.SINGLE, size: 4, color: "auto" };
    const heads = [...tabs ? ["Tab"] : [], "Authority", ...citedAt ? [{ pages: "Cited at page(s)", pinpoints: "Pinpoint(s)",
      combined: "Cited at" }[ruled.location]] : []];
    children.push(new Table({ width: { size: width, type: WidthType.DXA }, columnWidths: columns, layout: TableLayoutType.FIXED,
      margins: { top: 29, bottom: 29, left: 108, right: 108 },
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: [new TableRow({ tableHeader: true, cantSplit: true, children: heads.map((text, index) =>
        cell([new TextRun({ text, bold: true })], index, { center: tabs && !index, header: true })) }),
      ...groups.flatMap((group) => [
        ...groups.length > 1 ? [new TableRow({ cantSplit: true, children: [cell([new TextRun({ text: group.label, bold: true })], 0,
          { span: columns.length })] })] : [],
        ...group.entries.map((entry) => new TableRow({ cantSplit: true, children: [
          ...tabs ? [cell([new TextRun(entry.tab.startsWith(ruled.tabPrefix) ? entry.tab.slice(ruled.tabPrefix.length) : entry.tab)], 0,
            { center: true })] : [],
          cell(citation(entry), tabs ? 1 : 0),
          ...citedAt ? [cell([new TextRun(entry.citedAt === "—" ? "" : entry.citedAt)], columns.length - 1)] : []] })),
      ])] }), new Paragraph(""));
  } else if (linked) groups.flatMap(({ entries }) => entries).forEach((entry, index) => {
    children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(`${index + 1}. `), ...citation(entry),
      ...entry.sourceUrl ? [new TextRun({ break: 1 }), new ExternalHyperlink({ link: entry.sourceUrl,
        children: [new TextRun({ text: entry.sourceUrl, style: "Hyperlink" })] })] : []] }));
  });
  else for (const group of groups) {
    children.push(heading(group.label));
    for (const entry of group.entries) children.push(new Paragraph({ tabStops: stops, spacing: { after: 80 },
      // The citation wraps short of the pages and the tab.
      indent: { left: 220, hanging: 220, right: stops.length ? width - stops[0].position + 720 : 0 },
      children: [...citation(entry), ...citedAt ? [new TextRun({ children: [new Tab(), entry.citedAt === "—" ? "" : entry.citedAt] })] : [],
        ...tabs ? [new TextRun({ children: [new Tab(), entry.tab] })] : []] }));
  }
  const document = new Document({ creator: "Beaver", title: "Table of Authorities",
    description: "Legal authorities",
    styles: { default: { document: { run: { font: "Times New Roman", size: 24, color: "000000" } } } },
    // Letter paper, as Canadian courts file.
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: {
      top: 1440, right: 1440, bottom: 1440, left: 1440,
    } } }, children }],
  });
  const bytes = await Packer.toBuffer(document);
  return artifact("table", filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes, null);
}

/** Where a citation's tab reference goes: after the short form the brief defines right after it
 *  ("… 2012 SCC 47 [Mabior] [Tab 3]"), whether or not the citation's span takes that bracket in. */
function afterShortForm(text: string, end: number) {
  const bracket = /^ ?\[[^[\]\n]{1,60}\]/u.exec(text.slice(end))?.[0];
  return bracket && !/^ ?\[(?:\d|Tab\b)/u.test(bracket) ? end + bracket.length : end;
}

function nativeMark(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  unitId: string, offset: number): DocxAuthorityMark {
  const citation = authority.citation.trim();
  const shortName = (authority.displayName ?? authority.name ?? citation).trim();
  const { text: longName, italic } = authorityCitation(draft, authority);
  return { unitId, offset, longName, italic, shortName: shortName || citation,
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
    if (!authority || !authorityTabbed(draft, authority) || !key || seen.has(key)) return [];
    seen.add(key);
    const tab = tabs.get(authority.id)!;
    // A linked tab needs its reference to click, even where none was chosen.
    const suffix = tabReference(draft.settings, tab) ?? (finalLinks && draft.settings.linkTabs ? `[${tab}]` : null);
    return [{ ...nativeMark(draft, authority, unit.id, afterShortForm(unit.text, occurrence.end)),
      mark: draft.insertIntoDocument, authorityId: authority.id,
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
  // A ruled table gives each authority's tab when there is a book to find it in.
  const prefix = draft.settings.tabPrefix ?? "Tab ";
  const linked = groups.flatMap(({ label: group, entries }) => entries.map(({ authority, name, italic, sourceUrl }) => {
    const tab = draft.outputMode === "table" ? undefined : tabs.get(authority.id);
    return { label: name, italic, url: sourceUrl, authorityId: authority.id, group,
      tab: tab?.startsWith(prefix) ? tab.slice(prefix.length) : tab };
  }));
  const output = await applyTableOfAuthorities(Buffer.from(bytes), draft.units, marks,
    draft.insertIntoDocument ? finalLinks && draft.settings.tableDelivery === "native-append"
      ? "linked-append" : draft.settings.tableDelivery : "native-marks", linked);
  return artifact("annotated-document", filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    output, null);
}

/** The filing PDF with its table of authorities after it, as the engine lays it out (assembly/book.rs), each
 *  authority without a public link appended after the table. */
async function filingPdfArtifact(groups: Group[], filename: string,
  bytes: Uint8Array, sourceSha256: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, allowIncomplete = false) {
  if (!bytes.byteLength || sha256(Buffer.from(bytes)) !== sourceSha256) {
    throw new Error("The imported filing PDF changed before building.");
  }
  const entries = await Promise.all(groups.flatMap(({ entries: items }) => items).map(async (entry) => {
    const source = entry.authority.source;
    const parts = !entry.sourceUrl && source.kind === "attached"
      ? (await loadAuthorityPdf(source.sources, entry, attached, undefined, allowIncomplete)).parts : [];
    return { key: entry.authority.id, name: entry.name, italic: entry.italic, tab: entry.tab, sourceUrl: entry.sourceUrl, parts };
  }));
  const output = await structureNative().renderFilingPdf(bytes, entries);
  return artifact("annotated-document", filename, "application/pdf", output.bytes, output.pageCount);
}

/** `parts` null: an authority without a PDF, whose page the book draws naming it. `read`: what the engine read of its
 *  source; `pageCount`, all its pages. */
type LoadedBookPdf = BookRow & { parts: BookPart[] | null; read?: Awaited<ReturnType<typeof readAuthoritySource>>;
  pageCount: number; authority: AuthorityIdentity | null };
const FEDERAL_BOOK_ROLE_LABELS = {
  applicant: "Applicant", respondent: "Respondent", joint: "Joint",
  appellant: "Appellant", intervener: "Intervener", plaintiff: "Plaintiff",
  defendant: "Defendant", "moving-party": "Moving Party",
  "responding-party": "Responding Party",
} as const;
const FEDERAL_APPEAL_PAPER_COVERS: Record<string, PaperCover> = {
  joint: { rgb: [128 / 255, 0, 32 / 255], dark: true },
  appellant: { rgb: [245 / 255, 245 / 255, 220 / 255], dark: false },
  respondent: { rgb: [169 / 255, 209 / 255, 142 / 255], dark: false },
  intervener: { rgb: [159 / 255, 197 / 255, 220 / 255], dark: false },
};

/** An attached PDF's bytes, as attached; the engine counts its pages where it joins it. */
function boundPdf(part: AuthoritiesBoundPdf, label: string, attached: NonNullable<AuthoritiesBuildInput["sources"]>) {
  const bytes = attached[part.bindingRole]?.bytes;
  if (!bytes?.byteLength || sha256(Buffer.from(bytes)) !== part.sourceSha256) throw new Error(`Attached PDF changed for ${label}.`);
  return bytes;
}

/** What the engine reads an authority's source for (assembly/authority.rs): the passages to place in its PDFs (a
 *  source whose passages are neither marked, linked nor excerpted has its cited pages alone placed), how they are
 *  marked, and how its excerpt is cut (a statute by its length, which the engine counts, where nothing else decides). */
function authoritySourceRequest(draft: AuthoritiesDraft, authority: AuthorityIdentity, sources: AttachedAuthoritySource[],
  extraPages = 0) {
  const copy = draft.settings.legislationCopy ?? "length", statute = authority.excerpt ?? (copy === "length" || copy === "excerpt");
  const targets = authorityPassageTargets(draft, authority.id), { pages, firstPage } = excerptContext(draft.settings);
  const placed = draft.settings.finalPdf && draft.settings.linkPinpoints || draft.settings.passageMarking !== "none" ||
    authority.kind === "legislation" || authorityExcerpt(draft, authority);
  return { targets: [...placed ? targets : targets.filter(({ locatorKind }) => locatorKind === "page"),
    ...excerptContextTargets(draft, authority)], citations: authorityCitationForms(draft, authority.id),
    style: draft.settings.passageMarking, requirePrinted: sources.some(({ origin }) => origin === "manual"),
    exclusions: (authority.highlightExclusions ?? []).map(({ kind, label }) => [kind, label] as [string, string]),
    excerpt: authority.kind === "legislation" ? statute ? { rule: "statute" as const,
      ...authority.excerpt === undefined && copy === "length" && { longerThan: STATUTE_EXCERPT_PAGES } } : null
      : !authorityExcerpt(draft, authority) ? null : courtExtract(draft, authority) ? { rule: "extract" as const }
        : { rule: "source" as const, pages, firstPage },
    ocr: bookScanPolicy(draft) !== "page-margin", extraPages };
}

/** An authority's source as the engine reads it for the book: each PDF by its reading, else by its count of pages
 *  (`pages`, its text unread), with its marks where reviewed (none, `regenerate`); a PDF not there (`placeholders`) is
 *  the page the book holds in its place. */
function readAuthoritySource(draft: AuthoritiesDraft, authority: AuthorityIdentity, sources: AttachedAuthoritySource[],
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, { placeholders = false, regenerate = false, extraPages = 0,
    pages = [] as Array<number | undefined> } = {}) {
  const parts = sources.map((source, index) => {
    const read = attached[source.bindingRole], reading = read?.reading;
    if (placeholders && read?.bytes === undefined) return null;
    const saved = regenerate ? undefined : annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
    return { ...reading ? { document: reading.document, native: reading.native, recognizedPages: reading.recognizedPages,
      pagesOnly: !!reading.plain } : { pages: pages[index] ?? source.pageCount ?? 1 },
      requirePrinted: source.origin === "manual", ...saved && { saved: saved.marks } };
  });
  return structureNative().authorityReading(parts, authoritySourceRequest(draft, authority, sources, extraPages));
}

/** A source's highlights as a build marks it: as reviewed, else (and `regenerate`) as the engine first places them. */
export async function prepareAuthorityAnnotations(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  source: AttachedAuthoritySource, reading?: AuthorityPdfReading, regenerate = false) {
  const saved = regenerate ? undefined : annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
  if (saved) return { annotations: saved, pageMarked: [] };
  const [part] = reading ? (await readAuthoritySource(draft, authority, [source], { [source.bindingRole]: { reading } },
    { regenerate: true })).parts : [];
  return { annotations: decodeAnnotationSet({ schemaVersion: ANNOTATION_SCHEMA, sourceSha256: source.sourceSha256,
    marks: part?.marks ?? [] }), pageMarked: part?.pageMarked ?? [] };
}

/** An authority's PDFs as the book joins them, each with its marks written in (`editing`: what the engine read of the
 *  source); one whose bytes are not there (allowIncomplete) is a page naming it. */
async function loadAuthorityPdf(
  sources: AttachedAuthoritySource[], label: Pick<Entry, "name" | "italic">,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>,
  editing?: { draft: AuthoritiesDraft; authority: AuthorityIdentity; extraPages?: number },
  allowIncomplete = !!editing?.draft.settings.allowIncomplete,
) {
  const loaded = await Promise.all(sources.map(async (source) => {
    const given = attached[source.bindingRole];
    if (allowIncomplete && given?.bytes === undefined) return null;
    // A PDF read is one that opens; one whose text was not read is counted here, where its attaching did not.
    if (given?.reading && given.bytes && sha256(Buffer.from(given.bytes)) === source.sourceSha256) return { bytes: given.bytes, pages: undefined };
    const bytes = boundPdf(source, label.name, attached);
    return { bytes, pages: source.pageCount ?? (await structureNative().pdfPages(bytes)).length };
  }));
  const read = editing && await readAuthoritySource(editing.draft, editing.authority, sources, attached,
    { placeholders: allowIncomplete, extraPages: editing.extraPages, pages: loaded.map((item) => item?.pages) });
  const parts = loaded.map((item, index): BookPart => {
    const source = sources[index];
    if (!item) return { kind: "missing", federal: false, ...(sources.length > 1
      ? { detail: `${source.language === "fr" ? "French" : "English"} version` } : {}) };
    const marks = read?.parts[index]?.marks ?? [];
    // The engine appends the marks to the source's own bytes (as Authorities-lite exports them); the book takes its
    // pages from that copy.
    return { kind: "pdf", headings: (attached[source.bindingRole]?.outline ?? []).map(({ title, level, pageIndex }) =>
      ({ title, level, pageIndex })), bytes: marks.length ? annotatePdf(structureNative(), item.bytes, decodeAnnotationSet({
      schemaVersion: ANNOTATION_SCHEMA, sourceSha256: source.sourceSha256, marks }), source.bindingRole) : item.bytes };
  });
  return { parts, read };
}
/** What the book's front is drawn from: the court, the titles, the cover and how the index is laid out. */
function bookFront(draft: AuthoritiesDraft, subtitle: string) {
  const profile = authoritiesProfile(draft.settings.profileId);
  const federal = !!profile.requirements?.federalFormatting;
  const role = draft.settings.bookRole;
  const bookTitle = profile.bookTitle ??
    (draft.import.kind === "manual" ? subtitle : "Book of Authorities");
  return { subtitle, documentTitle: draft.cover.title || bookTitle, bookTitle, federal,
    alberta: !!profile.requirements?.albertaCover,
    indexShows: draft.settings.indexShows ?? "tabs",
    indexLinks: !!draft.settings.indexLinks,
    tabPages: draft.settings.tabPages ?? true,
    rightHandStarts: draft.settings.rightHandStarts ?? true,
    electronic: draft.settings.filingMedium === "electronic",
    court: profile.courtId === "fca" ? "FEDERAL COURT OF APPEAL" : federal ? "FEDERAL COURT"
      : profile.label.toUpperCase(),
    cover: draft.cover,
    coverLine: federal && role ? role === "joint" ? "Filed jointly" : `Filed by ${FEDERAL_BOOK_ROLE_LABELS[role]}` : null,
    paperCover: profile.requirements?.appealPaperCovers && draft.settings.filingMedium === "paper" &&
      role && role in FEDERAL_APPEAL_PAPER_COVERS
      ? FEDERAL_APPEAL_PAPER_COVERS[role as keyof typeof FEDERAL_APPEAL_PAPER_COVERS] : null,
  };
}

/** A source's text, pages and passages as a build reads them; null where it has not been read. */
export type BuildSourceText = (source: AttachedAuthoritySource) => Promise<NonNullable<AuthoritiesBuildInput["sources"]>[string] | null>;
/** The pages a build keeps of each authority the book excerpts, by authority, as the engine reads its PDFs with the
 *  passages marked in them (`only`: that authority alone). An authority whose PDFs are not all read is left out, as is
 *  one that goes in whole. */
export async function excerptPageCounts(draft: AuthoritiesDraft, readText: BuildSourceText, only?: string) {
  const excerpts: Record<string, number> = {};
  await Promise.all(Object.values(draft.authorities).filter(({ id }) => !only || id === only).map(async (authority) => {
    const sources = attachedAuthoritySources(authority.source);
    if (authority.excluded || !authorityReproducedInBook(draft, authority) || !sources.length ||
      sources.some(({ pageCount }) => !pageCount) || !authorityExcerpt(draft, authority, sources.map(({ pageCount }) => pageCount))) return;
    const read = await Promise.all(sources.map((source) => readText(source).catch(() => null)));
    if (read.some((text) => !text?.reading)) return;
    const { pages } = await readAuthoritySource(draft, authority, sources,
      Object.fromEntries(sources.map(({ bindingRole }, index) => [bindingRole, read[index]!])));
    if (pages) excerpts[authority.id] = pages.length;
  }));
  return excerpts;
}
/** The cover and the index as a build of the draft draws them. `excerptPages`: the pages each authority the book
 *  excerpts keeps (excerptPageCounts), read in the runtime that reads the sources. */
export async function authoritiesBookFront(draft: AuthoritiesDraft, title: string, excerptPages: Record<string, number> = {}) {
  // A build names a manual book's cover after its title, an imported brief's after nothing else.
  const subtitle = draft.import.kind === "document" ? "" : title;
  const listed: AuthoritiesDraft = { ...draft, settings: { ...draft.settings, missingSourcePolicy: "placeholder" } };
  const groups = groupedEntries(listed, "book").map(({ label, entries }) => ({ label,
    entries: entries.filter(({ authority }) => !authority.excluded).map(({ authority, name, italic, tab, sourceUrl }) =>
      ({ key: authority.id, name, italic, tab, sourceUrl })) })).filter(({ entries }) => entries.length);
  const drawn = bookFront(listed, subtitle), profile = authoritiesProfile(draft.settings.profileId);
  // Each authority takes the pages its attached PDFs had when they were attached, and a missing language's
  // page where the book adds one; one without a PDF yet stands in a page, as a build's placeholder does.
  // An authority in the book as an excerpt keeps the pages a build keeps of it.
  const pagesOf = (authority: AuthorityIdentity) => {
    const sources = attachedAuthoritySources(authority.source);
    if (!sources.length) return 1;
    const own = excerptPages[authority.id] ?? sources.reduce((sum, { pageCount }) => sum + (pageCount && pageCount > 0 ? pageCount : 1), 0);
    return own + (draft.settings.allowIncomplete &&
      authoritySourceRequirement(draft, authority, profile.requirements) === "incomplete-enactment" ? 1 : 0);
  };
  const authorities = new Map(groups.flatMap(({ entries }) => entries).map(({ key }) => [key, draft.authorities[key]]));
  // Only the cover and the index are drawn: the authorities' pages are counted, not copied.
  const [book] = await structureNative().renderAuthoritiesBook({ filename: "front.pdf", ...drawn,
    frontOnly: true, groups, sources: groups.flatMap(({ entries }) => entries).map((row) =>
      ({ ...row, parts: [], pageIndices: [...Array(pagesOf(authorities.get(row.key)!)).keys()] })) });
  return book.bytes;
}

/** The book's plan, its sources read by the engine; each source's cited passages placed go to `placed`, by role. */
async function prepareAuthorityBook(
  draft: AuthoritiesDraft, groups: Group[], filename: string, subtitle: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, placed: Map<string, { geometry: PassageGeometry; offset: number }>, signal?: AbortSignal,
  progress?: (message: string) => void, statuteText?: StatuteText,
) {
  signal?.throwIfAborted();
  const profile = authoritiesProfile(draft.settings.profileId);
  const front = bookFront(draft, subtitle), { federal } = front, role = draft.settings.bookRole;
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
    tab: tabLabel(draft.authorityOrder.filter((id) => authorityTabbed(draft, draft.authorities[id])).length + index + 1,
      draft.settings.tabStyle, draft.settings),
  }));
  const rows: BookRow[] = [...authorityRows.map((entry) => ({
    key: `authority:${entry.authority.id}`, name: entry.name, italic: entry.italic, tab: entry.tab,
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
      // An enactment missing one of its languages has a page naming it after its PDFs.
      const missingLanguage = source.kind === "attached" && draft.settings.allowIncomplete &&
        authoritySourceRequirement(draft, entry.authority, profile.requirements) === "incomplete-enactment"
        ? source.sources.some(({ language }) => language === "en") ? "French" : "English" : null;
      const loaded = source.kind === "attached" ? await loadAuthorityPdf(source.sources, entry, attached,
        { draft, authority: entry.authority, extraPages: missingLanguage ? 1 : 0 }) : null;
      // Each PDF's placed passages, and where its pages start among the authority's.
      let start = 0;
      if (source.kind === "attached") loaded?.read?.parts.forEach((part, index) => {
        if (part?.geometry) placed.set(source.sources[index].bindingRole, { geometry: part.geometry, offset: start });
        start += part?.pageCount ?? 1;
      });
      if (loaded && missingLanguage) loaded.parts.push({ kind: "missing", detail: `${missingLanguage} version`, federal });
      marked += 1; marking();
      return { key: `authority:${entry.authority.id}`, name: entry.name, italic: entry.italic, tab: entry.tab,
        sourceUrl: entry.sourceUrl, authority: entry.authority, parts: loaded?.parts ?? null, read: loaded?.read,
        pageCount: (loaded?.read?.parts.reduce((sum, part) => sum + (part?.pageCount ?? 1), 0) ?? 0) + (missingLanguage ? 1 : 0) };
    })),
    Promise.all(draft.bookParts.supplements.map(async (item, index): Promise<LoadedBookPdf> => {
      return { ...supplementRows[index], authority: null, parts: [{ kind: "pdf", bytes: boundPdf(item, item.filename, attached),
        headings: [] }], pageCount: 0 };
    })),
    draft.bookParts.cover && boundPdf(draft.bookParts.cover, "the custom cover", attached),
    draft.bookParts.index && boundPdf(draft.bookParts.index, "the custom index", attached),
  ]);
  const sources = await Promise.all([...authoritySources, ...supplementalSources].map(async (source) => {
    const read = source.read, excerpt = read?.pages ? [...read.pages] : null;
    const missing = (read?.missing ?? []).map(([kind, label]) => ({ kind, label }) as AuthorityPassageRequest["locators"][number]);
    // What the PDF does not place is rebuilt from the statute's text, after the pages it does.
    const rebuilt = missing.length && source.authority
      ? await rebuiltProvisions(source.authority, source.name, missing, statuteText, signal,
        !!profile.requirements?.federalFormatting) : null;
    let rebuiltBookmarks: Array<{ title: string; pageIndex: number }> | undefined;
    if (rebuilt && source.parts) {
      const offset = source.pageCount;
      source.parts.push({ kind: "pdf", bytes: rebuilt.bytes, headings: [] });
      excerpt!.push(...Array.from({ length: rebuilt.pageCount }, (_, index) => offset + index));
      // Each rebuilt provision is bookmarked where it begins in the rebuilt pages.
      rebuiltBookmarks = missing.map(({ kind, label }, index) => ({ title: locatorLabel(kind, label),
        pageIndex: offset + (rebuilt.starts[index] ?? 0) }));
    }
    // With no placed or manually marked passage and no provider reconstruction, retain the whole Act.
    const pages = read?.wholeUnlessRebuilt && !rebuilt ? null : excerpt;
    // The court's extract names the database holding the decision in full on each page.
    // An authority without a PDF has the one page the book draws naming it; a supplement goes in whole (none listed).
    return { ...source, pageIndices: pages ?? (!source.parts ? [0] : source.authority ? [...Array(source.pageCount).keys()] : []),
      databaseReference: pages && courtExtract(draft, source.authority!) ? freePublicDatabaseReference(source.authority!) : null,
      excerpt: !!pages, rebuiltBookmarks };
  }));
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const rowGroups = groups.flatMap(({ label, entries }) => {
    const kept = entries.filter(({ authority }) => authorityReproducedInBook(draft, authority))
      .map(({ authority }) => rowByKey.get(`authority:${authority.id}`)!);
    return kept.length ? [{ label, entries: kept }] : [];
  });
  if (supplementRows.length) rowGroups.push({ label: "Documents", entries: supplementRows });
  progress?.("Preparing the book");
  return {
    filename, ...front,
    customCover: customCover || undefined, customIndex: customIndex || undefined,
    limits: draft.settings.filingMedium !== "paper" ? profile.requirements?.electronicVolumes : undefined,
    groups: rowGroups,
    sources: sources.map((source) => {
      // A case's link, where the book prints it, atop the case's first page.
      const link = draft.settings.caseLinks && source.authority?.kind === "case" ? authoritySourceLink(source.authority) : null;
      return { key: source.key, name: source.name, italic: source.italic, tab: source.tab, sourceUrl: source.sourceUrl,
        // An excerpt that leaves out the page saying how current the statute is says it atop its first page.
        ...(source.excerpt && source.read?.header && { header: source.read.header }), ...(link && { link }),
        parts: source.parts ?? [], pageIndices: source.pageIndices, databaseReference: source.databaseReference,
        // Preparation already selects OCR pages, including a whole-scan fallback for an unlocated pinpoint; that layer
        // is kept even when the pinpoint could not be placed after recognition.
        ocrTextByPage: source.read?.ocrTextByPage ?? undefined,
        // One bookmark per cited passage, where it begins, and each rebuilt provision's, in the order of the pages.
        bookmarks: [...source.read?.bookmarks ?? [], ...source.rebuiltBookmarks ?? []].sort((left, right) => left.pageIndex - right.pageIndex),
        // Under its tab, an authority's marked passages alone, unless its own headings are asked for.
        outline: !source.authority || draft.settings.bookmarks === "headings" };
    }),
  };
}

/** The book's volumes as the engine assembles them from its prepared plan. */
async function bookArtifacts(plan: Awaited<ReturnType<typeof prepareAuthorityBook>>) {
  return (await structureNative().renderAuthoritiesBook(plan)).map((item) => ({ ...artifact(item.role as AuthoritiesOutputRole,
    item.filename, "application/pdf", item.bytes, item.pageCount), bookPlacements: item.placements }));
}

/** The cited provisions a statute's PDF does not place, rebuilt from its provider's text (each with everything under
 *  it) with the page each begins on. Null where the text cannot be had or holds none of them. */
async function rebuiltProvisions(authority: AuthorityIdentity, name: string,
  wanted: AuthorityPassageRequest["locators"], statuteText?: StatuteText, signal?: AbortSignal, federal = false) {
  const found = await statuteText?.(authority, signal);
  if (!found?.text.trim()) return null;
  return structureNative().renderStatuteProvisions({ kind: "legislation", name: authority.name ?? name, citation: authority.citation,
    text: found.text, provider: found.provider, retrieved: new Date().toISOString().slice(0, 10), federal }, wanted.map(({ label }) => label));
}

/** What a statute's excerpt holds of one of its PDFs, as the engine reads it with its reviewed marks: its pages, the
 *  pages kept (none where it goes in whole) and the cited provisions placed. */
export async function statuteExcerptSummary(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  source: AttachedAuthoritySource, read: NonNullable<AuthoritiesBuildInput["sources"]>[string]) {
  const marks = annotationSetForSource(authority.annotations, source.bindingRole, source.sourceSha256);
  const { parts: [part], pages, placed } = await structureNative().authorityReading([read.reading ? {
    document: read.reading.document, native: read.reading.native, recognizedPages: read.reading.recognizedPages,
    ...marks ? { saved: marks.marks } : { saved: [] } } : { pages: source.pageCount ?? 0 }],
    { ...authoritySourceRequest(draft, authority, attachedAuthoritySources(authority.source), []), style: "none", excerpt: { rule: "statute" } });
  return { pageCount: part?.pageCount ?? 0, pages: pages?.length ?? null, placed };
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

export async function buildAuthorities(input: AuthoritiesBuildInput): Promise<AuthoritiesBuildResult> {
  input.signal?.throwIfAborted();
  const errors = validateAuthoritiesDraft(input.draft);
  if (errors.length) throw new Error(errors[0]);
  if (!input.workProduct.id || !Number.isInteger(input.workProduct.revision) ||
      input.workProduct.revision < 1) throw new Error("Valid work-product identity is required.");
  const tableGroups = groupedEntries(input.draft, "table");
  const bookGroups = groupedEntries(input.draft, "book");
  const sources = input.sources ?? {}, placed = new Map<string, { geometry: PassageGeometry; offset: number }>();
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
  const owed = (authority: AuthorityIdentity) => authorityCitation(input.draft, authority).text;
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
  // The brief's name, as a reader knows it: never its file extension.
  // A manual book's title is its subtitle; a brief's file name is printed nowhere.
  const subtitle = input.draft.import.kind === "document" ? "" : input.title;
  const bookName = (profile.bookTitle ?? "Book of Authorities").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  input.progress?.(wanted.includes("book") ? "Preparing the book" : "Building the table");
  const built = (await Promise.all(wanted.map(async (role) => role === "table"
    ? [await tableArtifact(tableGroups, `${base}.table-of-authorities.docx`, subtitle,
      input.draft.settings.tableDelivery === "linked-append", wanted.includes("book"),
      input.draft.settings.tableDelivery === "ruled-append" ? { tabPrefix: input.draft.settings.tabPrefix ?? "Tab ",
        location: input.draft.settings.tableLocation } : undefined)]
    : role === "book"
      ? bookArtifacts(await prepareAuthorityBook(input.draft, bookGroups, `${base}.${bookName}.pdf`, subtitle,
        sources, placed, input.signal, input.progress, input.statuteText).then((plan) => {
          input.progress?.("Assembling the book"); return plan;
        }))
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
    const filename = `${base}.final.pdf`;
    const combined = await assembleFinalAuthoritiesPdf(input, sourcePdf,
      built.filter(({ role }) => role.startsWith("book")), placed);
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
            : input.draft.settings.tableDelivery === "ruled-append"
              ? ["Appended the Table of Authorities to the Word document as a ruled table"]
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
