// Quotation checks against source text, with ALR's statuses: OG_PINPOINT_MATCH/PARTIAL at the cited
// location, ALT_PINPOINT(LESS)_MATCH/PARTIAL_<A2AJ|CANLII> elsewhere in the source, NO_MATCH.
// Ported from alr_quote_verifier.py _apply_quote_checks and verifier_core/a2aj_pinpoint_scope.py
// (cited_scopes, resolve_quote). Sources are Beaver's: A2AJ documents, the journals database, and
// CanLII PDFs the reader downloads (attachSource); CanLII pages are never fetched.
import { structureNative } from "../structureNative";
import { correctedQuote, isOnlyBracketedQuote, outerQuoteMarks, plausibleContentOverlap, quoteDedupeKey,
  quoteExactKey, quoteMatchScore, quoteRegion, quoteWords, sourceSideQuoteFragment, withOuterQuotes } from "../quoteMatch";
import type { InlineQuote } from "./document";
import { citations } from "./engine";
import type { Linker } from "./links";
import { lawIdentity } from "./links";
import { usesChainOrigin } from "./references";
import type { AlrRow } from "./rows";
import type { FragmentMode } from "./settings";
import type { AlrSources, SourceBlock, SourceDocument } from "./sources";
import { canliiDocCitation, canliiLookupUrl, isCanlii, isUsableLink, recombineUrl, sanitizeUrl, splitUrl } from "./urls";

const MIN_MATCH = 0.6, STRONG_MATCH = 0.98, ALT_RECHECK = 0.9;
type Entry = { inner: string; raw: string; style: string };
type Scopes = { paragraphs: Array<[number, number]>; pages: Array<[number, number]>; sections: string[] };
type Resolution = { location: string; score: number; labels: string[]; text: string };
/** The text a row was checked against, kept so attached sources can re-check only what they affect. */
export type CheckedSource = { tag: string; family: "A2AJ" | "CANLII" | "JOURNAL"; document: SourceDocument; link: string;
  reconciled: boolean };

const quoteText = (entry: Entry) => (entry.inner || entry.raw).trim();
const inRanges = (value: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => a <= value && value <= b);
const parseList = (value: string): unknown[] => { try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; } };

