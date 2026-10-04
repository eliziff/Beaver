/** A citation with its style of cause or title in italics, as McGill sets it: `italic` is how many of its
 *  first characters that is (the shared formatter's count), or the range of them in a brief's own text. */
export function CitationText({ text, italic }: { text: string; italic?: number | readonly [number, number] }) {
  const [start, end] = typeof italic === "number" ? [0, italic] : italic ?? [0, 0];
  if (end <= start) return <>{text}</>;
  return <>{text.slice(0, start)}<i>{text.slice(start, end)}</i>{text.slice(end)}</>;
}
