// Where a citation's links go in the article's document, for the Word add-in and the page's Word copy alike (no runtime
// code, so the page's own bundle can take it).
type Span = { start: number; end: number; text: string };

/** A link's page, without the paragraph or passage it goes to: what a citation's own words link to. */
export const pageOf = (link: string) => link.split("#")[0];
const bare = (address: string) => address.toLowerCase().replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/[/.,;:)]+$/u, "");
/** The web address `text` (at `offset` in its unit) writes out, where it is `link`'s, with or without its scheme
 *  ("online: <perma.cc/ABC1-DE23>"): the words a link goes on in place of the citation's. */
export function writtenAddress(text: string, offset: number, link: string): Span | null {
  if (!link) return null;
  for (const found of text.matchAll(/(?:https?:\/\/|www\.)?[\w-]+(?:\.[\w-]+)+(?:\/[^\s<>"]*)?/giu)) {
    const words = found[0].replace(/[.,;:)]+$/u, "");
    if (bare(words) === bare(pageOf(link)) || bare(words) === bare(link))
      return { start: offset + found.index!, end: offset + found.index! + words.length, text: words };
  }
  return null;
}
/** The links a citation is written with: a web address it writes out, where it is the citation's link, alone; else
 *  its own words (never its style of cause) to the page, and its pinpoint to the paragraph or provision where its
 *  link names one. */
export function partLinks({ core, pinpoint, written }: { core: Span | null; pinpoint: Span | null; written?: Span | null }, link: string, options?: WordLinkOptions) {
  if (options?.individualPinpoints && (!written || options.pinpoints.length)) return individualWordLinks(written ?? core, link, options);
  if (written) return [{ span: written, url: link }];

  return [...core ? [{ span: core, url: pageOf(link) }] : [], ...pinpoint && /#(?:par|sec)/u.test(link) ? [{ span: pinpoint, url: link }] : []];
}

// Opt-in Word link placement; workbook and review links keep their existing lead-pinpoint behaviour.
export type WordPinpoint = { kind: string; text: string; start?: number; end?: number; first?: string; last?: string };
export type WordLinkOptions = { individualPinpoints: true; pinpoints: readonly WordPinpoint[];
  textFragments?: boolean; quotedText?: string };

/** The same authority, at one written locator. Page locators use the PDF viewer's #page=N form. */
export function wordPinpointUrl(link: string, kind: string, locator: string, quotedText?: string) {
  const page = pageOf(link);
  if (!/^https?:\/\//iu.test(page) || !/^(?:\d+(?:\.\d+)*(?:\([a-z0-9]+\))*|[a-z]\d*)$/iu.test(locator)) return null;
  let anchor: string;
  if (kind === "paragraph") anchor = `par${locator}`;
  else if (kind === "page") anchor = `page=${locator}`;
  else if (["section", "subsection", "article", "rule"].includes(kind)) {
    const parts = /^(\d+(?:\.\d+)*)(?:\(([a-z0-9]+)\))?$/iu.exec(locator);
    if (!parts) return null;
    const prefix = kind === "article" ? "art" : kind === "rule" ? "rule" : "sec";
    anchor = /\/\/(?:[^/]+)\/(?:en|fr)\/qc\/laws\//u.test(page)
      ? `se:${parts[1].replace(/\./gu, "_")}`
      : `${prefix}${parts[1]}${parts[2] ? `subsec${parts[2]}` : ""}`;
  } else return null;
  const quote = quotedText?.replace(/^[\s"“”]+|[\s"“”]+$/gu, "").replace(/\s+/gu, " ").trim();
  const fragment = quote ? `:~:text=${encodeURIComponent(quote).replace(/-/gu, "%2D")}` : "";
  return `${page}#${anchor}${fragment}`;
}

/** Link every written endpoint separately; the lead alone may carry the authored quotation's fragment. */
export function individualWordLinks(core: Span | null, link: string, options: WordLinkOptions) {
  const links = core ? [{ span: core, url: pageOf(link) }] : [];
  let lead = true;
  for (const point of [...options.pinpoints].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
    if (point.start === undefined || point.end === undefined || point.end - point.start !== point.text.length) continue;
    const values = [...point.text.matchAll(/\d+(?:\.\d+)*(?:\([a-z0-9]+\))*|\([a-z0-9]+\)/giu)];
    for (const [index, value] of values.entries()) {
      const locator = index === 0 ? point.first ?? value[0]
        : index === values.length - 1 ? point.last ?? value[0] : value[0];
      const url = wordPinpointUrl(link, point.kind, locator,
        lead && options.textFragments ? options.quotedText : undefined);
      if (!url) continue;
      links.push({ span: { start: point.start + value.index!, end: point.start + value.index! + value[0].length, text: value[0] }, url });
      lead = false;
    }
  }
  return links;
}