/** Every paragraph, page and provision the citation names, from the engine's pinpoints and the part's fragments. */
export function citedScopes(row: AlrRow): Scopes {
  const kind = row.citation_part_kind.trim().toLowerCase();
  const caseSource = kind === "case" || kind === "unreported", lawSource = ["statute", "regulation", "legislation"].includes(kind);
  const unresolved = kind === "" || kind === "other";
  const allowParagraphs = caseSource || unresolved, allowSections = lawSource || unresolved, allowPages = !lawSource;
  const scopes: Scopes = { paragraphs: [], pages: [], sections: [] };
  const text = [...new Set([row.citation_with_style, row.citation_part_corrected, row.bare_citation, row.citation_part_text]
    .map((value) => value.trim()).filter(Boolean))].join("\n");
  const range = (first?: string, last?: string): [number, number] | null => {
    const a = Number(first), b = Number(last ?? first);
    return Number.isInteger(a) && Number.isInteger(b) ? [a, Math.max(a, b)] : null;
  };
  const pins = [...citations(text).flatMap((citation) => citation.pinpoints ?? []),
    ...structureNative().authorityReferencesInText(text).flatMap((reference) => reference.pinpoints)];
  for (const pin of pins) {
    if (pin.kind === "paragraph" && allowParagraphs) { const found = range(pin.first, pin.last); if (found) scopes.paragraphs.push(found); }
    else if (pin.kind === "page" && allowPages) { const found = range(pin.first, pin.last); if (found) scopes.pages.push(found); }
    else if (pin.kind === "section" && allowSections && pin.first) scopes.sections.push(`sec${pin.first.replace(/\s+/gu, "")}`);
  }
  const fragments = [...parseList(row.pinpoint_fragments), ...(usesChainOrigin(row) ? parseList(row._origin?.pinpoint_fragments ?? "") : [])]
    .map(String);
  for (const link of [row.citation_part_link, usesChainOrigin(row) ? row._origin?.link ?? "" : ""])
    if (link) fragments.push(splitUrl(link)[1].split(":~:text=")[0]);
  for (const raw of fragments) {
    const fragment = raw.trim().replace(/^#/u, "");
    const paragraph = /^par(\d{1,4})$/iu.exec(fragment);
    if (paragraph && allowParagraphs) { const n = Number(paragraph[1]); if (!inRanges(n, scopes.paragraphs)) scopes.paragraphs.push([n, n]); continue; }
    const section = /^sec(.+)$/iu.exec(fragment);
    if (section && allowSections && !scopes.sections.some((value) => value.toLowerCase().startsWith(`sec${section[1]}(`.toLowerCase())))
      scopes.sections.push(`sec${section[1]}`);
  }
  if (allowPages) for (const value of parseList(row.page_pinpoints)) {
    const page = Number(value);
    if (Number.isInteger(page) && !inRanges(page, scopes.pages)) scopes.pages.push([page, page]);
  }
  const unique = <T>(values: T[]) => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  return { paragraphs: unique(scopes.paragraphs), pages: unique(scopes.pages), sections: unique(scopes.sections) };
}
const hasScopes = (scopes: Scopes) => !!(scopes.paragraphs.length || scopes.pages.length || scopes.sections.length);

const blockNumber = (block: SourceBlock) => Number(block.kind === "paragraph" ? block.label.slice(3) : block.label.split(" ").at(-1));
function sectionAncestors(label: string) {
  const out = [label];
  let current = label;
  while (/\([^)]+\)$/u.test(current)) { current = current.replace(/\([^)]+\)$/u, ""); out.push(current); }
  return out;
}
function citedSelection(blocks: SourceBlock[], scopes: Scopes) {
  const selected = new Map<SourceBlock, boolean>();
  for (const block of blocks) {
    if (block.kind === "paragraph" && inRanges(blockNumber(block), scopes.paragraphs)) selected.set(block, true);
    if (block.kind === "page" && inRanges(blockNumber(block), scopes.pages)) selected.set(block, true);
  }
  const sections = new Map(blocks.filter((block) => block.kind === "section").map((block) => [block.label.toLowerCase(), block]));
  for (const section of scopes.sections) for (const candidate of sectionAncestors(section)) {
    const block = sections.get(candidate.toLowerCase());
    if (block) { selected.set(block, (selected.get(block) ?? false) || candidate.toLowerCase() === section.toLowerCase()); break; }
  }
  return selected;
}
const wordCount = (quote: string, text: string) => {
  const needle = quoteWords(quote), words = quoteWords(text);
  let count = 0;
  for (let i = 0; needle.length && i + needle.length <= words.length; i++) if (needle.every((word, j) => words[i + j] === word)) count++;
  return count;
};
function specificLabels(matches: Array<[number, SourceBlock]>) {
  const labels: string[] = [];
  for (const [score, block] of matches) {
    if (labels.includes(block.label)) continue;
    if (block.kind === "section" && matches.some(([other, candidate]) => candidate.kind === "section" && other >= score &&
      candidate.label.toLowerCase().startsWith(`${block.label.toLowerCase()}(`))) continue;
    labels.push(block.label);
  }
  return labels;
}
const plausible = (quote: string, text: string) => plausibleContentOverlap(quote, quoteRegion(quote, text, 400) || text);
function scored(quote: string, blocks: SourceBlock[]) {
  return blocks.map((block): [number, SourceBlock] => [quoteMatchScore(quote, block.text), block])
    .filter(([score, block]) => score >= MIN_MATCH && plausible(quote, block.text))
    .sort((a, b) => b[0] - a[0] || a[1].start - b[1].start);
}
function rangeBlocks(blocks: SourceBlock[], scopes: Scopes) {
  const combined: SourceBlock[] = [];
  for (const [kind, ranges] of [["paragraph", scopes.paragraphs], ["page", scopes.pages]] as const) for (const [start, end] of ranges) {
    if (end <= start) continue;
    const members = blocks.filter((block) => block.kind === kind && start <= blockNumber(block) && blockNumber(block) <= end)
      .sort((a, b) => blockNumber(a) - blockNumber(b));
    if (members.map(blockNumber).join() !== Array.from({ length: end - start + 1 }, (_, i) => start + i).join()) continue;
    combined.push({ kind, label: kind === "paragraph" ? `par${start}–${end}` : `pages ${start}–${end}`, start: members[0].start,
      end: members.at(-1)!.end, text: members.map((block) => block.text).join("\n") });
  }
  return combined;
}

