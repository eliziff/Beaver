import { sha256 } from "./hash";
import type { SourceDocBlock } from "./sourceDoc";
import type { SourceStructureInput } from "./sourceStructureAdapter";
import type { StructureKind } from "./structureWire";
import { jsonRecord as row, positiveInteger as integer } from "./value";

export type JournalPageRow = { page_label: unknown; pdf_page: unknown };
export type JournalStructureInput = {
  articleId: number;
  url: string;
  text: string;
  pageRows: JournalPageRow[];
  nativeBlocks?: SourceDocBlock[];
};
type Row = Record<string, unknown>;
type PlacedRegion = { start: number; end: number; pdfPage: number | null };
const FINAL_CONTRACT_KINDS = new Set<StructureKind>([
  "paragraph", "prose", "page", "section", "heading", "footnote", "endnote",
]);

function titleAliases(text: string) {
  const compact = text.replace(/\s+/gu, " ").trim();
  const numbered = compact.match(/^([IVXLCDM]+|[A-Z])\.[ \t]+(.+)$/u);
  const title = (numbered?.[2] ?? compact).toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return { label: numbered?.[1] ?? null,
    aliases: [...(numbered ? [numbered[1]] : []), ...(title ? [`sectitle:${title}`] : [])] };
}

/** Project an authoritative journal export without loading a provider or recovery host. */
export function journalFinalContractSource(
  articleId: number, source: Buffer | string, pageRows: JournalPageRow[],
) {
  try {
    const bytes = Buffer.isBuffer(source) ? source : null;
    const sourceText = typeof source === "string" ? source : null;
    const sourceLength = source.length;
    const parts: string[] = [];
    const blocks: SourceDocBlock[] = [];
    const titles: Array<ReturnType<typeof titleAliases> & { start: number }> = [];
    const pairedRefs = new Set<string>();
    const notes: Array<{ pairId: string; note: string; region?: PlacedRegion }> = [];
    let offset = 0, paragraph = 0, pages = 0, cursor = 0;
    while (cursor <= sourceLength) {
      const newline = bytes ? bytes.indexOf(0x0a, cursor) : sourceText!.indexOf("\n", cursor);
      const end = newline < 0 ? sourceLength : newline;
      let line = bytes ? bytes.toString("utf8", cursor, end) : sourceText!.slice(cursor, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      cursor = newline < 0 ? sourceLength + 1 : newline + 1;
      if (!line.trim()) continue;
      const page = row(JSON.parse(line));
      if (!page) return null;
      const registeredArticle = integer(page.article_id);
      if (registeredArticle && registeredArticle !== articleId) return null;
      const pageText = typeof page.text === "string" ? page.text : null;
      if (pageText === null) return null;
      if (pages++) { parts.push("\n"); offset += 1; }
      const pageStart = offset;
      parts.push(pageText);
      offset += pageText.length;
      const pdfPage = integer(page.pdf_page);
      if (pdfPage) {
        const publicPage = pageRows.find((candidate) => integer(candidate.pdf_page) === pdfPage);
        const publicLabel = String(publicPage?.page_label ?? "").trim();
        const label = publicLabel || String(pdfPage);
        blocks.push({ kind: "page", label: /^\d+$/u.test(label) ? `page${Number(label)}` : `page${label}`,
          start: pageStart, end: offset, anchor: `page=${pdfPage}`, aliases: [label], origin: "native" });
      }

      const footnotesByLine = new Map<number, PlacedRegion>();
      let regionCursor = 0;
      const orderedRegions = (Array.isArray(page.regions) ? page.regions : [])
        .map((value, index) => ({ value: row(value), index }))
        .filter((entry): entry is { value: Row; index: number } => !!entry.value)
        .sort((left, right) => Number(left.value.order ?? left.index) -
          Number(right.value.order ?? right.index));
      for (const { value: region } of orderedRegions) {
        const regionText = typeof region.text === "string" ? region.text : "";
        if (!regionText) continue;
        const at = pageText.indexOf(regionText, regionCursor);
        if (at < 0) continue;
        regionCursor = at + regionText.length;
        const lines = Array.isArray(region.lines) ? region.lines : [];
        const placed: PlacedRegion = {
          start: pageStart + at, end: pageStart + at + regionText.length, pdfPage,
        };
        blocks.push({ kind: "paragraph", label: `par${++paragraph}`, start: placed.start,
          end: placed.end, origin: "native" });
        if (region.type === "paragraph_title") {
          titles.push({ start: placed.start, ...titleAliases(regionText) });
        }
        if (region.type === "footnote") for (const line of lines) {
          const order = integer(row(line)?.codex_text_order);
          if (order !== null && !footnotesByLine.has(order)) footnotesByLine.set(order, placed);
        }
      }
      for (const value of Array.isArray(page.annotations) ? page.annotations : []) {
        const annotation = row(value);
        const pairId = typeof annotation?.pair_id === "string" ? annotation.pair_id : "";
        if (!pairId || annotation?.pair_status !== "paired") continue;
        if (annotation.taxonomy_name === "fn_ref") { pairedRefs.add(pairId); continue; }
        if (annotation.taxonomy_name !== "fn_label") continue;
        const note = String(annotation.note_id ?? annotation.selected_text ?? "").trim();
        const lineOrder = integer(annotation.start_line_order);
        if (note && lineOrder !== null) notes.push({ pairId, note,
          region: footnotesByLine.get(lineOrder) });
      }
    }
    if (!pages) return null;
    const text = parts.join("");
    if (!text.trim()) return null;

    titles.forEach((title, index) => {
      blocks.push({ kind: "section",
        label: title.label ? `sec${title.label}` : `secTitle${index + 1}`,
        start: title.start, end: titles[index + 1]?.start ?? text.length,
        aliases: title.aliases, origin: "native" });
    });

    const usedPairs = new Set<string>();
    for (const { pairId, note, region } of notes) {
      if (!pairedRefs.has(pairId) || usedPairs.has(pairId)) continue;
      if (!region) continue;
      usedPairs.add(pairId);
      blocks.push({ kind: "footnote", label: /^\d+$/u.test(note) ? `fn${Number(note)}` : `fn${note}`,
        start: region.start, end: region.end, aliases: [note],
        anchor: region.pdfPage ? `page=${region.pdfPage}` : undefined, origin: "native" });
    }
    return { text, blocks: blocks.sort((left, right) =>
      left.start - right.start || left.end - right.end), pages };
  } catch {
    return null;
  }
}

/** Locate only provider-declared page marker rows, including repeated and non-numeric labels. */
function pageBlocks(text: string, pageRows: JournalPageRow[]) {
  const found: Array<Omit<SourceDocBlock, "end">> = [];
  let cursor = 0;
  for (const row of pageRows) {
    const label = String(row.page_label ?? "").trim();
    if (!label) continue;
    const marker = `[page ${label}]`;
    let at = text.indexOf(marker, cursor);
    while (at >= 0) {
      const lineStart = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
      const lineEnd = at + marker.length;
      const nextBreak = text.indexOf("\n", lineEnd);
      const tail = text.slice(lineEnd, nextBreak < 0 ? text.length : nextBreak);
      if (!/[^ \t]/u.test(text.slice(lineStart, at)) && !/[^ \t\r]/u.test(tail)) {
        const pdfPage = integer(row.pdf_page);
        found.push({
          kind: "page",
          label: /^\d+$/u.test(label) ? `page${Number(label)}` : `page${label}`,
          start: lineStart,
          anchor: pdfPage ? `page=${pdfPage}` : undefined,
          aliases: [label],
          origin: "native",
        });
        cursor = lineEnd;
        break;
      }
      at = text.indexOf(marker, lineEnd);
    }
  }
  return found;
}

export function prepareJournalSourceStructure(args: JournalStructureInput): SourceStructureInput {
  const { articleId, url, text, pageRows, nativeBlocks } = args;
  const pages = pageBlocks(text, pageRows);
  const native = nativeBlocks ?? pages.map((block, index): SourceDocBlock => ({
        ...block, end: pages[index + 1]?.start ?? text.length,
      }));
  const complete = nativeBlocks === undefined
    ? new Set<StructureKind>(pages.length ? ["page"] : []) : FINAL_CONTRACT_KINDS;
  const source = sha256(JSON.stringify([text, pageRows, nativeBlocks]));
  return {
    provider: "journal", id: String(articleId), url, docType: null, text,
    providerRevision: source, sourceSha256: source,
    scope: { kind: "complete" }, profile: "journal",
    nativeBlocks: native, completeKinds: complete, order: "stable-position",
  };
}
