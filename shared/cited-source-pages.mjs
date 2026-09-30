export function citedSourcePages(draft, authorityId, pages,
  pageLabels, pageCount = pages.length, geometry) {
  const authority = draft.authorities[authorityId];
  const locators = [...(authority?.locators ?? []), ...Object.values(draft.occurrences)
    .flatMap((occurrence) => occurrence.authorityId === authorityId
      ? occurrence.pinpoints.map(({ kind, text }) => ({ kind, label: text })) : [])];
  const result = new Set();
  for (const { kind, label } of locators) {
    if (kind === "page") {
      const [firstText = "0", lastText] = [...label.matchAll(/\d+/gu)].map(([value]) => value);
      const first = Number(firstText);
      // A shortened end ("138-39") keeps the start's leading digits: 138 to 139.
      const last = lastText === undefined ? first : Number(lastText) >= first ? Number(lastText)
        : Number(firstText.slice(0, Math.max(0, firstText.length - lastText.length)) + lastText);
      for (let number = first; number <= Math.max(first, last); number += 1) {
        if (pageLabels) pageLabels.get(String(number))?.forEach((index) => result.add(index));
        else if (number > 0 && number <= pageCount) result.add(number - 1);
      }
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

