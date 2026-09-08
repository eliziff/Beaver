import { normalizeQuoteText, strippedToOriginal } from "./views/quoteText";

export type ReaderSlice = { start: number; text: string; page?: number };
function alignment(body: HTMLElement, slices: ReaderSlice[]) {
  const slice = slices.find((slice, index) => String(slice.page ?? index) === body.dataset.legalText),
    rendered = normalizeQuoteText(body.textContent ?? "");
  if (!slice || !rendered) return null;
  const canonical = normalizeQuoteText(slice.text), chunks: string[] = [], offsets: number[] = [],
    walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const chunk = normalizeQuoteText(node.textContent ?? ""); if (chunk) chunks.push(chunk);
  }
  let cursor = 0;
  for (const chunk of chunks) {
    const at = canonical.indexOf(chunk, cursor); if (at < 0) return null;
    for (let index = 0; index < chunk.length; index++) offsets.push(at + index);
    cursor = at + chunk.length;
  }
  // Both directions must agree; repeated text cannot silently select another occurrence.
  cursor = canonical.length;
  let count = offsets.length;
  for (const chunk of [...chunks].reverse()) {
    const at = canonical.lastIndexOf(chunk, cursor - chunk.length); count -= chunk.length;
    if (at !== offsets[count]) return null; cursor = at;
  }
  return { rendered, at: (index: number) => slice.start + strippedToOriginal(slice.text, offsets[index] ?? canonical.length) };
}

export function readerBlockSpan(body: HTMLElement, slices: ReaderSlice[]) {
  const found = alignment(body, slices);
  return found && { start: found.at(0), end: found.at(found.rendered.length - 1) + 1 };
}

/** Map both selection edges through the served slice, never search for the selected quote. */
export function readerSelectionSpan(root: HTMLElement, selection: Selection | null, slices: ReaderSlice[]) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const edge = (node: Node, offset: number, trailing: boolean) => {
    const element = node instanceof Element ? node : node.parentElement,
      body = element?.closest<HTMLElement>("[data-legal-text]"), found = body && alignment(body, slices);
    if (!body || !root.contains(body) || !found) return null;
    const upto = document.createRange(); upto.selectNodeContents(body); upto.setEnd(node, offset);
    const count = normalizeQuoteText(upto.toString()).length;
    return trailing ? (count ? found.at(count - 1) + 1 : null) : found.at(count);
  };
  const start = edge(range.startContainer, range.startOffset, false),
    end = edge(range.endContainer, range.endOffset, true);
  return start !== null && end !== null && end > start ? { start, end } : null;
}
