import * as pdf from "pdf-lib";
import { quadBounds, rectToPdfQuad, validRect } from "mike/shared/pdf-annotations.mjs";
import { attachedAuthoritySources, authoritiesBriefPdf } from "mike/shared/authorities-sources.mjs";
import type { AuthoritiesBuildReceipt, AuthoritiesDraft, AuthorityOccurrence } from "mike/shared/authorities-contract.d.ts";
import type { AuthoritiesBuildArtifact, AuthoritiesBuildInput } from "./authoritiesBuild";
import { pdfAssembly, type PdfOutline } from "./pdfAssembly";
import { authorityProcedureInput, deriveAuthorityProcedure } from "mike/shared/authorities-order.mjs";
import { sha256 } from "./hash";
import { hasPrintedParagraphLocator, normalizePassageRect } from "./authoritiesAnnotations";
import { normalizedWords } from "./structureNative";

const { appendPages, applyOutlines, readOutlines } = pdfAssembly(pdf);
const LINK_PREFIX = "https://beaver-authorities.invalid/";
export const filingLinkUrl = (kind: "tab" | "pinpoint", id: string) =>
  `${LINK_PREFIX}${kind}/${encodeURIComponent(id)}`;
type Book = Pick<AuthoritiesBuildArtifact, "role" | "bytes" | "bookPlacements">;
type Warnings = NonNullable<AuthoritiesBuildReceipt["linkWarnings"]>;

export function filingTabText(unitText: string, occurrence: AuthorityOccurrence, tab?: string) {
  const following = unitText.slice(occurrence.end).trimStart();
  return tab && [`[${tab}]`, `[Book of authorities ${tab}]`].find((text) => following.startsWith(text)) ||
    occurrence.authoritySpan.text;
}

/** The page of each citation in a PDF saved from the Word brief. The brief's words are read
 *  in order, body and notes each onward from their last match, so a repeated citation keeps
 *  its place; a citation that cannot be placed gets no page. */
export function briefOccurrencePages(draft: AuthoritiesDraft, pageTextByPage: string[]) {
  const words = pageTextByPage.flatMap((text, index) => normalizedWords(text).map((word) => ({ word, page: index + 1 })));
  const positions = new Map<string, number[]>();
  words.forEach(({ word }, at) => positions.get(word)?.push(at) ?? positions.set(word, [at]));
  const find = (needle: string[], from: number) => positions.get(needle[0] ?? "")?.find((at) => at >= from &&
    needle.every((word, offset) => words[at + offset]?.word === word)) ?? -1;
  const cursors = { body: 0, note: 0 }, pages = new Map<string, number>();
  for (const unit of draft.units) for (const id of unit.occurrenceIds) {
    const occurrence = draft.occurrences[id], stream = unit.footnoteId === null ? "body" : "note";
    if (!occurrence) continue;
    const before = normalizedWords(unit.text.slice(0, occurrence.start)).slice(-4);
    const core = normalizedWords(occurrence.text), after = normalizedWords(unit.text.slice(occurrence.end)).slice(0, 4);
    // Surrounding words make a repeated citation unique; a tab reference or note mark can break either side.
    const cursor = cursors[stream], attempts: Array<[string[], number, number]> = [
      [[...before, ...core, ...after], before.length, cursor], [[...before, ...core], before.length, cursor],
      [[...core, ...after], 0, cursor], [core, 0, cursor], [[...before, ...core, ...after], before.length, 0]];
    for (const [needle, skip, from] of attempts) {
      const at = needle.length > 1 ? find(needle, from) : -1;
      if (at < 0) continue;
      pages.set(id, words[at + skip].page); cursors[stream] = at + needle.length; break;
    }
  }
  return pages;
}

/** Fails, saying how, when a supplied brief PDF is not a PDF of this brief. */
export function assertBriefPdfMatches(draft: AuthoritiesDraft, pageTextByPage: string[], filename: string) {
  const cited = Object.values(draft.occurrences).filter(({ authorityId }) =>
    authorityId && !draft.authorities[authorityId]?.excluded);
  const pages = briefOccurrencePages(draft, pageTextByPage), found = cited.filter(({ id }) => pages.has(id)).length;
  if (found * 2 < cited.length) throw new Error(`${filename} doesn't match this brief: ${found} of ${cited.length} ` +
    `citations are in it. In Word, save ${draft.import.kind === "document" ? draft.import.filename : "the brief"} ` +
    "as PDF and upload that file.");
}

