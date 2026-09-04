import {
  validateAuthoritiesDraft,
  authorityCitationForms,
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
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { applyTableOfAuthorities, type DocxAuthorityMark } from "./docxOperations";
import type { NativePdfPassageGeometry, NativePdfPassageTarget } from "./structureNative";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput } from "./workProduct";

export type AuthoritiesOutputRole = "table" | "book" | "annotated-document";
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
    bookParts: AuthoritiesBookParts;
    insertIntoDocument: boolean;
    document: AuthoritiesDocumentSnapshot | null };
  authorities: Array<{
    id: string; key: string; kind: AuthorityKind; citation: string; name: string;
    tab: string; excluded: boolean; source: AuthoritySourceDecision;
    sourceIdentity: AuthoritySourceIdentity | null;
    evidenceIds: string[]; locators: Array<{ kind: string; label: string }>;
    binding: WorkProductInput | null;
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

function footnoteQuotes(draft: AuthoritiesDraft) {
  const units = draft.units.filter(({ kind }) => kind === "body")
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const anchors: Array<{ footnoteId: number; position: number }> = [];
  let text = "";
  for (const unit of units) {
    unit.footnoteRefs.forEach(([footnoteId, offset]) => {
      if (Number.isSafeInteger(footnoteId) && footnoteId > 0 &&
          Number.isSafeInteger(offset) && offset >= 0 && offset <= unit.text.length) {
        anchors.push({ footnoteId, position: text.length + offset });
      }
    });
    text += `${unit.text}\n`;
  }
  anchors.sort((left, right) => left.position - right.position || left.footnoteId - right.footnoteId);
  const result = new Map<number, string[]>(), seen = new Set<number>();
  let previous = 0;
  for (const { footnoteId, position } of anchors) {
    if (seen.has(footnoteId)) continue;
    seen.add(footnoteId);
    const proposition = text.slice(previous, position).replace(/\s+/gu, " ").trim();
    previous = position;
    const quotes = [...proposition.matchAll(/\u201c([^\u201d\n]+)\u201d|"([^"\n]+)"/gu)]
      .map((match) => (match[1] ?? match[2]).replace(/\s+/gu, " ").trim())
      .filter((quote, index, values) => quote.length >= 8 && values.indexOf(quote) === index);
    result.set(footnoteId, quotes);
  }
  return result;
}

/** Explicit source locators and exact quoted passages tied to each citation context. */
export function authorityPassageRequests(draft: AuthoritiesDraft, authorityId: string) {
  const quoteByFootnote = footnoteQuotes(draft), requests: AuthorityPassageRequest[] = [];
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
    requests.push({ locators, exactQuotes: unit?.footnoteId
      ? quoteByFootnote.get(unit.footnoteId) ?? [] : [] });
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
  return new Set(Object.values(draft.authorities).flatMap((authority) => {
    if (authority.excluded || authority.source.kind !== "attached") return [];
    const paperExtract = ["federal-court", "federal-court-of-appeal"]
      .includes(draft.settings.profileId) && draft.settings.filingMedium === "paper" &&
      freePublicDatabaseReference(authority);
    const requests = authorityPassageRequests(draft, authority.id);
    const locatorKinds = new Set(requests.flatMap(({ locators }) =>
      locators.map(({ kind }) => kind)));
    const needsOcr = draft.settings.scannedPdfPolicy !== "page-margin";
    const needsLocatorText = draft.settings.passageMarking !== "none" &&
      (locatorKinds.has("paragraph") || locatorKinds.has("section"));
    const needsQuoteText = ["margin", "text"].includes(draft.settings.passageMarking) &&
      requests.some(({ exactQuotes }) => exactQuotes.length);
    return paperExtract || needsOcr || needsLocatorText || needsQuoteText
      ? [authority.source.bindingRole] : [];
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
type PdfRef = import("pdf-lib").PDFRef;
type PdfFont = import("pdf-lib").PDFFont;

const GROUPS: ReadonlyArray<readonly [string, AuthorityKind]> = [
  ["Cases", "case"], ["Legislation", "legislation"],
  ["Secondary sources", "commentary"], ["Other sources", "other"],
];
const RENDERERS: Record<AuthoritiesOutputRole, string> = {
  table: "beaver.authorities.table-docx.v1",
  book: "beaver.authorities.book-pdf.v2",
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

const sortName = (draft: AuthoritiesDraft, authority: AuthorityIdentity) =>
  authorityName(draft, authority)
  .normalize("NFKD").toLocaleLowerCase("en-CA");
const alphabetical = (draft: AuthoritiesDraft) =>
  (left: AuthorityIdentity, right: AuthorityIdentity) =>
  sortName(draft, left).localeCompare(sortName(draft, right), "en-CA") ||
  left.citation.localeCompare(right.citation, "en-CA");

function firstReferenceIds(draft: AuthoritiesDraft) {
  const seen = new Set<string>(), ids: string[] = [];
  for (const unit of [...draft.units].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    for (const occurrenceId of unit.occurrenceIds) {
      const id = draft.occurrences[occurrenceId]?.authorityId;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return [...ids, ...draft.authorityOrder.filter((id) => !seen.has(id))];
}

function bookAuthorities(draft: AuthoritiesDraft) {
  const ordered = draft.authorityOrder.map((id) => draft.authorities[id]);
  if (draft.import.kind === "manual") return ordered;
  return GROUPS.flatMap(([, kind]) => ordered.filter((authority) =>
    authority.kind === kind).sort(alphabetical(draft)));
}

function automaticTab(index: number, style: AuthoritiesDraft["settings"]["tabStyle"]) {
  if (style === "numeric") return `Tab ${index}`;
  let value = "", number = index;
  while (number) {
    number -= 1; value = String.fromCharCode(65 + number % 26) + value;
    number = Math.floor(number / 26);
  }
  return `Tab ${value}`;
}

const reproducedInBook = (draft: AuthoritiesDraft, authority: AuthorityIdentity) =>
  !authority.excluded && (authority.source.kind === "attached" ||
    draft.settings.missingSourcePolicy === "placeholder");

function bookTabs(draft: AuthoritiesDraft) {
  const tabs = new Map<string, string>(); let index = 0;
  for (const authority of bookAuthorities(draft)) {
    const reproduced = reproducedInBook(draft, authority);
    if (!authority.excluded) index += 1;
    tabs.set(authority.id, !reproduced ? "Not reproduced"
      : automaticTab(index, draft.settings.tabStyle));
  }
  return tabs;
}

function authoritySourceUrl(authority: AuthorityIdentity) {
  const value = authority.source.kind === "attached" ? authority.source.sourceUrl
    : authority.source.kind === "pending-canlii" ? authority.source.pageUrl
      : authority.sourceIdentity?.externalUrl ?? null;
  try { return value && ["http:", "https:"].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
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
  const tabs = bookTabs(draft);
  const ids = purpose === "book" ? bookAuthorities(draft).map(({ id }) => id)
    : draft.settings.tableOrder === "first-reference"
      ? firstReferenceIds(draft) : draft.authorityOrder;
  const ordered = ids.map((id) => draft.authorities[id]);
  const entry = (authority: AuthorityIdentity): Entry => ({ authority,
    name: authorityName(draft, authority), citedAt: citedAt(draft, authority.id),
    tab: tabs.get(authority.id) ?? "", sourceUrl: authoritySourceUrl(authority) });
  if (purpose === "book" && draft.import.kind === "manual") {
    return ordered.length ? [{ label: "Authorities", entries: ordered.map(entry) }] : [];
  }
  if (purpose === "table" && draft.settings.tableOrder === "first-reference") {
    return ordered.length ? [{ label: "Authorities", entries: ordered.map(entry) }] : [];
  }
  return GROUPS.flatMap(([label, kind]): Group[] => {
    let authorities = ordered.filter((authority) => authority.kind === kind);
    if (purpose === "book" || draft.settings.tableOrder === "alphabetical") {
      authorities = authorities.sort(alphabetical(draft));
    }
    return authorities.length ? [{ label, entries: authorities.map(entry) }] : [];
  });
}

async function tableArtifact(groups: Group[], filename: string, subtitle: string,
  linked = false) {
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
          cell("Tab", 1050, true), cell("Authority", 4800, true),
          cell("Cited at", 1850, true), cell("Source", 1660, true),
        ] }),
        ...group.entries.map((entry) => new TableRow({ cantSplit: true, children: [
          cell(entry.tab, 1050), cell(entry.name, 4800), cell(entry.citedAt, 1850),
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

function fit(font: PdfFont, value: string, size: number, width: number) {
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  let text = value;
  while (text && font.widthOfTextAtSize(`${text}…`, size) > width) text = text.slice(0, -1);
  return `${text}…`;
}

const pdfText = (value: string) => value.normalize("NFKC")
  .replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"')
  .replace(/[\u2013\u2014]/gu, "-").replace(/\u2026/gu, "...")
  .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/gu, "?");

function wrapped(font: PdfFont, value: string, size: number, width: number) {
  const lines: string[] = [];
  for (const raw of pdfText(value).split(/\r?\n/u)) {
    const words = raw.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
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

function addLink(page: PdfPage, rect: number[], target: PdfPage) {
  const annotation = page.doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect,
    Border: [0, 0, 0], Dest: [target.ref, "Fit"] });
  page.node.addAnnot(page.doc.context.register(annotation));
}

function addExternalLink(pdf: PdfModule, page: PdfPage, rect: number[], url: string) {
  const action = page.doc.context.obj({ Type: "Action", S: "URI",
    URI: pdf.PDFHexString.fromText(url) });
  const annotation = page.doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect,
    Border: [0, 0, 0], A: page.doc.context.register(action) });
  page.node.addAnnot(page.doc.context.register(annotation));
}

type Outline = { title: string; pageIndex: number; children?: Outline[] };
function outlineBranch(pdf: PdfModule, document: PdfDocument, items: Outline[], parent: PdfRef) {
  const nodes = items.map((item) => {
    const dict = document.context.obj({ Title: pdf.PDFHexString.fromText(item.title),
      Parent: parent, Dest: [document.getPage(item.pageIndex).ref, "Fit"] });
    return { item, dict, ref: document.context.register(dict), count: 0 };
  });
  nodes.forEach((node, index) => {
    if (index) node.dict.set(pdf.PDFName.of("Prev"), nodes[index - 1].ref);
    if (index + 1 < nodes.length) node.dict.set(pdf.PDFName.of("Next"), nodes[index + 1].ref);
    if (!node.item.children?.length) return;
    const branch = outlineBranch(pdf, document, node.item.children, node.ref);
    node.dict.set(pdf.PDFName.of("First"), branch.first);
    node.dict.set(pdf.PDFName.of("Last"), branch.last);
    node.dict.set(pdf.PDFName.of("Count"), document.context.obj(branch.count));
    node.count = branch.count;
  });
  return { first: nodes[0].ref, last: nodes.at(-1)!.ref,
    count: nodes.reduce((count, node) => count + node.count + 1, 0) };
}

function addOutlines(pdf: PdfModule, document: PdfDocument, items: Outline[]) {
  const root = document.context.obj({ Type: "Outlines" });
  const ref = document.context.register(root);
  const branch = outlineBranch(pdf, document, items, ref);
  root.set(pdf.PDFName.of("First"), branch.first);
  root.set(pdf.PDFName.of("Last"), branch.last);
  root.set(pdf.PDFName.of("Count"), document.context.obj(branch.count));
  document.catalog.set(pdf.PDFName.of("Outlines"), ref);
  document.catalog.set(pdf.PDFName.of("PageMode"), pdf.PDFName.of("UseOutlines"));
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
      ? [loadBookPdf(pdf, source, entry.name, attached).then((document) => ({ entry, document }))]
      : [];
  }));
  const document = await pdf.PDFDocument.create(), regular = await document.embedFont(
    pdf.StandardFonts.TimesRoman), bold = await document.embedFont(pdf.StandardFonts.TimesRomanBold);
  for (const page of await document.copyPages(filing, filing.getPageIndices())) document.addPage(page);
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
    for (const page of await document.copyPages(authority, authority.getPageIndices())) {
      document.addPage(page);
    }
  }
  links.forEach(({ page, entry, rect }) => {
    const start = starts.get(entry.authority.id);
    if (start === undefined) addExternalLink(pdf, page, rect, entry.sourceUrl!);
    else addLink(page, rect, document.getPage(start));
  });
  addOutlines(pdf, document, [
    { title: "Filing document", pageIndex: 0 },
    { title: "Table of Authorities", pageIndex: tableStart },
    ...(appended.length ? [{ title: "Appended authorities", pageIndex: starts.get(
      appended[0].entry.authority.id)!, children: appended.map(({ entry }) => ({
        title: entry.name, pageIndex: starts.get(entry.authority.id)!,
      })) }] : []),
  ]);
  document.setTitle("Filing with Table of Authorities"); document.setCreator("Beaver");
  document.setProducer("Beaver / pdf-lib"); document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const output = Buffer.from(await document.save({ useObjectStreams: false }));
  return artifact("annotated-document", filename, "application/pdf", output,
    document.getPageCount());
}

type BookRow = { key: string; name: string; tab: string; sourceUrl?: string | null };
type LoadedBookPdf = BookRow & { document: PdfDocument; authority: AuthorityIdentity;
  pageTextByPage?: string[]; ocrTextByPage?: string[];
  passageGeometry?: NativePdfPassageGeometry };

const FEDERAL_BOOK_ROLE_LABELS = {
  applicant: "Applicant", respondent: "Respondent", joint: "Joint",
  appellant: "Appellant", intervener: "Intervener",
} as const;
const FCA_PAPER_COVERS = {
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

async function missingSourcePdf(pdf: PdfModule, label: string) {
  const document = await pdf.PDFDocument.create();
  const regular = await document.embedFont(pdf.StandardFonts.Helvetica);
  const bold = await document.embedFont(pdf.StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  page.drawText("Source PDF unavailable", { x: 72, y: 620, size: 24, font: bold });
  let y = 575;
  for (const line of wrapped(regular, label, 12, 468)) {
    page.drawText(line, { x: 72, y, size: 12, font: regular }); y -= 18;
  }
  page.drawText("No source PDF was attached for this authority.",
    { x: 72, y: y - 18, size: 10, font: regular, color: pdf.rgb(.35, .35, .35) });
  return document;
}

async function bookArtifact(
  draft: AuthoritiesDraft, groups: Group[], filename: string, subtitle: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>, signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const pdf = await import("pdf-lib");
  const federal = draft.settings.profileId === "federal-court" ||
    draft.settings.profileId === "federal-court-of-appeal";
  const role = draft.settings.bookRole;
  const coverLine = federal && role
    ? role === "joint" ? "Filed jointly" : `Filed by ${FEDERAL_BOOK_ROLE_LABELS[role]}`
    : null;
  const paperCover = draft.settings.profileId === "federal-court-of-appeal" &&
    draft.settings.filingMedium === "paper" && role && role in FCA_PAPER_COVERS
    ? FCA_PAPER_COVERS[role as keyof typeof FCA_PAPER_COVERS] : null;
  const bookTitle = draft.import.kind === "manual" ? subtitle : "Book of Authorities";
  const authorityRows = groups.flatMap(({ entries }) => entries.filter(({ authority }) =>
    reproducedInBook(draft, authority)));
  const rows: BookRow[] = authorityRows.map((entry) => ({
    key: `authority:${entry.authority.id}`, name: entry.name, tab: entry.tab,
    sourceUrl: entry.sourceUrl,
  }));
  if (!rows.length) throw new Error("Add at least one authority before building the book.");
  const [authoritySources, customCover, customIndex] = await Promise.all([
    Promise.all(authorityRows.map(async (entry): Promise<LoadedBookPdf> => {
      const source = entry.authority.source;
      return { key: `authority:${entry.authority.id}`, name: entry.name, tab: entry.tab,
        sourceUrl: entry.sourceUrl, authority: entry.authority,
        document: source.kind === "attached"
          ? await loadBookPdf(pdf, source, entry.name, attached)
          : await missingSourcePdf(pdf, entry.name),
        pageTextByPage: source.kind === "attached"
          ? attached[source.bindingRole]?.pageTextByPage : undefined,
        ocrTextByPage: source.kind === "attached"
          ? attached[source.bindingRole]?.ocrTextByPage : undefined,
        passageGeometry: source.kind === "attached"
          ? attached[source.bindingRole]?.passageGeometry : undefined };
    })),
    draft.bookParts.cover
      ? loadBookPdf(pdf, draft.bookParts.cover, "the custom cover", attached) : null,
    draft.bookParts.index
      ? loadBookPdf(pdf, draft.bookParts.index, "the custom index", attached) : null,
  ]);
  const sources = authoritySources.map((source) => {
    const extract = federalPaperExtract(draft, source);
    return { ...source, pageIndices: extract?.pageIndices ?? source.document.getPageIndices(),
      databaseReference: extract?.databaseReference ?? null };
  });
  const sourceByKey = new Map(sources.map((source) => [source.key, source]));
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const rowGroups = groups.flatMap(({ label, entries }) => {
    const kept = entries.filter(({ authority }) => reproducedInBook(draft, authority))
      .map(({ authority }) => rowByKey.get(`authority:${authority.id}`)!);
    return kept.length ? [{ label, entries: kept }] : [];
  });
  const tokens = rowGroups.flatMap((group) => [
    { label: group.label, entry: null as BookRow | null },
    ...group.entries.map((entry) => ({ label: "", entry })),
  ]);
  const chunks = Array.from({ length: Math.ceil(tokens.length / 23) }, (_, index) =>
    tokens.slice(index * 23, index * 23 + 23));
  const coverPageCount = customCover?.getPageCount() ?? 1;
  const indexPageCount = customIndex?.getPageCount() ?? chunks.length;
  const starts = new Map<string, number>();
  let next = coverPageCount + indexPageCount;
  for (const source of sources) {
    starts.set(source.key, next);
    next += source.pageIndices.length;
  }
  const document = await pdf.PDFDocument.create();
  const regular = await document.embedFont(pdf.StandardFonts.Helvetica);
  const bold = await document.embedFont(pdf.StandardFonts.HelveticaBold);
  const serif = await document.embedFont(pdf.StandardFonts.TimesRoman);
  if (customCover) {
    for (const page of await document.copyPages(customCover, customCover.getPageIndices())) {
      document.addPage(page);
    }
  } else {
    const cover = document.addPage([612, 792]);
    if (paperCover) cover.drawRectangle({ x: 0, y: 0, width: 612, height: 792,
      color: pdf.rgb(paperCover.rgb[0], paperCover.rgb[1], paperCover.rgb[2]) });
    const ink = paperCover?.dark ? pdf.rgb(1, 1, 1) : pdf.rgb(.18, .18, .18);
    cover.drawRectangle({ x: 0, y: 0, width: 18, height: 792,
      color: ink });
    cover.drawLine({ start: { x: 72, y: 626 }, end: { x: 540, y: 626 },
      thickness: 2, color: ink });
    cover.drawText(fit(bold, bookTitle, 28, 468),
      { x: 72, y: 500, size: 28, font: bold, color: ink });
    if (coverLine) cover.drawText(coverLine,
      { x: 72, y: 462, size: 13, font: serif, color: ink });
    if (bookTitle !== subtitle) cover.drawText(fit(serif, subtitle, 13, 468),
      { x: 72, y: coverLine ? 438 : 462, size: 13, font: serif, color: ink });
  }
  const links: Array<{ page: PdfPage; entry: BookRow;
    internal: number[]; external?: number[] }> = [];
  if (customIndex) {
    for (const page of await document.copyPages(customIndex, customIndex.getPageIndices())) {
      document.addPage(page);
    }
  } else {
    chunks.forEach((chunk, chunkIndex) => {
      const page = document.addPage([612, 792]);
      page.drawText(chunkIndex ? "Table of Contents — continued" : "Table of Contents",
        { x: 48, y: 730, size: 20, font: bold });
      let y = 690;
      for (const token of chunk) {
        if (!token.entry) {
          page.drawRectangle({ x: 48, y: y - 8, width: 516, height: 22,
            color: pdf.rgb(.92, .92, .92) });
          page.drawText(token.label.toUpperCase(), { x: 56, y, size: 8.5, font: bold });
          y -= 27;
          continue;
        }
        const start = starts.get(token.entry.key)!;
        page.drawText(token.entry.tab, { x: 54, y, size: 7.5, font: bold });
        page.drawText(fit(serif, token.entry.name, 8.8, token.entry.sourceUrl ? 350 : 390),
          { x: 102, y, size: 8.8, font: serif });
        if (token.entry.sourceUrl) page.drawText("source", { x: 477, y, size: 7.5,
          font: regular, color: pdf.rgb(.55, .05, .05) });
        page.drawText(String(start + 1), { x: 535, y, size: 8, font: bold });
        page.drawLine({ start: { x: 102, y: y - 7 }, end: { x: 564, y: y - 7 },
          thickness: .45, color: pdf.rgb(.82, .82, .82) });
        links.push({ page, entry: token.entry,
          internal: [48, y - 10, token.entry.sourceUrl ? 470 : 564, y + 10],
          ...(token.entry.sourceUrl ? { external: [472, y - 10, 526, y + 10] } : {}) });
        y -= 25;
      }
      page.drawText(String(coverPageCount + chunkIndex + 1),
        { x: 540, y: 24, size: 8, font: regular });
    });
  }
  for (const source of sources) {
    signal?.throwIfAborted();
    const cited = citedSourcePages(draft, source.authority.id, source.pageTextByPage ?? [],
      source.document.getPageCount());
    const pages = await document.copyPages(source.document, source.pageIndices);
    pages.forEach((page, copiedIndex) => {
      signal?.throwIfAborted();
      const index = source.pageIndices[copiedIndex];
      document.addPage(page);
      if (draft.settings.scannedPdfPolicy === "full" ||
          draft.settings.scannedPdfPolicy === "cited-pages" && cited.has(index)) {
        addOcrText(page, regular, source.ocrTextByPage?.[index]);
      }
      if (draft.settings.passageMarking !== "none") addPassageMarks(pdf, page, index,
        draft.settings.passageMarking, cited.has(index), source.passageGeometry);
      if (source.databaseReference) addDatabaseReference(pdf, page, bold,
        source.databaseReference.url, source.databaseReference.host);
    });
  }
  if (paperCover && !customCover) {
    const back = document.addPage([612, 792]);
    back.drawRectangle({ x: 0, y: 0, width: 612, height: 792,
      color: pdf.rgb(paperCover.rgb[0], paperCover.rgb[1], paperCover.rgb[2]) });
  }
  for (const link of links) {
    addLink(link.page, link.internal, document.getPage(starts.get(link.entry.key)!));
    if (link.external && link.entry.sourceUrl)
      addExternalLink(pdf, link.page, link.external, link.entry.sourceUrl);
  }
  addOutlines(pdf, document, [
    { title: bookTitle, pageIndex: 0 },
    { title: "Table of Contents", pageIndex: coverPageCount },
    ...rowGroups.map(({ label, entries }): Outline => ({ title: label,
      pageIndex: starts.get(entries[0].key)!, children: entries.map((entry) => {
        const source = sourceByKey.get(entry.key), seen = new Set<string>();
        const passages = source?.passageGeometry?.targets.flatMap((target) =>
          target.status === "found" ? target.pages.flatMap(({ pageNumber }) => {
            const key = `${target.locatorKind}\0${target.locator}\0${pageNumber}`;
            if (seen.has(key)) return []; seen.add(key);
            const label = target.locatorKind === "paragraph" ? "para"
              : target.locatorKind === "section" ? "s" : "p";
            const offset = source?.pageIndices.indexOf(pageNumber - 1) ?? -1;
            return offset < 0 ? [] : [{ title: `${label} ${target.locator}`,
              pageIndex: starts.get(entry.key)! + offset }];
          }) : []) ?? [];
        return { title: `${entry.tab} — ${entry.name}`,
          pageIndex: starts.get(entry.key)!, children: passages };
      }) })),
  ]);
  document.setTitle(bookTitle);
  document.setSubject("Navigable book of legal authorities");
  document.setCreator("Beaver");
  document.setProducer("Beaver · pdf-lib");
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  document.catalog.set(pdf.PDFName.of("Lang"), pdf.PDFHexString.fromText("en-CA"));
  document.catalog.set(pdf.PDFName.of("PageLabels"), document.context.register(
    document.context.obj({ Nums: [0, document.context.obj({ S: "D", St: 1 })] }),
  ));
  const electronicFederal = federal && draft.settings.filingMedium === "electronic";
  if (electronicFederal) {
    addVisiblePageNumbers(pdf, document, regular);
    if (draft.settings.profileId === "federal-court" && document.getPageCount() > 500)
      throw new Error("This Federal book exceeds 500 pages. Split it into labelled volumes.");
  }
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  if (electronicFederal && bytes.length > 100 * 1024 * 1024)
    throw new Error("This Federal book exceeds the 100 MB electronic filing limit.");
  return artifact("book", filename, "application/pdf", bytes, document.getPageCount());
}

function addVisiblePageNumbers(pdf: PdfModule, document: PdfDocument, font: PdfFont) {
  document.getPages().forEach((page, index) => {
    const value = String(index + 1), width = font.widthOfTextAtSize(value, 8);
    const crop = page.getCropBox(), angle = ((page.getRotation().angle % 360) + 360) % 360;
    const options = angle === 90
      ? { x: crop.x + crop.width - 10, y: crop.y + (crop.height + width) / 2,
        rotate: pdf.degrees(-90) }
      : angle === 180
        ? { x: crop.x + (crop.width + width) / 2, y: crop.y + crop.height - 10,
          rotate: pdf.degrees(180) }
        : angle === 270
          ? { x: crop.x + 10, y: crop.y + (crop.height - width) / 2,
            rotate: pdf.degrees(90) }
          : { x: crop.x + (crop.width - width) / 2, y: crop.y + 10 };
    page.drawText(value, { ...options, size: 8, font, color: pdf.rgb(.12, .12, .12) });
  });
}

function citedSourcePages(draft: AuthoritiesDraft, authorityId: string, pages: string[],
  pageCount: number) {
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
        if (number > 0 && number <= pageCount) result.add(number - 1);
      }
    }
    if ((kind === "paragraph" || kind === "section") && label.trim()) {
      const values = label.trim().split(/\s+(?:to|[-\u2013\u2014])\s+|\s*[-\u2013\u2014]\s*/u)
        .filter(Boolean).slice(0, 2);
      const matched: number[] = [];
      for (const value of values) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const marker = kind === "paragraph"
          ? new RegExp(`(?:^|\\n)\\s*\\[?${escaped}\\]?(?:\\s|[.)])`, "iu")
          : new RegExp(`(?:^|\\n|\\s)(?:s(?:ec(?:tion)?)?\\.?\\s*)?${escaped}(?:\\s|[.)])`, "iu");
        pages.forEach((text, index) => { if (marker.test(text)) matched.push(index); });
      }
      if (matched.length) for (let index = Math.min(...matched); index <= Math.max(...matched);
        index += 1) result.add(index);
    }
  }
  return result;
}

function federalPaperExtract(draft: AuthoritiesDraft, source: LoadedBookPdf) {
  if (!["federal-court", "federal-court-of-appeal"].includes(draft.settings.profileId) ||
      draft.settings.filingMedium !== "paper") return null;
  const databaseReference = freePublicDatabaseReference(source.authority);
  if (!databaseReference) return null;
  const pageCount = source.document.getPageCount();
  const text = Array.from({ length: pageCount }, (_, index) =>
    source.pageTextByPage?.[index]?.trim() || source.ocrTextByPage?.[index] || "");
  const reasonsStart = text.findIndex((page) =>
    /(?:^|\n)\s*(?:\[\s*1\s*\]|1[.)])(?:\s|$)/u.test(page));
  const cited = citedSourcePages(draft, source.authority.id, text, pageCount);
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

function addDatabaseReference(pdf: PdfModule, page: PdfPage, font: PdfFont,
  url: string, host: string) {
  const crop = page.getCropBox(), label = `FREE PUBLIC DATABASE: ${host}`;
  const size = 7.5, textWidth = font.widthOfTextAtSize(label, size);
  const x = crop.x + 18, y = crop.y + crop.height - 17, width = textWidth + 10;
  page.drawRectangle({ x: x - 5, y: y - 3, width, height: 13,
    color: pdf.rgb(1, 1, 1), borderColor: pdf.rgb(.15, .15, .15), borderWidth: .6,
    opacity: .94, borderOpacity: 1 });
  page.drawText(label, { x, y, size, font, color: pdf.rgb(.08, .08, .08) });
  addExternalLink(pdf, page, [x - 5, y - 3, x - 5 + width, y + 10], url);
}

function addPageMargin(pdf: PdfModule, page: PdfPage, black = false) {
  const { x, y, width, height } = page.getCropBox();
  const inset = 8, end = 18, angle = ((page.getRotation().angle % 360) + 360) % 360;
  const [start, finish] = angle === 90
    ? [{ x: x + end, y: y + height - inset }, { x: x + width - end, y: y + height - inset }]
    : angle === 180
      ? [{ x: x + inset, y: y + end }, { x: x + inset, y: y + height - end }]
      : angle === 270
        ? [{ x: x + end, y: y + inset }, { x: x + width - end, y: y + inset }]
        : [{ x: x + width - inset, y: y + end },
          { x: x + width - inset, y: y + height - end }];
  page.drawLine({ start, end: finish, thickness: 2.5,
    color: black ? pdf.rgb(.08, .08, .08) : pdf.rgb(.75, .08, .08), opacity: .9 });
}

type MarkRect = [number, number, number, number];

function pageRect(page: PdfPage, rect: MarkRect, sourceWidth: number, sourceHeight: number) {
  const crop = page.getCropBox(), angle = ((page.getRotation().angle % 360) + 360) % 360;
  const visibleWidth = angle === 90 || angle === 270 ? crop.height : crop.width;
  const visibleHeight = angle === 90 || angle === 270 ? crop.width : crop.height;
  const x0 = rect[0] * visibleWidth / sourceWidth, x1 = rect[2] * visibleWidth / sourceWidth;
  const y0 = rect[1] * visibleHeight / sourceHeight, y1 = rect[3] * visibleHeight / sourceHeight;
  const values = angle === 90 ? [y0, x0, y1, x1]
    : angle === 180 ? [crop.width - x1, y0, crop.width - x0, y1]
      : angle === 270 ? [crop.width - y1, crop.height - x1,
        crop.width - y0, crop.height - x0]
        : [x0, crop.height - y1, x1, crop.height - y0];
  return { x: crop.x + values[0], y: crop.y + values[1],
    width: values[2] - values[0], height: values[3] - values[1] };
}

function uniqueRects(rects: MarkRect[]) {
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = rect.map((value) => value.toFixed(2)).join(":");
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

function addPassageMarks(pdf: PdfModule, page: PdfPage, pageIndex: number,
  style: AuthoritiesSettings["passageMarking"], cited: boolean,
  geometry?: NativePdfPassageGeometry) {
  const number = pageIndex + 1, targets = geometry?.targets ?? [];
  const pages = targets.flatMap((target) => target.pages.filter((item) =>
    item.pageNumber === number && item.source === "native"));
  const dimensions = pages[0];
  const passages = uniqueRects(pages.flatMap(({ passageRects }) => passageRects));
  const quotes = uniqueRects(targets.flatMap(({ quotes: items }) => items.flatMap((quote) =>
    quote.status === "found" && quote.pageNumber === number ? quote.rects : [])));
  if ((style === "margin" || style === "sidelined") && !passages.length &&
      (cited || targets.some((target) => target.pages.some((item) => item.pageNumber === number)))) {
    addPageMargin(pdf, page, style === "sidelined");
  }
  if (!dimensions) return;
  const paint = (rect: MarkRect, color: ReturnType<PdfModule["rgb"]>, opacity: number) => {
    const box = pageRect(page, rect, dimensions.width, dimensions.height);
    if (box.width > 0 && box.height > 0) page.drawRectangle({ ...box, color, opacity });
  };
  if (style === "margin" || style === "sidelined") for (const rect of passages) {
    const x = Math.min(dimensions.width - 4, rect[2] + 5);
    paint([x, rect[1], x + 2, rect[3]], style === "sidelined"
      ? pdf.rgb(.08, .08, .08) : pdf.rgb(.75, .08, .08), .9);
  }
  if (style === "paragraph") passages.forEach((rect) => paint(rect, pdf.rgb(.85, .08, .08), .16));
  if (style === "text" || style === "margin") {
    quotes.forEach((rect) => paint(rect, pdf.rgb(.85, .08, .08), .18));
  }
}

function addOcrText(page: PdfPage, font: PdfFont, value?: string) {
  if (!value?.trim()) return;
  const text = value.normalize("NFKC")
    .replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u2013\u2014]/gu, "-").replace(/\u2026/gu, "...")
    .replace(/[^\x20-\x7e\u00a0-\u00ff\r\n]/gu, "?").slice(0, 60_000);
  for (const [index, chunk] of (text.match(/[\s\S]{1,1800}/gu) ?? []).entries()) {
    page.drawText(chunk, { x: 1, y: 1 + index % 4, size: 1, lineHeight: 1,
      maxWidth: Math.max(1, page.getWidth() - 2), font, opacity: 0 });
  }
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
  const sources = input.sources ?? {};
  const wanted: AuthoritiesOutputRole[] = input.draft.outputMode === "both"
    ? ["table", "book"] : [input.draft.outputMode];
  const completeBook = input.draft.settings.profileId === "ab-court-of-kings-bench"
    ? "Alberta King's Bench" : ["federal-court", "federal-court-of-appeal"]
      .includes(input.draft.settings.profileId) ? "Federal" : null;
  if (wanted.includes("book") && completeBook) {
    const missing = input.draft.authorityOrder.map((id) => input.draft.authorities[id])
      .filter((authority) => !authority.excluded && authority.source.kind !== "attached");
    if (missing.length) throw new Error(
      `Attach a complete PDF or exclude ${authorityName(input.draft, missing[0])} before building this ${completeBook} book.`,
    );
  }
  if (input.draft.settings.profileId === "ab-court-of-appeal") {
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
    const role = authority.source.bindingRole;
    return [{ role, resolved: resolvedInput(role, input.draft.bindings[role],
      authority.source.filename, authority.source.sourceSha256, sources[role]?.resolved) }];
  }), ...(wanted.includes("book") ? [input.draft.bookParts.cover,
    input.draft.bookParts.index].flatMap((part) => {
      if (!part) return [];
      const role = part.bindingRole;
      return [{ role, resolved: resolvedInput(role, input.draft.bindings[role],
        part.filename, part.sourceSha256, sources[role]?.resolved) }];
    }) : [])];
  const cleaned = input.title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/u, "").slice(0, 120) || "Authorities";
  const base = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu
    .test(cleaned) ? `_${cleaned}` : cleaned;
  const subtitle = input.draft.import.kind === "document"
    ? input.draft.import.filename : input.title;
  const built = await Promise.all(wanted.map((role) => role === "table"
    ? tableArtifact(tableGroups, `${base}.table-of-authorities.docx`, subtitle,
      input.draft.settings.tableDelivery === "linked-append")
    : role === "book"
      ? bookArtifact(input.draft, bookGroups, `${base}.book-of-authorities.pdf`, subtitle,
        sources, input.signal)
      : input.draft.import.kind === "document" && input.draft.import.fileType === "pdf"
        ? filingPdfArtifact(tableGroups,
          `${base}.with-table-of-authorities.pdf`,
          sources[input.draft.import.bindingRole]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "", sources)
        : documentArtifact(input.draft, tableGroups,
          `${base}.with-table-of-authorities.docx`,
          sources[input.draft.import.kind === "document"
            ? input.draft.import.bindingRole : "source"]?.bytes ?? new Uint8Array(),
          imported[0]?.resolved.sha256 ?? "")));
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
      bookParts: input.draft.bookParts,
      renderers: wanted.map((role) => [role, RENDERERS[role]]),
    }),
    sourceReceiptIds: [...new Set([
      ...Object.values(input.draft.authorities).flatMap(({ evidenceIds }) => evidenceIds),
      ...Object.values(input.draft.occurrences).flatMap(({ evidenceIds }) => evidenceIds),
    ])].sort(),
    audit: { effective: null, valuesJson: canonicalJson({ title: input.title,
      outputMode: input.draft.outputMode, insertIntoDocument: input.draft.insertIntoDocument,
      settings: input.draft.settings, bookParts: input.draft.bookParts,
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
        : item.role === "book"
          ? ["Combined attached authority PDFs", "Added index links and PDF bookmarks"]
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
      bookParts: structuredClone(input.draft.bookParts),
      insertIntoDocument: input.draft.insertIntoDocument,
      document: input.draft.import.kind === "document" ? input.draft.import.snapshot : null },
    authorities: entries.map(({ authority, name, tab }) => ({
      id: authority.id, key: authority.key, kind: authority.kind, citation: authority.citation,
      name, tab, excluded: authority.excluded, source: structuredClone(authority.source),
      sourceIdentity: structuredClone(authority.sourceIdentity),
      evidenceIds: [...authority.evidenceIds], locators: structuredClone(authority.locators),
      binding: authority.source.kind === "attached"
        ? structuredClone(input.draft.bindings[authority.source.bindingRole]) : null,
    })),
    outputs,
  } };
}
