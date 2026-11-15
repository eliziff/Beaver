import type { EngineOperations } from "./engine-types/operations";
type Pages = ReadonlyArray<{ lines: ReadonlyArray<{ text: string }>; marginText?: string }>;
type CitationEngine = Pick<EngineOperations, "citationExtract" | "citationKeyForText" | "matchesReporterHeader">;
type FolderRecord = { citation: string; aliases: readonly string[]; referenceText?: string };
export const CANLII_PDF_NAME: RegExp;
export function canliiFileCitation(name: string): string | null;
export function headerText(pages: Pages): string;
export function headerIdentities(pages: Pages, engine: CitationEngine): Array<{ start: number; end: number; text: string; key: string | null; family: string }>;
export function verifyIdentity(pages: Pages, record: FolderRecord, engine: CitationEngine): void;
export function referenceText(text: string | null | undefined): string;
export function matchFolderPdf<R extends FolderRecord>(filename: string, pages: Pages, records: readonly R[],
  engine: CitationEngine, reference?: (record: R) => string | Promise<string>): Promise<{ record: R; method: "filename" | "citation" | "text" } | null>;
