import { resolvePrintedPages } from "./pdf-page-binding.mjs";

export function citedSourcePages(draft, authorityId, pages,
  pageLabels, pageCount = pages.length, geometry) {
  const authority = draft.authorities[authorityId];
  const locators = [...(authority?.locators ?? []), ...Object.values(draft.occurrences)
    .flatMap((occurrence) => occurrence.authorityId === authorityId
      ? occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text })) : [])];
  const result = new Set();
  for (const { kind, label } of locators) {
    if (kind === "page") {
      if (pageLabels) resolvePrintedPages(label, pageLabels, pageCount).forEach(index => result.add(index));
    }
    // A paragraph the geometry could not place still has a page: the one whose
    // text prints its number. That page carries the mark instead of nothing.
    if (kind === "paragraph" && !geometry?.targets.some((target) => target.status === "found" &&
        target.locatorKind === kind && target.locator.trim() === label.trim())) {
      const number = /\d+/u.exec(label)?.[0];
      const index = number ? pages.findIndex((text) =>
        new RegExp(String.raw`(?:^|\s)\[\s*${number}\s*\]`, "u").test(text)) : -1;
      if (index >= 0) result.add(index);
    }
  }
  geometry?.targets.filter(target => target.status === "found").forEach(target =>
    target.pages.forEach(({ pageNumber }) => { if (pageNumber > 0 && pageNumber <= pageCount) result.add(pageNumber - 1); }));
  return result;
}

