/** Compose physical PDF pages with observed folios and corroborated embedded labels. */
export function resolvePdfPagination(observed, embedded, reporterStarts = []) {
  const count = Math.max(observed.length, embedded.length);
  const generic = embedded.every((label, index) => !label || label === String(index + 1));
  const corroborated = embedded.some((label, index) => label && label === observed[index]) &&
    !embedded.some((label, index) => label && observed[index] && label !== observed[index]);
  const bindings = Array.from({ length: count }, (_, index) => {
    const detected = observed[index]?.trim() || null;
    const metadata = generic ? null : embedded[index]?.trim() || null;
    const conflict = !!detected && !!metadata && detected !== metadata;
    const acceptedMetadata = corroborated ? metadata : null;
    return { pdfPage: index + 1, observed: detected, label: conflict ? null : detected ?? acceptedMetadata,
      source: conflict ? null : detected ? "detected" : acceptedMetadata ? "embedded" : null,
      status: conflict ? "ambiguous" : detected || acceptedMetadata ? "resolved" : "unknown" };
  });
  // Reporter interpolation is opt-in and begins at one unique observed anchor.
  const anchors = bindings.filter(entry => entry.status === "resolved" &&
    entry.observed && reporterStarts.includes(Number(entry.observed)));
  if (anchors.length !== 1) return bindings;
  const anchor = anchors[0], first = Number(anchor.observed);
  if (!Number.isSafeInteger(first) || first < 1) return bindings;
  const run = bindings.slice(anchor.pdfPage - 1);
  if (run.some(entry => entry.status === "ambiguous" || (entry.label !== null &&
      entry.label !== String(first + entry.pdfPage - anchor.pdfPage)))) return bindings;
  for (const entry of run) {
    entry.label = String(first + entry.pdfPage - anchor.pdfPage);
    entry.source = "reporter"; entry.status = "resolved";
  }
  return bindings;
}

/** Text-Fidelity's edge-folio rule, with the host's citation parser as a veto. */
export function reporterMarginLabels(labels, starts, pages, isCitation) {
  const result = [...labels];
  for (const page of pages) {
    if (page.pageNumber > 3 || result[page.pageNumber - 1]) continue;
    const candidates = new Set();
    const top = Math.min(...page.lines.map(line => line.rect[3]));
    const bottom = Math.max(...page.lines.map(line => line.rect[1]));
    for (const line of page.lines) {
      // Include the outermost text rows when publisher whitespace insets the page.
      if (!(line.rect[3] <= page.height * .14 || line.rect[1] >= page.height * .86 ||
          line.rect[1] <= top || line.rect[3] >= bottom)) continue;
      const value = (line.text || line.words.map(word => word.text).join(" ")).trim();
      if (value.length > 140) continue;
      // OCR sometimes inserts spaces inside a printed folio ("74 1" for 741).
      // Only the known reporter start, alone at a page edge, can repair it.
      const spaced = /^\s*\d{1,4}(?:\s+\d){1,4}\s*$/u.test(value)
        ? value.replace(/\s+/gu, "") : null;
      if (spaced && starts.includes(Number(spaced)) &&
          (line.rect[0] <= page.width * .2 || line.rect[2] >= page.width * .8) &&
          !isCitation(value, spaced)) candidates.add(spaced);
      const leading = /^[\s[({.,;:'"_\-=–—]*(\d{1,5})(?!\d)/u.exec(value);
      const trailing = /(?<!\d)(\d{1,5})[\s\])}.,;:'"_\-=–—]*$/u.exec(value);
      for (const [match, edge] of [[leading, "leading"], [trailing, "trailing"]]) {
        if (!match || !starts.includes(Number(match[1]))) continue;
        if (edge === "leading" && /^\s*\[\s*(?:18|19|20)\d{2}\s*\]/u.test(value)) continue;
        if (edge === "leading" ? line.rect[0] > page.width * .2 : line.rect[2] < page.width * .8) continue;
        if (isCitation(value, match[1])) continue;
        if (edge === "trailing" && /\b(?:vol(?:ume)?|issue|no|para|paragraph)\.?\s*$/iu.test(value.slice(0, match.index))) continue;
        candidates.add(match[1]);
      }
    }
    if (candidates.size === 1) result[page.pageNumber - 1] = [...candidates][0];
  }
  return result;
}

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
