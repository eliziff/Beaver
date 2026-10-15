const normalizeSelectionText = (text: string) => text.replace(/\s/g, "");

export type ReaderSlice = { start: number; text: string; page?: number };
type Position = { offset: number; slice: number };
function alignment(element: HTMLElement, slices: ReaderSlice[]) {
  const body = element.closest<HTMLElement>(".pdf-text-layer") ?? element,
    parts = slices.flatMap((slice, index) => String(slice.page ?? index) === body.dataset.legalText
      ? [{ ...slice, index }] : []);
  if (!parts.length) return null;
  const canonical = parts.map((part) => normalizeSelectionText(part.text)).join(""),
    positions: Position[] = parts.flatMap((part) => [...part.text.matchAll(/\S/g)]
      .map((match) => ({ offset: part.start + match.index, slice: part.index }))),
    chunks: Array<{ node: Node; text: string }> = [], offsets: number[] = [],
    walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = normalizeSelectionText(node.textContent ?? ""); if (text) chunks.push({ node, text });
  }
  let cursor = 0;
  for (const { text } of chunks) {
    const at = canonical.indexOf(text, cursor);
    for (let index = 0; index < text.length; index++) offsets.push(at < 0 ? -1 : at + index);
    if (at >= 0) cursor = at + text.length;
  }
  // Both directions must agree; repeated text cannot silently select another occurrence.
  cursor = canonical.length;
  let count = offsets.length;
  for (const { text } of [...chunks].reverse()) {
    const at = canonical.lastIndexOf(text, cursor - text.length); count -= text.length;
    if (at !== offsets[count]) offsets.fill(-1, count, count + text.length);
    if (at >= 0) cursor = at;
  }
  const nodes = new Map<Node, Array<Position | null>>();
  cursor = 0;
  for (const { node, text } of chunks) {
    nodes.set(node, offsets.slice(cursor, cursor + text.length).map((at) => at < 0 ? null : positions[at]));
    cursor += text.length;
  }
  return nodes;
}

export function readerBlockSpan(body: HTMLElement, slices: ReaderSlice[]) {
  const range = document.createRange(); range.selectNodeContents(body);
  return readerRangeSpan(body, range, slices);
}

/** Map every selected character through exact served membership, without filling source gaps. */
export function readerSelectionSpan(root: HTMLElement, selection: Selection | null, slices: ReaderSlice[]) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  return readerRangeSpan(root, selection.getRangeAt(0), slices);
}
function readerRangeSpan(root: HTMLElement, range: Range, slices: ReaderSlice[]) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const alignments = new Map<HTMLElement, ReturnType<typeof alignment>>(),
    selected: Position[] = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node.textContent ?? "", start = range.startContainer === node ? range.startOffset : 0,
      end = range.endContainer === node ? range.endOffset : text.length,
      chars = [...text.slice(start, end).matchAll(/\S/g)];
    if (!chars.length) continue;
    const body = node.parentElement?.closest<HTMLElement>("[data-legal-text]");
    if (!body || !root.contains(body)) return null;
    const owner = body.closest<HTMLElement>(".pdf-text-layer") ?? body;
    if (!alignments.has(owner)) alignments.set(owner, alignment(body, slices));
    const positions = alignments.get(owner)?.get(node);
    if (!positions) return null;
    const first = normalizeSelectionText(text.slice(0, start)).length;
    for (let index = 0; index < chars.length; index++) {
      const position = positions[first + index];
      if (!position) return null;
      selected.push(position);
    }
  }
  if (!selected.length) return null;
  const parts: Array<{ start: number; end: number; slice: number }> = [];
  for (const { offset, slice } of selected) {
    const prior = parts[parts.length - 1];
    if (prior && prior.slice === slice && offset >= prior.end &&
      !/\S/.test(slices[slice].text.slice(prior.end - slices[slice].start, offset - slices[slice].start)))
      prior.end = offset + 1;
    else parts.push({ start: offset, end: offset + 1, slice });
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const { start, end } of parts.sort((left, right) => left.start - right.start)) {
    const prior = ranges[ranges.length - 1];
    if (prior && start <= prior.end) prior.end = Math.max(prior.end, end);
    else ranges.push({ start, end });
  }
  return { ranges };
}