/** Where a quotation is in a structured source: the cited block first, then anywhere else. */
export function resolveQuote(document: SourceDocument, quote: string, scopes: Scopes): Resolution {
  const blocks = document.blocks, selection = hasScopes(scopes) ? citedSelection(blocks, scopes) : new Map<SourceBlock, boolean>();
  const scoped = [...selection.keys()], combined = rangeBlocks(blocks, scopes);
  const scopedMatches = scored(quote, [...scoped, ...combined]);
  let strong = scopedMatches.filter(([score]) => score >= STRONG_MATCH);
  const located = (matches: Array<[number, SourceBlock]>) => {
    const best = matches[0][1];
    return { location: combined.includes(best) || selection.get(best) ? "cited" : "cited_parent", score: matches[0][0],
      labels: specificLabels(matches), text: best.text };
  };
  if (strong.length) {
    const ranges = strong.filter(([, block]) => combined.includes(block)), specific = strong.filter(([, block]) => !combined.includes(block));
    if (ranges.length && specific.length) strong = specific.some(([, block]) => wordCount(quote, block.text)) ||
      specific[0][0] >= ranges[0][0] ? specific : ranges;
    return located(strong);
  }
  const scopedSet = new Set(scoped);
  const alternates = scored(quote, blocks).filter(([, block]) => !scopedSet.has(block));
  let matches = alternates.filter(([score]) => score >= STRONG_MATCH);
  if (!matches.length && scopedMatches.length) return located(scopedMatches.slice(0, 1));
  const targetKindAvailable = (scopes.paragraphs.length && blocks.some((block) => block.kind === "paragraph")) ||
    (scopes.pages.length && blocks.some((block) => block.kind === "page")) ||
    (scopes.sections.length && blocks.some((block) => block.kind === "section"));
  if (!matches.length) {
    const collapsed = alternates.filter(([score, block]) => block.kind !== "section" || !alternates.some(([other, candidate]) =>
      other >= score && candidate.label.toLowerCase().startsWith(`${block.label.toLowerCase()}(`)));
    if (collapsed.length && (collapsed.length === 1 || collapsed[0][0] - collapsed[1][0] >= 0.1)) matches = collapsed.slice(0, 1);
  }
  if (matches.length) {
    let labels: string[];
    if (quoteWords(quote).length < 3) {
      const exact = matches.filter(([, block]) => wordCount(quote, block.text));
      if (wordCount(quote, document.text) === 1 && exact.length) { matches = exact; labels = specificLabels(matches); }
      else labels = [];
    } else labels = specificLabels(matches);
    const location = scoped.length || targetKindAvailable ? "alternate" : hasScopes(scopes) ? "scope_unavailable" : "uncited";
    return { location, score: matches[0][0], labels, text: matches[0][1].text };
  }
  const score = quoteMatchScore(quote, document.text);
  if (score >= MIN_MATCH) return { location: scoped.length || targetKindAvailable ? "alternate_document"
    : hasScopes(scopes) ? "scope_unavailable_document" : "uncited_document", score, labels: [], text: document.text };
  return { location: "unmatched", score, labels: [], text: "" };
}

