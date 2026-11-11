import { quadBounds, rectToPdfQuad, validRect } from "mike/shared/pdf-annotations.mjs";
import { attachedAuthoritySources, authoritiesBriefPdf } from "mike/shared/authorities-sources.mjs";
import type { AuthoritiesBuildReceipt, AuthoritiesDraft, AuthorityOccurrence } from "mike/shared/authorities-contract.d.ts";
import type { AuthoritiesBuildArtifact, AuthoritiesBuildInput } from "./authoritiesBuild";
import { authorityProcedureInput, deriveAuthorityProcedure, tabReference } from "mike/shared/authorities-order.mjs";
import { sha256 } from "./hash";
import { hasPrintedParagraphLocator } from "./authoritiesAnnotations";
import { structureNative } from "./structureNative";
import type { FinalLink } from "mike/shared/engine-types/FinalLink";
import type { PassageGeometry } from "mike/shared/engine-types/PassageGeometry";

const LINK_PREFIX = "https://beaver-authorities.invalid/";
export const filingLinkUrl = (kind: "tab" | "pinpoint", id: string) =>
  `${LINK_PREFIX}${kind}/${encodeURIComponent(id)}`;
type Book = Pick<AuthoritiesBuildArtifact, "role" | "bytes" | "bookPlacements" | "pageCount">;
type Warnings = NonNullable<AuthoritiesBuildReceipt["linkWarnings"]>;

export function filingTabText(unitText: string, occurrence: AuthorityOccurrence, tab?: string) {
  const following = unitText.slice(occurrence.end).trimStart();
  return tab && [`[${tab}]`, `[Book of authorities ${tab}]`].find((text) => following.startsWith(text)) ||
    occurrence.authoritySpan.text;
}

/** The page of each citation in a PDF saved from the Word brief, by its id, as the engine places it on the pages' words
 *  (`briefOccurrencePages`); a citation that cannot be placed gets no page. */
export const briefOccurrencePages = (draft: AuthoritiesDraft, pageTextByPage: string[]) =>
  new Map(Object.entries(structureNative().briefOccurrencePages(pageTextByPage, draft.units, draft.occurrences)));

/** Fails, saying how, when a supplied brief PDF is not a PDF of this brief. */
export function assertBriefPdfMatches(draft: AuthoritiesDraft, pageTextByPage: string[], filename: string) {
  const cited = Object.values(draft.occurrences).filter(({ authorityId }) =>
    authorityId && !draft.authorities[authorityId]?.excluded);
  const pages = briefOccurrencePages(draft, pageTextByPage), found = cited.filter(({ id }) => pages.has(id)).length;
  if (found * 2 < cited.length) throw new Error(`${filename} doesn't match this brief: ${found} of ${cited.length} ` +
    `citations are in it. In Word, save ${draft.import.kind === "document" ? draft.import.filename : "the brief"} ` +
    "as PDF and upload that file.");
}

type PdfPage = Awaited<ReturnType<ReturnType<typeof structureNative>["pdfPages"]>>[number];
const overlaps = (left: number[], right: number[]) =>
  left[0] < right[2] && right[0] < left[2] && left[1] < right[3] && right[1] < left[3];
const cropBox = ({ crop: [x, y, width, height] }: PdfPage) => ({ x, y, width, height });

/** The brief and the book as one PDF, as the engine joins them (assembly/book.rs): the brief's links to the book's tabs
 *  and pinpoints go there, links are added over citations the brief's text places, and what cannot be linked is
 *  reported. */
