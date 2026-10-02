type Download = { name: string; lastModified: number; webkitRelativePath?: string };
type Pages = ReadonlyArray<{ lines: ReadonlyArray<{ text: string }> }>;
type CitationCall = (method: string, request: unknown) => any;
type FolderRecord = { citation: string; aliases: readonly string[]; referenceText?: string };
export const CANLII_PDF_NAME: RegExp;
export function canliiFiles<F extends Download>(files: Iterable<F>): Array<{ citation: string; file: F }>;
export function headerText(pages: Pages): string;
export function headerIdentities(pages: Pages, call: CitationCall): Array<{ start: number; end: number; text: string; key: string; family: string }>;
export function verifyIdentity(pages: Pages, record: FolderRecord, call: CitationCall): void;
export function referenceText(text: string | null | undefined): string;
export function matchFolderPdf<R extends FolderRecord>(filename: string, pages: Pages, records: readonly R[],
  call: CitationCall, reference?: (record: R) => string | Promise<string>): Promise<{ record: R; method: "filename" | "citation" | "text" } | null>;