export function pinpointSummary(pinpoints: string[], limit = 2) {
  const values = pinpoints.map((value) => value.trim()).filter(Boolean);
  return values.slice(0, limit).join(", ") + (values.length > limit ? ` [+${values.length - limit} more instances]` : "");
}
/** A CanLII page anchor for a paragraph or top-level provision found in the source. */
export function anchorLink(link: string, label: string) {
  const [base] = splitUrl(canliiLookupUrl(sanitizeUrl(link)));
  if (!base || !isCanlii(base) || !/\.html$/iu.test(new URL(base).pathname)) return "";
  if (/^par\d{1,4}$/iu.test(label)) return recombineUrl(base, label);
  const provision = /^sec(\d{1,8}(?:[.-]\d{1,8}){0,3})(?:\([^)]+\))*$/iu.exec(label);
  return provision && new URL(base).pathname.toLowerCase().includes("/laws/") ? recombineUrl(base, `sec${provision[1]}`) : "";
}

/** A link that opens the source at the quoted words (Rust text-fragment planner); the plain link when unsafe. */
export function fragmentLink(link: string, source: CheckedSource | undefined, blockText: string, sourceFragment: string) {
  if (!link || !source?.document.native || !blockText || !sourceFragment) return link;
  const plan = structureNative().textFragmentPlan(blockText, [sourceFragment], false, false, false, source.document.native);
  if (!plan.sourceSafeComplete || !plan.directives.length) return link;
  const [base, fragment] = splitUrl(link), anchor = fragment.split(":~:")[0];
  return `${base}#${anchor}:~:${plan.directives.join("&")}`;
}

const CHECKABLE = new Set(["case", "unreported", "statute", "regulation", "legislation", "gazette"]);
const shouldReportMissing = (row: AlrRow) => {
  const link = sanitizeUrl(row.citation_part_link);
  if (!/^https?:\/\/[^/]/iu.test(link)) return false;
  const kind = row.citation_part_kind.trim().toLowerCase();
  return CHECKABLE.has(kind) || (kind === "journal" && row._journal_link_resolved);
};

export type QuoteCheckOptions = { sources: AlrSources; linker: Linker; a2aj: boolean; fragmentMode: FragmentMode;
  attached: Map<string, SourceDocument>; journalPages: (articleId: string, label: number) => Promise<number | null> };

/** The source a row's quotations are read against, in ALR's order of preference. */
async function rowSource(row: AlrRow, options: QuoteCheckOptions): Promise<CheckedSource | null> {
  const origin = usesChainOrigin(row) ? row._origin : undefined;
  const articleId = row._journal_article_id || origin?.journal_article_id || "";
  if (articleId) {
    const document = await options.sources.document({ provider: "journal", id: articleId, kind: "journal" });
    if (document?.text.trim()) return { tag: "journal_db", family: "JOURNAL", document, link: row.citation_part_link, reconciled: false };
  }
  const [base] = splitUrl(canliiLookupUrl(row.citation_part_link.trim()));
  const attached = options.attached.get(base);
  if (attached) return { tag: "attached", family: "CANLII", document: attached, link: row.citation_part_link, reconciled: true };
  if (!options.a2aj) return null;
  const locked = options.linker.locked.get(base);
  if (locked) {
    const document = await options.sources.document(locked.reference);
    if (document?.text) return { tag: "a2aj_locked", family: "A2AJ", document, link: row.citation_part_link, reconciled: true };
  }
  const candidates: Array<[string, string, string, string]> = [
    [row.bare_citation.trim(), row.citation_part_kind.trim(), "a2aj", row.citation_part_link],
    [canliiDocCitation(row.citation_part_link), "case", "link_a2aj", row.citation_part_link],
    [origin?.bare_citation.trim() ?? "", origin?.kind.trim() ?? "", "origin_a2aj", origin?.link ?? ""]];
  const seen = new Set<string>();
  for (const [bare, kind, tag, link] of candidates) {
    const lowered = kind.toLowerCase();
    if (!bare || !["case", "unreported", "statute", "gazette"].includes(lowered) || seen.has(`${bare}|${lowered}`)) continue;
    seen.add(`${bare}|${lowered}`);
    const legislation = lowered === "statute" || lowered === "gazette";
    const reference = await options.sources.resolve(legislation ? lawIdentity(bare) : bare, legislation ? "legislation" : "case",
      link.toLowerCase().includes("/fr/") ? "fr" : "en");
    if (!reference) continue;
    const document = await options.sources.document(reference);
    if (!document?.text) continue;
    // The link is reconciled when its CanLII citation is the document's own.
    const linkCitation = canliiDocCitation(link);
    const keys = (value: string | null | undefined) => citations(value ?? "").map((citation) => citation.key).filter(Boolean);
    const reconciled = !!linkCitation && keys(linkCitation).some((key) =>
      [...keys(reference.citation), ...keys(reference.alternateCitation)].includes(key));
    return { tag, family: "A2AJ", document, link, reconciled };
  }
  return null;
}

