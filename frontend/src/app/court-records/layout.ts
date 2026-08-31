export const INDEX_ROWS_PER_PAGE = 25;

export function indexChunks<T extends { group?: string }>(
  items: T[],
  rowsPerPage = INDEX_ROWS_PER_PAGE,
): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let rows = 0;
  let lastGroup: string | undefined;
  for (const item of items) {
    const groupRow = item.group && item.group !== lastGroup ? 1 : 0;
    if (chunk.length && rows + groupRow + 1 > rowsPerPage) {
      chunks.push(chunk);
      chunk = [];
      rows = 0;
      lastGroup = undefined;
    }
    const nextGroupRow = item.group && item.group !== lastGroup ? 1 : 0;
    chunk.push(item);
    rows += nextGroupRow + 1;
    lastGroup = item.group;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.length ? chunks : [[]];
}

export function indexPageCount(items: Array<{ group?: string }>, rowsPerPage?: number) {
  return indexChunks(items, rowsPerPage).length;
}
