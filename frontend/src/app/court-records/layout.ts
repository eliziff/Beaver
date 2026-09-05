export const INDEX_ROWS_PER_PAGE = 25;

export function indexChunks<T extends { group?: string }>(
  items: T[],
  rowsPerPage = INDEX_ROWS_PER_PAGE,
  itemRows: (item: T) => number = () => 1,
  groupRows = 1,
): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let rows = 0;
  let lastGroup: string | undefined;
  for (const item of items) {
    const groupRow = item.group && item.group !== lastGroup ? groupRows : 0;
    if (chunk.length && rows + groupRow + itemRows(item) > rowsPerPage) {
      chunks.push(chunk);
      chunk = [];
      rows = 0;
      lastGroup = undefined;
    }
    const nextGroupRow = item.group && item.group !== lastGroup ? groupRows : 0;
    chunk.push(item);
    rows += nextGroupRow + itemRows(item);
    lastGroup = item.group;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.length ? chunks : [[]];
}

export function indexPageCount<T extends { group?: string }>(items: T[], rowsPerPage?: number,
  itemRows?: (item: T) => number, groupRows?: number) {
  return indexChunks(items, rowsPerPage, itemRows, groupRows).length;
}