const original = (entry: Entry) => { const [open, close] = outerQuoteMarks(entry.raw, entry.style); return withOuterQuotes(quoteText(entry), open, close); };
const pageLabel = (value: string) => { const found = /\bpages?\s+(\d{1,5})\b/iu.exec(value); return found ? Number(found[1]) : null; };

/** Page labels where the quotation's words run, preferring the cited pages. */
function pagePinpoint(document: SourceDocument, quote: string, preferred: number[]) {
  const pages = document.blocks.filter((block) => block.kind === "page");
  if (!pages.length) return "";
  const hits = pages.filter((block) => quoteMatchScore(quote, block.text) >= STRONG_MATCH).map((block) => block.label);
  const wanted = hits.filter((label) => preferred.includes(Number(label.split(" ").at(-1))));
  if (hits.length) return pinpointSummary(wanted.length ? wanted : hits);
  // A quotation running over a page break.
  const words = quoteWords(quote);
  for (let i = 0; i + 1 < pages.length; i++) {
    const joined = `${pages[i].text} ${pages[i + 1].text}`;
    if (words.length && quoteMatchScore(quote, joined) >= STRONG_MATCH)
      return `pages ${pages[i].label.split(" ").at(-1)}–${pages[i + 1].label.split(" ").at(-1)}`;
  }
  return "";
}

