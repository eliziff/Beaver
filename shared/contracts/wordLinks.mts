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
export function partLinks({ core, pinpoint, written }: { core: Span | null; pinpoint: Span | null; written?: Span | null }, link: string) {
  if (written) return [{ span: written, url: link }];

  return [...core ? [{ span: core, url: pageOf(link) }] : [], ...pinpoint && /#(?:par|sec)/u.test(link) ? [{ span: pinpoint, url: link }] : []];
}
