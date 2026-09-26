type Download = { name: string; lastModified: number; webkitRelativePath?: string };
export const CANLII_PDF_NAME: RegExp;
export function canliiDownloadKey(citation: string): string;
export function canliiDownloads<F extends Download>(files: readonly F[]): Array<{ citation: string; file: F }>;
export function matchCanliiDownloads<R, F extends Download>(files: readonly F[],
  candidates: ReadonlyArray<{ record: R; citations: readonly string[] }>): Array<{ record: R; file: F }>;