/** `read`: each source PDF's cited passages, and where its pages start among its authority's. */
export async function assembleFinalAuthoritiesPdf(input: AuthoritiesBuildInput, sourceBytes: Uint8Array, books: Book[],
  read: ReadonlyMap<string, { geometry: PassageGeometry; offset: number }>) {
  const draft = input.draft, sources = input.sources ?? {}, native = structureNative();
  let pages: PdfPage[];
  try { pages = await native.pdfPages(sourceBytes); } catch { throw new Error("The brief PDF could not be opened for final export."); }
  const sourcePages = pages.length;
  if (!sourcePages) throw new Error("The brief PDF is empty.");
  const filingRole = draft.import.kind !== "document" ? undefined : draft.import.fileType === "pdf"
    ? draft.import.bindingRole : authoritiesBriefPdf(draft)?.bindingRole;
  const destinations = new Map<string, { tab: number; pages: Map<number, number> }>();
  // A book that starts its authorities on right-hand pages starts on one itself: after a brief of an odd
  // number of pages, a blank page, so the book's right-hand pages stay right-hand when the whole is printed.
  const blankPage = (draft.settings.rightHandStarts ?? true) && sourcePages % 2 === 1;
  let offset = sourcePages + (blankPage ? 1 : 0);
  for (const output of books) {
    input.signal?.throwIfAborted();
    for (const placement of output.bookPlacements ?? []) {
      if (!placement.key.startsWith("authority:")) continue;
      const id = placement.key.slice("authority:".length);
      const placed = destinations.get(id) ?? { tab: offset + placement.tabPageIndex, pages: new Map<number, number>() };
      placement.sourcePageIndices.forEach((pageIndex, index) =>
        placed.pages.set(pageIndex, offset + placement.pageIndex + index));
      destinations.set(id, placed);
    }
    offset += output.pageCount ?? 0;
  }
  const warnings: Warnings = [], warned = new Set<string>();
  const tabs = new Map(deriveAuthorityProcedure(authorityProcedureInput(draft, { purpose: "book" }))
    .map(({ id, tab }) => [id, tab]));
  const unitTexts = new Map(draft.units.map(({ id, text }) => [id, text]));
  const warn = (id: string, reason: Warnings[number]["reason"], pinpoint = false) => {
    const occurrence = draft.occurrences[id], key = `${id}\0${pinpoint}`;
    if (!occurrence || warned.has(key)) return;
    // The pinpoint with its locator as the brief prints it ("para 22", not "22"), to link it by hand.
    const printed = pinpoint ? (occurrence.pinpointPhrase ?? occurrence.pinpointSpan)?.text
      .replace(/^[\s,]*(?:at\s+)?/u, "") : null;
    warned.add(key); warnings.push({ occurrenceId: id, citation: occurrence.authoritySpan.text,
      pinpoint: printed || (pinpoint ? occurrence.pinpointSpan?.text ?? null : null),
      tab: tabs.get(occurrence.authorityId ?? ""), reason });
  };
  const pinpointDestination = (id: string) => {
    const occurrence = draft.occurrences[id], authority = draft.authorities[occurrence?.authorityId ?? ""];
    const placement = destinations.get(authority?.id ?? "");
    if (!authority || !placement || authority.source.kind !== "attached") {
      warn(id, "source-missing", true); return null;
    }
    const manual = authority.source.sources.filter(({ origin }) => origin === "manual");
    if (manual.length && manual.every(({ bindingRole }) => !sources[bindingRole]?.bytes)) {
      warn(id, "source-missing", true); return null;
    }
    let ambiguous = false;
    for (const source of manual) {
      const { geometry, offset: start = 0 } = read.get(source.bindingRole) ?? {};
      if (!sources[source.bindingRole]?.bytes || geometry?.sourceSha256 !== source.sourceSha256) continue;
      const matching = geometry.targets.filter((target) => occurrence.pinpoints.some(({ kind, text }) =>
        target.locatorKind === kind && target.locator.trim() === text.trim()));
      ambiguous ||= matching.some(({ status }) => status === "ambiguous");
      if (!matching.length || occurrence.pinpoints.some(({ kind, text }) => !matching.some((target) =>
        target.locatorKind === kind && target.locator.trim() === text.trim())) ||
        matching.some(target => target.status !== "found" || !target.pages.length ||
          !hasPrintedParagraphLocator(target))) continue;
      const found = matching.flatMap(({ pages }) => pages).sort((left, right) => left.pageNumber - right.pageNumber);
      const page = found[0], sourceIndex = start + page.pageNumber - 1;
      const pageIndex = placement.pages.get(sourceIndex);
      if (pageIndex === undefined) continue;
      // The link lands at the top of the passage's first line, or of its page.
      const rect = page.passageRects[0];
      if (rect && !validRect(rect)) continue;
      return { pageIndex, rect: rect ?? [0, 0, 1, 1] as [number, number, number, number], sourcePageNumber: page.pageNumber };
    }
    warn(id, ambiguous ? "pinpoint-ambiguous" : "pinpoint-unlocated", true); return null;
  };
  const pinpointCache = new Map<string, ReturnType<typeof pinpointDestination>>();
  const destination = (kind: string, id: string) => {
    if (kind === "tab") {
      const value = destinations.get(draft.occurrences[id]?.authorityId ?? "");
      if (!value) { warn(id, "source-missing"); return null; }
      return { pageIndex: value.tab, rect: null };
    }
    if (!pinpointCache.has(id)) pinpointCache.set(id, pinpointDestination(id));
    return pinpointCache.get(id) ?? null;
  };
  type Link = FinalLink;
  const relinks: Link[] = [], links: Link[] = [], linked = new Set<string>();
  // The brief's own links to the book, written as placeholders, go where they name, or go.
  pages.forEach(({ links: own }, page) => own.forEach(([, uri]) => {
    if (!uri.startsWith(LINK_PREFIX)) return;
    const [kind, encodedId] = uri.slice(LINK_PREFIX.length).split("/");
    let id: string;
    try { id = decodeURIComponent(encodedId); } catch { relinks.push({ page, uri, to: null }); return; }
    const target = draft.occurrences[id] && (kind === "tab" ? draft.settings.linkTabs :
      kind === "pinpoint" && draft.settings.linkPinpoints) ? destination(kind, id) : null;
    relinks.push({ page, uri, to: target && [target.pageIndex, target.rect] });
    if (target) linked.add(`${kind}:${id}`);
  }));
  const importedGeometry = filingRole ? sources[filingRole]?.passageGeometry : undefined;
  const verifiedImportedGeometry = importedGeometry?.sourceSha256 === sha256(Buffer.from(sourceBytes))
    ? importedGeometry : undefined;
  for (const occurrence of Object.values(draft.occurrences)) {
    const authority = draft.authorities[occurrence.authorityId ?? ""];
    if (!authority || authority.excluded) continue;
    for (const kind of ["tab", "pinpoint"] as const) {
      if (!(kind === "tab" ? draft.settings.linkTabs : draft.settings.linkPinpoints && occurrence.pinpointSpan &&
        attachedAuthoritySources(authority.source).some(({ origin }) => origin === "manual"))) continue;
      if (linked.has(`${kind}:${occurrence.id}`)) continue;
      const tab = tabs.get(authority.id);
      // A brief saved from the Word output carries its tab reference; link that when present.
      const quoteTexts = kind === "tab" ? [`[${tab}]`, tab && tabReference(draft.settings, tab),
        filingTabText(unitTexts.get(occurrence.unitId) ?? "", occurrence, tab)] : [occurrence.pinpointSpan!.text];
      const geometryTarget = verifiedImportedGeometry?.targets.find(({ id }) => id === `filing:${occurrence.id}`);
      const quotes = geometryTarget?.quotes.filter(({ text }) => quoteTexts.includes(text)) ?? [];
      const quote = quoteTexts.map((text) => quotes.find((item) => item.text === text && item.status === "found"))
        .find(Boolean) ?? quotes[0];
      const fragments = quote?.fragments?.length ? quote.fragments : quote?.pageNumber
        ? [{ pageNumber: quote.pageNumber, rects: quote.rects }] : [];
      if (quote?.status !== "found" || !fragments.length || fragments.some(({ pageNumber, rects }) => {
        if (pageNumber < 1 || pageNumber > sourcePages || !rects.length) return true;
        const geometryPage = geometryTarget?.pages.find((page) => page.pageNumber === pageNumber);
        const rotation = ((pages[pageNumber - 1].rotation % 360) + 360) % 360;
        return !geometryPage || geometryPage.source !== "native" || geometryPage.width <= 0 || geometryPage.height <= 0 ||
          ![0, 90, 180, 270].includes(rotation) || rects.some((rect) => !validRect(rect));
      })) {
        warn(occurrence.id, "citation-location", kind === "pinpoint");
        if (kind === "pinpoint") {
          const target = destination(kind, occurrence.id);
          const warning = warnings.find((row) => row.occurrenceId === occurrence.id && row.pinpoint !== null);
          if (target && warning && "sourcePageNumber" in target)
            warning.sourcePageNumber = target.sourcePageNumber;
        }
        continue;
      }
      const placed = fragments.flatMap(({ pageNumber, rects }) => rects.map((rect) => ({ page: pageNumber - 1,
        bounds: quadBounds([rectToPdfQuad(rect, cropBox(pages[pageNumber - 1]), pages[pageNumber - 1].rotation)]) })));
      // The brief's own web link over the citation stays the one a click follows.
      if (placed.some(({ page, bounds }) => pages[page].links.some(([, uri, rect]) =>
        !uri.startsWith(LINK_PREFIX) && overlaps(rect, bounds)))) {
        warn(occurrence.id, "web-link", kind === "pinpoint"); continue;
      }
      const target = destination(kind, occurrence.id);
      if (!target) continue;
      links.push(...placed.map(({ page, bounds }) => ({ page, rect: bounds, to: [target.pageIndex, target.rect] as FinalLink["to"] })));
    }
  }
  input.signal?.throwIfAborted();
  const headings = (filingRole ? sources[filingRole]?.outline ?? [] : []).map(({ title, level, pageIndex }) => ({ title, level, pageIndex }));
  const output = await native.renderFinalPdf(Buffer.concat([sourceBytes, ...books.map(({ bytes }) => bytes)]), {
    brief: sourceBytes.byteLength, headings, blankPage, relinks, links,
    books: books.map((book) => ({ bytes: book.bytes.byteLength, title: books.length > 1
      ? `Book of authorities — Volume ${book.role === "book" ? "1" : book.role.slice(5)}` : "Book of authorities" })) });
  return { bytes: output.bytes, pageCount: output.pageCount, warnings };
}
