import { attachedAuthoritySources, authoritiesBriefPdf } from "mike/shared/authorities-sources.mjs";
import type { AuthoritiesBuildReceipt, AuthoritiesDraft, AuthorityOccurrence } from "mike/shared/authorities-contract.d.ts";
import type { AuthoritiesBuildArtifact, AuthoritiesBuildInput } from "./authoritiesBuild";
import { authorityProcedure, tabReference } from "mike/shared/authorities-order.mjs";
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

/** The brief and the book as one PDF, as the engine joins them (assembly/book.rs): the brief's links to the book's tabs
 *  and pinpoints go there, links are added over citations the brief's text places, and what cannot be linked is
 *  reported. `read`: each source PDF's cited passages, and where its pages start among its authority's. */
export async function assembleFinalAuthoritiesPdf(input: AuthoritiesBuildInput, sourceBytes: Uint8Array, books: Book[],
  read: ReadonlyMap<string, { geometry: PassageGeometry; offset: number }>) {
  const draft = input.draft, sources = input.sources ?? {};
  const filingRole = draft.import.kind !== "document" ? undefined : draft.import.fileType === "pdf"
    ? draft.import.bindingRole : authoritiesBriefPdf(draft)?.bindingRole;
  // Where each authority is in the book: its tab's volume and page, and its source's pages'.
  const destinations = new Map<string, { tab: [number, number]; pages: Map<number, [number, number]> }>();
  books.forEach((output, book) => {
    for (const placement of output.bookPlacements ?? []) {
      if (!placement.key.startsWith("authority:")) continue;
      const id = placement.key.slice("authority:".length);
      const placed = destinations.get(id) ?? { tab: [book, placement.tabPageIndex], pages: new Map() };
      placement.sourcePageIndices.forEach((pageIndex, index) => placed.pages.set(pageIndex, [book, placement.pageIndex + index]));
      destinations.set(id, placed);
    }
  });
  const warnings: Warnings = [], warned = new Set<string>();
  const tabs = new Map(authorityProcedure(draft).map(({ id, tab }) => [id, tab]));
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
  type Reason = Warnings[number]["reason"];
  /** Where a citation's pinpoint is in the book, at the top of the passage's first line (or of its page), and the
   *  page of its source it is on; else why it cannot be linked. */
  const pinpointDestination = (occurrence: AuthorityOccurrence): { to: FinalLink["to"]; missing?: Reason; sourcePageNumber?: number } => {
    const authority = draft.authorities[occurrence.authorityId ?? ""];
    const placement = destinations.get(authority?.id ?? "");
    if (!authority || !placement || authority.source.kind !== "attached") return { to: null, missing: "source-missing" };
    // Any PDF the authority has (attached by hand, its publisher's, or rendered from its text): a paragraph is found by
    // the number the page prints for it, which the engine witnessed (hasPrintedParagraphLocator).
    const attached = authority.source.sources;
    if (attached.every(({ bindingRole }) => !sources[bindingRole]?.bytes)) return { to: null, missing: "source-missing" };
    let ambiguous = false;
    for (const source of attached) {
      const { geometry, offset: start = 0 } = read.get(source.bindingRole) ?? {};
      if (!sources[source.bindingRole]?.bytes || !geometry) continue;
      const matching = geometry.targets.filter((target) => occurrence.pinpoints.some(({ kind, text }) =>
        target.locatorKind === kind && target.locator.trim() === text.trim()));
      ambiguous ||= matching.some(({ status }) => status === "ambiguous");
      if (!matching.length || occurrence.pinpoints.some(({ kind, text }) => !matching.some((target) =>
        target.locatorKind === kind && target.locator.trim() === text.trim())) ||
        matching.some(target => target.status !== "found" || !target.pages.length || !hasPrintedParagraphLocator(target))) continue;
      const page = matching.flatMap(({ pages }) => pages).sort((left, right) => left.pageNumber - right.pageNumber)[0];
      const at = placement.pages.get(start + page.pageNumber - 1);
      if (at) return { to: [...at, (page.passageRects[0] ?? [0, 0, 1, 1]) as [number, number, number, number]], sourcePageNumber: page.pageNumber };
    }
    return { to: null, missing: ambiguous ? "pinpoint-ambiguous" : "pinpoint-unlocated" };
  };
  const geometry = filingRole ? sources[filingRole]?.passageGeometry : undefined;
  const links: FinalLink[] = [], linkOf: Array<{ id: string; pinpoint: boolean; sourcePageNumber?: number }> = [];
  for (const occurrence of Object.values(draft.occurrences)) {
    const authority = draft.authorities[occurrence.authorityId ?? ""];
    for (const kind of ["tab", "pinpoint"] as const) {
      if (!(kind === "tab" ? draft.settings.linkTabs : draft.settings.linkPinpoints)) continue;
      const placed = destinations.get(occurrence.authorityId ?? "");
      const { to, missing, sourcePageNumber } = kind === "pinpoint" ? pinpointDestination(occurrence)
        : placed ? { to: [...placed.tab, null] as FinalLink["to"] } : { to: null, missing: "source-missing" as Reason };
      // The citation is linked too, where the brief's text places it.
      const cite = !!authority && !authority.excluded && (kind === "tab" || !!occurrence.pinpointSpan &&
        attachedAuthoritySources(authority.source).length > 0);
      const tab = tabs.get(authority?.id ?? "");
      // A brief saved from the Word output carries its tab reference; link that when present.
      const quoteTexts = kind === "tab" ? [`[${tab}]`, tab && tabReference(draft.settings, tab),
        filingTabText(unitTexts.get(occurrence.unitId) ?? "", occurrence, tab)] : [occurrence.pinpointSpan?.text];
      const target = cite ? geometry?.targets.find(({ id }) => id === `filing:${occurrence.id}`) : undefined;
      const quotes = target?.quotes.filter(({ text }) => quoteTexts.includes(text)) ?? [];
      const quote = quoteTexts.map((text) => quotes.find((item) => item.text === text && item.status === "found"))
        .find(Boolean) ?? quotes[0];
      const fragments = quote?.fragments?.length ? quote.fragments : quote?.pageNumber
        ? [{ pageNumber: quote.pageNumber, rects: quote.rects }] : [];
      const over = quote?.status === "found" && fragments.every(({ pageNumber, rects }) => rects.length &&
        target!.pages.find((page) => page.pageNumber === pageNumber)?.source === "native")
        ? fragments.flatMap(({ pageNumber, rects }) => rects.map((rect) => [pageNumber - 1, rect] as [number, typeof rect])) : null;
      links.push({ uri: filingLinkUrl(kind, occurrence.id), to, missing, cite, over });
      linkOf.push({ id: occurrence.id, pinpoint: kind === "pinpoint", sourcePageNumber });
    }
  }
  input.signal?.throwIfAborted();
  const headings = (filingRole ? sources[filingRole]?.outline ?? [] : []).map(({ title, level, pageIndex }) => ({ title, level, pageIndex }));
  const output = await structureNative().renderFinalPdf(Buffer.concat([sourceBytes, ...books.map(({ bytes }) => bytes)]), {
    brief: sourceBytes.byteLength, headings, rightHandStarts: draft.settings.rightHandStarts ?? true, prefix: LINK_PREFIX, links,
    books: books.map((book) => ({ bytes: book.bytes.byteLength, title: books.length > 1
      ? `Book of authorities — Volume ${book.role === "book" ? "1" : book.role.slice(5)}` : "Book of authorities" })) });
  for (const [index, reason] of output.warnings) {
    const { id, pinpoint, sourcePageNumber } = linkOf[index];
    warn(id, reason as Reason, pinpoint);
    // A pinpoint whose citation could not be placed says which page of its source to link by hand.
    const row = reason === "citation-location" && sourcePageNumber
      ? warnings.find((row) => row.occurrenceId === id && row.pinpoint !== null) : undefined;
    if (row) row.sourcePageNumber = sourcePageNumber;
  }
  return { bytes: output.bytes, pageCount: output.pageCount, warnings };
}
