const normalizeSelectionText = (text: string) => text.replace(/\s/g, "");

export type ReaderSlice = { start: number; text: string; page?: number };
function alignment(element: HTMLElement, slices: ReaderSlice[]) {
  const body = element.closest<HTMLElement>(".pdf-text-layer") ?? element,
    slice = slices.find((slice, index) => String(slice.page ?? index) === body.dataset.legalText);
  if (!slice) return null;
  const canonical = normalizeSelectionText(slice.text), chunks: string[] = [], offsets: number[] = [],
    positions = [...slice.text.matchAll(/\S/g)].map((match) => slice.start + match.index),
    walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const chunk = normalizeSelectionText(node.textContent ?? ""); if (chunk) chunks.push(chunk);
  }
  let cursor = 0;
  for (const chunk of chunks) {
    const at = canonical.indexOf(chunk, cursor);
    for (let index = 0; index < chunk.length; index++) offsets.push(at < 0 ? -1 : at + index);
    if (at >= 0) cursor = at + chunk.length;
  }
  // Both directions must agree; repeated text cannot silently select another occurrence.
  cursor = canonical.length;
  let count = offsets.length;
  for (const chunk of [...chunks].reverse()) {
    const at = canonical.lastIndexOf(chunk, cursor - chunk.length); count -= chunk.length;
    if (at !== offsets[count]) offsets.fill(-1, count, count + chunk.length);
    if (at >= 0) cursor = at;
  }
  return { body, at: (index: number) => offsets[index] == null || offsets[index] < 0 ? null : positions[offsets[index]] };
}

export function readerBlockSpan(body: HTMLElement, slices: ReaderSlice[]) {
  const range = document.createRange(); range.selectNodeContents(body);
  return readerRangeSpan(body, range, slices);
}

/** Map both selection edges through the served slice, never search for the selected quote. */
export function readerSelectionSpan(root: HTMLElement, selection: Selection | null, slices: ReaderSlice[]) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  return readerRangeSpan(root, selection.getRangeAt(0), slices);
}
function readerRangeSpan(root: HTMLElement, range: Range, slices: ReaderSlice[]) {
  const edge = (node: Node, offset: number, trailing: boolean) => {
    const element = node instanceof Element ? node : node.parentElement,
      body = element?.closest<HTMLElement>("[data-legal-text]"), found = body && alignment(body, slices);
    if (!body || !root.contains(body) || !found) return null;
    const upto = document.createRange(); upto.selectNodeContents(found.body); upto.setEnd(node, offset);
    const count = normalizeSelectionText(upto.toString()).length;
    const position = found.at(trailing ? count - 1 : count);
    return position === null ? null : position + (trailing ? 1 : 0);
  };
  const start = edge(range.startContainer, range.startOffset, false),
    end = edge(range.endContainer, range.endOffset, true);
  return start !== null && end !== null && end > start && (!(root.closest(".pdf-text-layer") || root.querySelector(".pdf-text-layer")) ||
    normalizeSelectionText(range.toString()) === normalizeSelectionText(slices.map(slice => slice.text.slice(
      Math.max(0, start - slice.start), Math.max(0, end - slice.start))).join(""))) ? { start, end } : null;
}