export async function checkRowQuotes(row: AlrRow, quotes: readonly InlineQuote[], options: QuoteCheckOptions) {
  const entries: Entry[] = [], seen = new Set<string>();
  for (const quote of quotes) {
    const text = (quote.inner.trim() || quote.raw.trim());
    if (!text) continue;
    const key = quoteDedupeKey(text);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    entries.push({ inner: quote.inner.trim(), raw: quote.raw.trim(), style: quote.style });
  }
  if (!entries.length) return null;
  const noMatch = (notes: string) => {
    row.quote_check_status = "NO_MATCH";
    row.quote_corrected_citation = entries.map(original).join("\n\n").trim();
    row.quote_check_notes = notes;
  };
  const source = await rowSource(row, options);
  if (!source) {
    noMatch(shouldReportMissing(row) ? "No source text found for this citation." : "");
    return null;
  }
  row._quote_source_tag = source.tag;
  const { document } = source, text = document.text;
  const pages = parseList(row.page_pinpoints).map(Number).filter(Number.isInteger);
  const scopes = citedScopes(row);
  const structured = source.family !== "JOURNAL" && document.blocks.length > 0;
  let anchorText = text, sourcePinpoint = "";
  if (source.family === "JOURNAL" && pages.length) {
    const page = document.blocks.find((block) => block.kind === "page" && block.label === `page ${pages[0]}`);
    if (page && Math.max(...entries.map((entry) => quoteMatchScore(quoteText(entry), page.text))) >= MIN_MATCH) {
      anchorText = page.text; sourcePinpoint = `page ${pages[0]}`;
      const pdfPage = await options.journalPages(row._journal_article_id, pages[0]);
      if (pdfPage !== null && isUsableLink(row.citation_part_link)) row.quote_match_link = `${splitUrl(row.citation_part_link)[0]}#page=${pdfPage}`;
    }
  }
  const resolutions = new Map<string, Resolution>();
  if (structured) for (const entry of entries) {
    const quote = quoteText(entry);
    let resolution = resolveQuote(document, quote, scopes);
    if (quoteWords(quote).length < 3 && resolution.location.startsWith("alternate") && !resolution.labels.length)
      resolution = { location: "unmatched", score: 0, labels: [], text: "" };
    resolutions.set(quoteDedupeKey(quote), resolution);
  }
  const matched = entries.map((entry): [number, Entry] => {
    const resolution = resolutions.get(quoteDedupeKey(quoteText(entry)));
    return [resolution ? resolution.score : quoteMatchScore(quoteText(entry), anchorText), entry];
  }).sort((a, b) => b[0] - a[0]).filter(([score]) => score >= MIN_MATCH);
  const notFound = () => entries.some((entry) => quoteWords(quoteText(entry)).length < 3 && anchorText.length > 80_000)
    ? entries.every((entry) => quoteWords(quoteText(entry)).length < 3)
      ? "Quote too short for full-document fuzzy checking in a long source; exact search found no match."
      : "One or more quotes were too short for full-document fuzzy checking in a long source; exact search found no match."
    : "Quote not found in source text.";
  if (!matched.length) { noMatch(notFound()); return source; }

  const corrected: string[] = [], unchanged: boolean[] = [], scores: number[] = [], locations: string[] = [];
  const regions: string[] = [], fragments: string[] = [], pinpoints: string[] = [], links: string[] = [];
  const alternatePinpoints: string[] = [], alternateLinks: string[] = [], correctedKeys = new Set<string>();
  let firstBlock = "";
  for (const [score, entry] of matched) {
    const quote = quoteText(entry), resolution = resolutions.get(quoteDedupeKey(quote));
    const matchText = resolution?.text || anchorText, region = quoteRegion(quote, matchText, 400);
    if (score < STRONG_MATCH && !plausibleContentOverlap(quote, region || matchText)) continue;
    let correctionSource = region || matchText;
    if (!region && matchText.length > 80_000) correctionSource = quote;
    const fragment = region ? sourceSideQuoteFragment(region, quote) : "";
    if (fragment && quoteMatchScore(quote, fragment) >= MIN_MATCH) correctionSource = fragment;
    const [open, close] = outerQuoteMarks(entry.raw, entry.style);
    const fixed = withOuterQuotes(correctedQuote(quote, correctionSource), open, close);
    if (isOnlyBracketedQuote(fixed)) continue;
    const key = quoteDedupeKey(fixed);
    if (key && correctedKeys.has(key)) continue;
    if (key) correctedKeys.add(key);
    corrected.push(fixed); scores.push(score); unchanged.push(quoteExactKey(fixed) === quoteExactKey(quote));
    if (resolution) locations.push(resolution.location);
    let pinpoint = sourcePinpoint, matchedRegion = region;
    if (resolution?.labels.length && !resolution.location.startsWith("scope_unavailable")) {
      pinpoints.push(...resolution.labels);
      const alternate = resolution.location.startsWith("alternate");
      if (alternate) alternatePinpoints.push(...resolution.labels);
      const promoted = source.reconciled ? anchorLink(source.link, resolution.labels[0]) : "";
      if (alternate && promoted) alternateLinks.push(promoted);
      if (promoted) { row.quote_match_link = promoted; links.push(promoted); }
      pinpoint = pinpointSummary(resolution.labels); matchedRegion = resolution.text;
      firstBlock ||= resolution.text;
    } else if (resolution?.location.startsWith("alternate") && source.reconciled) {
      const [base] = splitUrl(source.link);
      if (base) alternateLinks.push(base);
    }
    if (!pinpoint) {
      pinpoint = pagePinpoint(document, quote, pages);
      if (pinpoint && source.family === "JOURNAL") {
        const label = pageLabel(pinpoint), pdfPage = label === null ? null : await options.journalPages(row._journal_article_id, label);
        if (pdfPage !== null && isUsableLink(row.citation_part_link)) row.quote_match_link = `${splitUrl(row.citation_part_link)[0]}#page=${pdfPage}`;
      }
      if (pinpoint && !resolution?.labels.length) pinpoints.push(pinpoint);
    }
    if (region) regions.push(matchedRegion.replace(/\n/gu, " "));
    if (fragment) fragments.push(fragment);
  }
  if (!corrected.length) { noMatch(notFound()); return source; }

  let summary = pinpointSummary([...new Set(pinpoints)]) || sourcePinpoint;
  if (links.length) row.quote_match_link = links[0];
  row.quote_corrected_citation = corrected.join("\n\n").trim();
  row.quote_match_pinpoint = summary;
  if (regions.length) row.matched_source = regions.join("\n\n").trim();
  if (fragments.length) row.matched_source_fragment = fragments.join("\n\n").trim();
  const perfect = corrected.length === entries.length && scores.every((score) => score >= STRONG_MATCH) && unchanged.every(Boolean);
  const alternates = locations.filter((location) => location.startsWith("alternate"));
  const limited = locations.some((location) => location.startsWith("scope_unavailable") || location === "cited_parent");
  if (hasScopes(scopes) && alternates.length) {
    summary = pinpointSummary([...new Set(alternatePinpoints)]);
    row.quote_match_pinpoint = summary;
    row.quote_match_link = alternateLinks[0] ?? "";
    const level = perfect && alternates.length === locations.length ? "MATCH" : "PARTIAL";
    const family = source.family === "CANLII" ? "CANLII" : "A2AJ";
    row.quote_check_status = summary ? `ALT_PINPOINT_${level}_${family}` : `ALT_PINPOINTLESS_${level}_${family}`;
    row.quote_check_notes = summary;
  } else if (perfect && !limited) row.quote_check_status = "OG_PINPOINT_MATCH";
  else {
    row.quote_check_status = "OG_PINPOINT_PARTIAL";
    if (limited) row.quote_check_notes = "The cited pinpoint could not be isolated in the available source structure.";
  }
  // Text-fragment links open the source at the quoted words (frag_mode).
  const fragmentWanted = options.fragmentMode === "all" || (options.fragmentMode === "pinpointless" && !row.quote_match_pinpoint);
  const target = row.quote_match_link || (row.quote_check_status.startsWith("OG_PINPOINT") ? row.citation_part_link : "");
  if (fragmentWanted && target && source.reconciled && fragments[0] && isCanlii(target))
    row._corrected_link = fragmentLink(target, source, firstBlock || quoteRegion(quoteText(matched[0][1]), text, 400), fragments[0]);
  return source;
}

