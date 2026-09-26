type Draft = {
  authorities: Record<string, { locators: Array<{ kind: string; label: string }> }>;
  occurrences: Record<string, { authorityId: string | null; pinpoints: Array<{ kind: string; text: string }> }>;
};
type Geometry = { targets: Array<{ status: string; locatorKind: string; locator: string;
  pages: Array<{ pageNumber: number }> }> };
export function citedSourcePages(draft: Draft, authorityId: string, pages: string[],
  pageLabels?: Map<string, number[]>, pageCount?: number, geometry?: Geometry): Set<number>;
