/** A PDF's page map is the engine's (`PdfDocument::page_map`, structureNative().pdfPageMap); these read one. */
export function printedPageIndices(labels) {
  const result = new Map();
  labels.forEach((label, index) => {
    if (label) result.set(label, [...(result.get(label) ?? []), index]);
  });
  return result;
}

/** A printed pinpoint resolves only when every requested label has one destination. */
export function resolvePrintedPages(label, bindings) {
  // Unknown pages can hide duplicate folios. Only a verified reporter suffix
  // may follow unlabelled opening pages; conflicts never permit automatic routing.
  const firstResolved = bindings.findIndex(page => page.status === "resolved");
  if (firstResolved < 0 || bindings.some((page, index) => page.pdfPage !== index + 1 || page.status === "ambiguous")) return [];
  if (bindings.some(page => page.status !== "resolved") &&
      (bindings.slice(0, firstResolved).some(page => page.status !== "unknown") ||
       bindings.slice(firstResolved).some(page => page.status !== "resolved" || page.source !== "reporter"))) return [];
  const labels = printedPageIndices(bindings.map(page => page.label));
  const match = /^\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/u.exec(label);
  if (!match) return labels.get(label.trim())?.length === 1 ? labels.get(label.trim()) : [];
  const first = Number(match[1]), end = match[2] ?? match[1];
  const last = Number(end.length < match[1].length
    ? match[1].slice(0, match[1].length - end.length) + end : end);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last - first > 2000) return [];
  const result = [];
  for (let number = first; number <= last; number++) {
    const pages = labels.get(String(number));
    if (pages?.length !== 1) return [];
    result.push(pages[0]);
  }
  return [...new Set(result)];
}
