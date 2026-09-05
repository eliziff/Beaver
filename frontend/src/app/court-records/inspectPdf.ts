import { getPdfJs } from "@/app/lib/pdfJs";
import type { SourceBookmark } from "./types";

export interface PdfInspection {
  pageCount: number;
  searchable: boolean;
  encrypted: boolean;
  textlessPageCount: number;
  textlessPages: number[];
  sourceBookmarks: SourceBookmark[];
  pageLabels: string[] | null;
  pageTexts: string[];
}

interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}

export async function inspectPdf(
  file: File,
  onProgress?: (completedPages: number, totalPages: number) => void,
): Promise<PdfInspection> {
  const pdfjs = await getPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loading = pdfjs.getDocument({ data: bytes });
  try {
    const document = await loading.promise;
    let textlessPageCount = 0;
    const textlessPages: number[] = [];
    const pageTexts: string[] = [];
    let textCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      pageTexts.push(text.items.map((item) => "str" in item
        ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim());
      const characters = text.items.reduce((sum, item) =>
        sum + ("str" in item ? item.str.trim().length : 0), 0);
      if (!characters) {
        textlessPageCount += 1;
        textlessPages.push(pageNumber);
      }
      textCharacters += characters;
      page.cleanup();
      onProgress?.(pageNumber, document.numPages);
    }
    const [permissions, rawOutline, pageLabels] = await Promise.all([
      document.getPermissions(), document.getOutline(), document.getPageLabels().catch(() => null),
    ]);
    const outline = (rawOutline ?? []) as PdfOutlineItem[];
    const sourceBookmarks = await resolveOutline(document, outline);
    const result = {
      pageCount: document.numPages,
      searchable: textCharacters > 0,
      encrypted: permissions !== null,
      textlessPageCount,
      textlessPages,
      sourceBookmarks,
      pageLabels,
      pageTexts,
    };
    await document.destroy();
    return result;
  } catch (cause) {
    await loading.destroy().catch(() => undefined);
    if (isPasswordError(cause)) {
      return {
        pageCount: 0,
        searchable: false,
        encrypted: true,
        textlessPageCount: 0,
        textlessPages: [],
        sourceBookmarks: [],
        pageLabels: null,
        pageTexts: [],
      };
    }
    throw cause;
  }
}

async function resolveOutline(
  document: import("pdfjs-dist").PDFDocumentProxy,
  items: PdfOutlineItem[],
): Promise<SourceBookmark[]> {
  const resolved: SourceBookmark[] = [];
  for (const item of items.slice(0, 500)) {
    try {
      const destination = typeof item.dest === "string"
        ? await document.getDestination(item.dest)
        : item.dest;
      if (!destination?.length) continue;
      const pageIndex = typeof destination[0] === "object"
        ? await document.getPageIndex(destination[0] as { num: number; gen: number })
        : Number(destination[0]);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) continue;
      resolved.push({
        title: item.title.trim() || `Page ${pageIndex + 1}`,
        pageIndex,
        children: await resolveOutline(document, item.items ?? []),
      });
    } catch {
      // A malformed source bookmark must not prevent inspection of an otherwise usable PDF.
    }
  }
  return resolved;
}

function isPasswordError(cause: unknown) {
  return !!cause && typeof cause === "object" &&
    (cause as { name?: string }).name === "PasswordException";
}