/** The quotation found word for word somewhere else in a CanLII source the reader attached, for a partial row. */
export function alternateSupplement(row: AlrRow, quotes: readonly InlineQuote[], source: CheckedSource) {
  if (source.family !== "CANLII" || row.quote_check_status !== "OG_PINPOINT_PARTIAL") return;
  const entries = quotes.map((quote) => ({ inner: quote.inner.trim(), raw: quote.raw.trim(), style: quote.style })).filter(quoteText);
  const exact = source.document.blocks.filter((block) => block.kind === "paragraph" &&
    entries.some((entry) => quoteMatchScore(quoteText(entry), block.text) >= 1));
  if (!exact.length || Math.max(...entries.map((entry) => quoteMatchScore(quoteText(entry), row.matched_source || ""))) >= ALT_RECHECK) return;
  row._alternate_quote_check_notes = pinpointSummary(exact.map((block) => block.label));
  const fixed = entries.map((entry) => {
    const [open, close] = outerQuoteMarks(entry.raw, entry.style);
    return withOuterQuotes(correctedQuote(quoteText(entry), quoteRegion(quoteText(entry), exact[0].text, 400) || exact[0].text), open, close);
  }).filter((value) => value && !isOnlyBracketedQuote(value));
  if (fixed.length) row._alternate_quote_corrected_citation = fixed.join("\n\n");
  const fragments = entries.map((entry) => sourceSideQuoteFragment(quoteRegion(quoteText(entry), exact[0].text, 400), quoteText(entry))).filter(Boolean);
  if (fragments.length) row.alternate_matched_source_fragment = fragments.join("\n\n");
}
