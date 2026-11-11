/** The index's pages at one row a document, a group's heading a row of its own (the engine measures the built one). */
export function indexPageCount<T extends { group?: string }>(items: T[], rowsPerPage = 25) {
  let pages = 1, rows = 0, lastGroup: string | undefined;
  for (const item of items) {
    const groupRow = item.group && item.group !== lastGroup ? 1 : 0;
    if (rows && rows + groupRow + 1 > rowsPerPage) { pages += 1; rows = 0; lastGroup = undefined; }
    rows += (item.group && item.group !== lastGroup ? 1 : 0) + 1;
    lastGroup = item.group;
  }
  return pages;
}