export async function assembleFinalAuthoritiesPdf(input: AuthoritiesBuildInput,
  sourceBytes: Uint8Array, books: Book[]) {
  const draft = input.draft, sources = input.sources ?? {};
  let document: pdf.PDFDocument;
  try { document = await pdf.PDFDocument.load(sourceBytes, { updateMetadata: false }); }
  catch { throw new Error("The brief PDF could not be opened for final export."); }
  const sourcePages = document.getPageCount();
  if (!sourcePages) throw new Error("The brief PDF is empty.");
  const originalOutlines = readOutlines(document);
  const outlines: PdfOutline[] = [{ title: "Brief", pageIndex: 0,
    ...(originalOutlines.length ? { children: originalOutlines } : {}) }];
  const destinations = new Map<string, { tab: number; pages: Map<number, number> }>();
  for (const output of books) {
    input.signal?.throwIfAborted();
    const offset = document.getPageCount(), book = await pdf.PDFDocument.load(output.bytes, { updateMetadata: false });
    const children = readOutlines(book, offset);
    const volume = output.role === "book" ? "1" : output.role.slice(5);
    outlines.push({ title: books.length > 1 ? `Book of authorities — Volume ${volume}` : "Book of authorities",
      pageIndex: offset, children });
    for (const placement of output.bookPlacements ?? []) {
      if (!placement.key.startsWith("authority:")) continue;
      const id = placement.key.slice("authority:".length);
      const placed = destinations.get(id) ?? { tab: offset + placement.pageIndex, pages: new Map<number, number>() };
      placement.sourcePageIndices.forEach((pageIndex, index) =>
        placed.pages.set(pageIndex, offset + placement.pageIndex + index));
      destinations.set(id, placed);
    }
    await appendPages(document, book);
  }
  const warnings: Warnings = [], warned = new Set<string>();
  const tabs = new Map(deriveAuthorityProcedure(authorityProcedureInput(draft, { purpose: "book" }))
    .map(({ id, tab }) => [id, tab]));
  const unitTexts = new Map(draft.units.map(({ id, text }) => [id, text]));
  const warn = (id: string, reason: Warnings[number]["reason"], pinpoint = false) => {
    const occurrence = draft.occurrences[id], key = `${id}\0${pinpoint}`;
    if (!occurrence || warned.has(key)) return;
    // The pinpoint with its locator as the brief prints it ("para 22", not "22"), to link it by hand.
    const printed = pinpoint && occurrence.pinpointSpan ? unitTexts.get(occurrence.unitId)
      ?.slice(occurrence.authoritySpan.end, occurrence.pinpointSpan.end).replace(/^[\s,]*(?:at\s+)?/u, "") : null;
    warned.add(key); warnings.push({ occurrenceId: id, citation: occurrence.authoritySpan.text,
      pinpoint: printed || (pinpoint ? occurrence.pinpointSpan?.text ?? null : null),
      tab: tabs.get(occurrence.authorityId ?? ""), reason });
  };
  const sourceOffsets = new Map<string, number>();
  if (draft.settings.linkPinpoints) for (const authority of Object.values(draft.authorities)) {
    if (authority.excluded) continue;
    let offset = 0;
    for (const source of attachedAuthoritySources(authority.source)) {
      sourceOffsets.set(source.bindingRole, offset);
      offset += sources[source.bindingRole]?.bytes === undefined ? 1
        : (await pdf.PDFDocument.load(sources[source.bindingRole].bytes!, { updateMetadata: false })).getPageCount();
    }
  }
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
      const geometry = sources[source.bindingRole]?.passageGeometry;
      if (!sources[source.bindingRole]?.bytes || geometry?.sourceSha256 !== source.sourceSha256) continue;
      const matching = geometry.targets.filter((target) => occurrence.pinpoints.some(({ kind, text }) =>
        target.locatorKind === kind && target.locator.trim() === text.trim()));
      ambiguous ||= matching.some(({ status }) => status === "ambiguous");
      if (!matching.length || occurrence.pinpoints.some(({ kind, text }) => !matching.some((target) =>
        target.locatorKind === kind && target.locator.trim() === text.trim())) ||
        matching.some(target => target.status !== "found" || !target.pages.length ||
          !hasPrintedParagraphLocator(target))) continue;
      const pages = matching.flatMap(({ pages }) => pages).sort((left, right) => left.pageNumber - right.pageNumber);
      const page = pages[0], sourceIndex = (sourceOffsets.get(source.bindingRole) ?? 0) + page.pageNumber - 1;
      const pageIndex = placement.pages.get(sourceIndex);
      if (pageIndex === undefined) continue;
      const target = document.getPage(pageIndex), rawRect = page.passageRects[0];
      const rect = rawRect && normalizePassageRect(rawRect, page.width, page.height);
      const rotation = ((target.getRotation().angle % 360) + 360) % 360;
      if (rect && (!validRect(rect) || ![0, 90, 180, 270].includes(rotation))) continue;
      const top = rect ? Math.max(...rectToPdfQuad(rect, target.getCropBox(), target.getRotation().angle)
        .filter((_value, index) => index % 2 === 1)) : target.getCropBox().y + target.getCropBox().height;
      return { pageIndex, top, sourcePageNumber: page.pageNumber };
    }
    warn(id, ambiguous ? "pinpoint-ambiguous" : "pinpoint-unlocated", true); return null;
  };
  const pinpointCache = new Map<string, ReturnType<typeof pinpointDestination>>();
  const destination = (kind: string, id: string) => {
    if (kind === "tab") {
      const value = destinations.get(draft.occurrences[id]?.authorityId ?? "");
      if (!value) { warn(id, "source-missing"); return null; }
      return { pageIndex: value.tab, top: null };
    }
    if (!pinpointCache.has(id)) pinpointCache.set(id, pinpointDestination(id));
    return pinpointCache.get(id) ?? null;
  };
  const linked = new Set<string>();
  for (let pageIndex = 0; pageIndex < sourcePages; pageIndex++) {
    const page = document.getPage(pageIndex), annots = page.node.lookupMaybe(pdf.PDFName.of("Annots"), pdf.PDFArray);
    for (let index = (annots?.size() ?? 0) - 1; index >= 0; index--) {
      const annotation = annots!.lookup(index, pdf.PDFDict), action = annotation.lookupMaybe(pdf.PDFName.of("A"), pdf.PDFDict);
      const uri = action?.lookupMaybe(pdf.PDFName.of("URI"), pdf.PDFString, pdf.PDFHexString)?.decodeText();
      if (!uri?.startsWith(LINK_PREFIX)) continue;
      const [kind, encodedId] = uri.slice(LINK_PREFIX.length).split("/");
      let id: string;
      try { id = decodeURIComponent(encodedId); } catch { annots!.remove(index); continue; }
      if (!draft.occurrences[id] || !(kind === "tab" ? draft.settings.linkTabs :
        kind === "pinpoint" && draft.settings.linkPinpoints)) {
        annots!.remove(index); continue;
      }
      const target = destination(kind, id);
      if (!target) { annots!.remove(index); continue; }
      annotation.delete(pdf.PDFName.of("A"));
      annotation.set(pdf.PDFName.of("Dest"), document.context.obj(target.top === null
        ? [document.getPage(target.pageIndex).ref, "Fit"]
        : [document.getPage(target.pageIndex).ref, "XYZ", null, target.top, null]));
      linked.add(`${kind}:${id}`);
    }
  }
  const filingRole = draft.import.kind !== "document" ? undefined : draft.import.fileType === "pdf"
    ? draft.import.bindingRole : authoritiesBriefPdf(draft)?.bindingRole;
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
      const quoteTexts = kind === "tab" ? [`[${tab}]`, `[Book of authorities ${tab}]`,
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
        const rotation = ((document.getPage(pageNumber - 1).getRotation().angle % 360) + 360) % 360;
        return !geometryPage || geometryPage.source !== "native" || geometryPage.width <= 0 || geometryPage.height <= 0 ||
          ![0, 90, 180, 270].includes(rotation) || rects.some((rect) =>
            !validRect(normalizePassageRect(rect, geometryPage.width, geometryPage.height)));
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
      const target = destination(kind, occurrence.id);
      if (!target) continue;
      for (const fragment of fragments) {
        const page = document.getPage(fragment.pageNumber - 1);
        const geometryPage = geometryTarget!.pages.find(({ pageNumber }) => pageNumber === fragment.pageNumber)!;
        for (const rect of fragment.rects) {
          const normalized = normalizePassageRect(rect, geometryPage.width, geometryPage.height);
          const bounds = quadBounds([rectToPdfQuad(normalized, page.getCropBox(), page.getRotation().angle)]);
          page.node.addAnnot(document.context.register(document.context.obj({
            Type: "Annot", Subtype: "Link", Rect: bounds, Border: [0, 0, 0],
            Dest: target.top === null ? [document.getPage(target.pageIndex).ref, "Fit"]
              : [document.getPage(target.pageIndex).ref, "XYZ", null, target.top, null],
          })));
        }
      }
    }
  }
  applyOutlines(document, outlines, true);
  document.setTitle(`${draft.settings.allowIncomplete ? "DRAFT — incomplete sources · " : ""}Brief and Book of Authorities`);
  document.setCreator("Beaver"); document.setProducer("Beaver / pdf-lib");
  input.signal?.throwIfAborted();
  return { bytes: Buffer.from(await document.save({ useObjectStreams: false })),
    pageCount: document.getPageCount(), warnings };
}
