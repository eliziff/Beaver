// The quote verifier's "[CHECKED] <stem>.xlsx": sheet FootnoteReferences, one row per citation part of each
// footnote, filled from an Authorities draft and its quote check. Only mapping: the parts, links, references and
// quotation results are the primitives'.
import { authoritySourceUrl } from "mike/shared/authorities-sources.mjs";
import type { AuthoritiesDraft, AuthorityOccurrence } from "../authoritiesDomain";
import { withScheme } from "../authoritiesImport";
import { footnotePropositions, type QuoteContext } from "../authoritiesQuotations";
import { journalLegalSourceProvider } from "../legalSources/journal";
import { indexedCaseUrl } from "../legalSources/canlii";
import { citedSourceReader, outerQuoteMarks, pinpointSummary, withOuterQuotes, type checkQuotes, type QuoteCheck,
  type QuoteResult } from "../quoteCheck";
import { legalSourceOperations } from "../legalSourceApplication";
import { citedPassageLink, sourceUrl } from "../legalSourceLinks";
import type { LegalSourceReference } from "../legalSources";
import type { NativeDocument } from "../structureNative";
import type { QuoteCitationUnit } from "../quoteCitationSplit";
import { structureNative } from "../structureNative";
import { ApplicationError } from "../applicationError";
import { styledXlsx, type XlsxCell, type XlsxRun, type XlsxStyles } from "../quoteCheckWorkbook";

type Check = Awaited<ReturnType<typeof checkQuotes>>;
export type AlrExportDetail = "display" | "display-json" | "diagnostic-hidden" | "diagnostic";
export type AlrWorkbookOptions = { exportDetail?: AlrExportDetail; footnotes?: string;
  /** The quotation's context, the Python app's proposition_mode: the passage since the note before ("passage", the
   *  default) or the sentence the note's marker ends or stands in. */
  quoteContext?: QuoteContext;
  /** The Python app's text fragments (frag_mode) on the links this app makes: every link ("all", the default), only
   *  the links of parts without a paragraph or section pinpoint ("pinpointless"), or none ("off"). A paragraph or
   *  section anchor stays either way, as in the Python app. */
  textFragments?: "all" | "pinpointless" | "off";
  /** Whether a part's passage may be read from A2AJ (the Python app's "Verify quotes against source text (A2AJ)");
   *  off, only an attached PDF is read. */
  a2aj?: boolean;
  /** A model's analysis of quotations, by quotation id: a column of its own, apart from the mechanical findings. */
  analysis?: Record<string, string> };

const DIVIDER = "Automatic  Checking  System ►";
const DISPLAY = ["Footnote #", "Footnote Text", "Quotes and proposition", "Citation", DIVIDER, "Corrected quote"];
const ANALYSIS = "AI analysis";
const REF_FIELDS = ["ref_kind", "ref_target_footnote_id", "ref_target_citation_part_index", "ref_target_citation_part_text",
  "ref_target_footnote_full", "ref_chain_origin_footnote_id", "ref_chain_origin_citation_part_index",
  "ref_chain_origin_citation_part_text", "ref_resolution_notes", "ref_chain_path"] as const;
const DIAGNOSTIC_COLUMNS = ["footnote_id", "footnote_internal_id", "citation_part_index", "citation_part_kind",
  "citation_part_corrected", "citation_part_link", "citation_part_anchor_text", "short_form", "bare_citation",
  "citation_with_style", "pinpoint_fragments", "page_pinpoints", "first_page", "has_quotes", "quote_count",
  "quotes_list_json", "quote_check_status", "quote_corrected_citation", "quote_check_notes", "quote_match_pinpoint",
  "quote_match_link", "matched_source", "matched_source_fragment", "alternate_matched_source_fragment",
  "journal_match_info", ...REF_FIELDS] as const;
type Row = Record<(typeof DIAGNOSTIC_COLUMNS)[number], string | number> & {
  footnote_display_id: string; footnote_full: string; proposition_text: string; citation_part_text: string;
  /** Where a quotation the cited passage holds in part is found word for word, and the quotation as written there. */
  _alternate_quote_check_notes?: string; _alternate_quote_corrected_citation?: string;
  /** The note's quotations, by their ids in the quote check. */
  _quote_ids?: string[];
  /** Said where the citation names a different case than the one the brief names. */
  citation_part_warning?: string };

/** A list as Python's json.dumps writes it. */
function pythonJson(values: ReadonlyArray<string | number>, ascii = true) {
  const text = `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  // Per UTF-16 unit, so astral characters become surrogate pairs as Python writes them.
  return ascii ? text.replace(/[^\x00-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`) : text;
}
/** Footnote numbers from "1-5, 9, 12-14"; null means every note. */
function footnoteFilter(text = "") {
  const ids = new Set<number>();
  for (const part of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [a, b] = part.includes("-") ? part.split("-", 2).map((item) => Number(item.trim())) : [Number(part), Number(part)];
    if (Number.isInteger(a) && Number.isInteger(b)) for (let id = Math.min(a, b); id <= Math.max(a, b); id++) ids.add(id);
  }
  return ids.size ? ids : null;
}

type Part = { start: number; end: number; text: string; anchors: string[] };
type Citation = { index: number; form: string; key?: string; span: { start: number; end: number }; fields?: { page?: string } };
type Fields = QuoteCitationUnit["parts"][number]["fields"];
const engine = <T>(method: string, request: unknown) => structureNative().citationEngineCall(method, JSON.stringify(request)) as T;
const usableLink = (link: string) => /^https?:\/\/[^/\s]/iu.test((link ?? "").trim());

/** A model's part of a note, at its place in the note's text (runtime/ai.ts). */
export type AlrModelPart = { start: number; end: number; fields: Omit<Fields, "status" | "link_candidate" | "reasons"> };
/** A note as the run mode decides whether the model reads it: its text and the engine's parts, with each part's
 *  reference kind, link and kind. */
export type AlrModelNote = { index: number; number: number; text: string;
  parts: Array<{ text: string; reference: string; link: string; kind: string }> };
/** An earlier part a supra may name. */
export type AlrCandidate = { note: string; shortForm: string; text: string; link: string };
/** A model run mode: the notes' parts it reads, and the earlier part each unresolved supra names. */
export type AlrModel = {
  split(notes: AlrModelNote[], signal?: AbortSignal): Promise<Map<number, AlrModelPart[]>>;
  choose(references: Array<{ text: string; earlier: AlrCandidate[]; proposition: string }>,
    signal?: AbortSignal): Promise<Array<AlrCandidate | null>>;
};

/** One row per part of every note, as the note splitter gives them at the draft's tier: prose, books, reports and web
 *  pages as well as citations. A reference stands for the authority its import resolved it to (the association
 *  Sources and the quotation check read, and a user's relinking changes): its origin is the part that last cites that
 *  authority in full before it, and its link is that origin's, reanchored to the reference's own pinpoint. With a
 *  `model` (an AI run mode), the notes it reads take its parts and fields, each placed on the note's text, and a supra
 *  the import left unresolved takes the earlier part the model names. */
export async function alrRows(draft: AuthoritiesDraft, check: Check, options: AlrWorkbookOptions = {},
  model?: AlrModel, signal?: AbortSignal, attached: ReadonlyMap<string, NativeDocument> = new Map()): Promise<Row[]> {
  const units = [...draft.units].sort((a, b) => a.ordinal - b.ordinal);
  const propositions = footnotePropositions(draft.units, options.quoteContext);
  const wanted = footnoteFilter(options.footnotes);
  // The article as one text; each note a note range, numbered as printed (unnumbered when the reader found
  // no number), anchored where its marker stands in the body.
  let text = "";
  const anchors = new Map<number, number>();
  const placed = units.map((unit) => {
    const start = text.length; text += `${unit.text}\n\n`;
    for (const [id, offset] of unit.footnoteRefs) anchors.set(id, start + offset);
    return { unit, start, end: start + unit.text.length };
  });
  const ranges = placed.filter(({ unit }) => unit.kind === "footnote" && unit.footnoteId !== null)
    .map(({ unit: note, start, end }) => ({ note, start, end }));
  const UNNUMBERED = 0xffff_ffff;
  const notes = ranges.map(({ note, start, end }) => ({ start, end,
    number: note.noteNumber === null ? UNNUMBERED : note.noteNumber ?? note.footnoteId!,
    sequence: note.noteNumber === null ? UNNUMBERED : note.restartSequence ?? 0,
    ...(anchors.has(note.footnoteId!) ? { anchor: anchors.get(note.footnoteId!) } : {}) }));
  const extracted = engine<{ citations: Citation[]; sourceParts: Part[] }>("extract", {
    text, offsetUnit: "utf16", options: { resolve: false, splitTier: draft.settings.supraLinking ?? "safe", notes } });
  const engineParts = extracted.sourceParts.map((part, source) => {
    const range = ranges.find(({ start, end }) => start <= part.start && part.end <= end);
    return { ...part, range: range!, local: part.start - (range?.start ?? 0), raw: part, source };
  }).filter((part) => part.range);
  const engineFields = engineParts.map((part) => engine<Fields>("sourceFields", { part: part.raw }));
  const kindOf = (text: string) => engine<{ kind: string; notes: string[] }>("referenceInfo", { text });
  const engineKinds = engineParts.map((part) => kindOf(part.text));
  // A full part's link: the author's own, else the source's page (CanLII for Canadian law).
  const engineLinks = engineParts.map((part, index) => engineKinds[index].kind ? "" : partLink(draft, part, engineFields[index]));
  // The notes the model reads take its parts, in place of the engine's.
  const modelParts = model ? await model.split(ranges.map(({ note, start }, index) => ({ index,
    number: note.noteNumber ?? note.footnoteId!, text: note.text, parts: engineParts.flatMap((part, at) => part.range.start !== start
      ? [] : [{ text: part.text, reference: engineKinds[at].kind, link: engineLinks[at], kind: engineFields[at].kind }]) })), signal)
    : new Map<number, AlrModelPart[]>();
  type RowPart = { start: number; end: number; text: string; range: (typeof ranges)[number]; local: number }
    & ({ at: number } | { model: AlrModelPart["fields"] });
  const rows = ranges.flatMap((range, index): RowPart[] => modelParts.get(index)?.map((part) => ({ start: range.start + part.start,
    end: range.start + part.end, text: range.note.text.slice(part.start, part.end), range, local: part.start, model: part.fields }))
    ?? engineParts.flatMap((part, at) => part.range === range ? [{ start: part.start, end: part.end, text: part.text, range,
      local: part.local, at }] : []));
  const parts = rows.map(({ start, end, text, range, local }) => ({ start, end, text, range, local }));
  const fields = rows.map((row): Fields => "at" in row ? engineFields[row.at] : { ...row.model, status: "model", reasons: [],
    // The author's own link stays with the part that holds it.
    link_candidate: engineParts.map((part, at) => part.range === row.range ? engineFields[at].link_candidate : "")
      .find((link) => usableLink(link) && row.text.includes(link.trim())) ?? "" });
  const kinds = rows.map((row) => "at" in row ? engineKinds[row.at] : kindOf(row.text));
  const links = rows.map((row, index) => "at" in row ? engineLinks[row.at]
    : kinds[index].kind ? "" : partLink(draft, row, fields[index]));
  const partAt = (offset: number) => parts.findIndex((part) => part.start <= offset && offset < part.end);
  // The draft's citations where they stand in the article.
  const unitStart = new Map(placed.map(({ unit, start }) => [unit.id, start]));
  const at = (item: AuthorityOccurrence) => unitStart.get(item.unitId)! + item.start;
  const occurrences = Object.values(draft.occurrences).filter((item) => unitStart.has(item.unitId))
    .sort((a, b) => at(a) - at(b));
  // Each part's reference: the first it holds that stands for an authority.
  const reference = parts.map((part) => occurrences.find((item) => item.kind === "reference" && item.authorityId
    && part.start <= at(item) && at(item) < part.end));
  // The part holding a citation the import stored for a reference, where it still cites the reference's authority.
  const stored = (item: AuthorityOccurrence | undefined, id: string | undefined) => {
    const cites = id ? draft.occurrences[id] : undefined;
    return cites && cites.authorityId === item!.authorityId && unitStart.has(cites.unitId) ? partAt(at(cites)) : -1;
  };
  // A reference's origin, the part its import's resolution ends at; for one the user linked, the part that last cites
  // its authority in full before it (else first does).
  const origin = reference.map((item) => {
    if (!item) return -1;
    const resolved = stored(item, item.reference?.originId);
    if (resolved >= 0) return resolved;
    const full = occurrences.filter((other) => other.authorityId === item.authorityId && other.kind !== "reference");
    const cites = full.filter((other) => at(other) < at(item)).at(-1) ?? full[0];
    return cites ? partAt(at(cites)) : -1;
  });
  // The part a reference names directly, else its origin.
  const target = reference.map((item, index) => {
    const row = item ? stored(item, item.reference?.namedId) : -1;
    return row >= 0 ? row : origin[index];
  });
  // The link an editor gave the part's citation, or one carried to it from another citation of the same authority
  // (Beaver's set-occurrence-links), where the author gave none: kept as written, a reference's included.
  const editorLinks = parts.map((part, index) => usableLink(fields[index].link_candidate) ? ""
    : partOccurrences(draft, part).map((item) => item.link ?? "").find(usableLink) ?? "");
  // The author's hyperlinks in a note, each on the first part it covers (alr_quote_verifier.py
  // _apply_author_provided_links): the part's own link, kept as written (_restore_author_provided_links) and carried
  // to its references as a link the author wrote out is; an editor's link, given since, comes first.
  const authorLinks = parts.map(() => "");
  for (const range of ranges) for (const [start, end, url] of range.note.authorLinks ?? []) {
    const at = parts.findIndex((part) => part.range === range && Math.max(part.local, start) < Math.min(part.local + part.text.length, end));
    if (at >= 0 && !authorLinks[at]) authorLinks[at] = url;
  }
  // A full part's link at its first paragraph or section pinpoint, as the Python app anchors a CanLII link; the
  // author's own link stays as written.
  const anchored = links.map((link, index) => link && !kinds[index].kind && !usableLink(fields[index].link_candidate)
    ? engine<string>("canliiPinpointUrl", { url: link, pinpoints: fields[index].pinpoint_fragments }) : link);
  const reanchor = (link: string, text: string) => engine<string>("reanchorReference", { link, text });
  // A part's paragraph and section pinpoints.
  const pinpointed = (index: number) => fields[index].pinpoint_fragments.filter((fragment) => /^(?:par|sec)/u.test(fragment));
  // A reference's link is its origin's link, at the reference's own pinpoint; an ibid without one takes the link of
  // the reference it names directly where that opens the same page, keeping its anchor. A reference the import left
  // unresolved has none. The author's and an editor's own links stay as written.
  const linked = new Map<number, string>();
  const linkOf = (index: number, depth = 0): string => {
    if (!linked.has(index)) {
      const own = editorLinks[index] || authorLinks[index];
      linked.set(index, own || !kinds[index].kind ? own || anchored[index]
        : origin[index] < 0 || origin[index] === index || depth >= 50 ? ""
          : reanchor(linkOf(linkedFrom(index, depth), depth + 1), parts[index].text));
    }
    return linked.get(index)!;
  };
  const linkedFrom = (index: number, depth = 0) => {
    const named = target[index];
    return kinds[index].kind === "ibid" && !pinpointed(index).length && named >= 0 && named !== origin[index]
      && named !== index && depth < 50 && samePage(linkOf(named, depth + 1), linkOf(origin[index], depth + 1))
      ? named : origin[index];
  };
  // The part whose pinpoint a reference's link opens at, and whose passage it shows: its own, else that of the part
  // it takes its link from.
  const pinpointedAt = (index: number, depth = 0): number => pinpointed(index).length || !kinds[index].kind
    || origin[index] < 0 || origin[index] === index || depth >= 50 ? index : pinpointedAt(linkedFrom(index), depth + 1);
  if (model) {
    // A supra the import left unresolved: the model chooses among the earlier notes' parts, as resolved so far.
    const open = parts.flatMap((_, index) => kinds[index].kind === "supra" && origin[index] < 0 ? [index] : []);
    const offered = open.map((index) => parts.slice(0, parts.findIndex((part) => part.range === parts[index].range))
      .flatMap((part, at) => kinds[at].kind && origin[at] < 0 ? [] : [{ at, candidate: { note: String(part.range.note.noteNumber
        ?? part.range.note.footnoteId), shortForm: fields[at].short_form, text: part.text, link: linkOf(at) } }]));
    const chosen = await model.choose(open.map((index, at) => ({ text: parts[index].text,
      earlier: offered[at].map(({ candidate }) => candidate),
      proposition: propositions.get(parts[index].range.note.footnoteId!)?.text ?? "" })), signal);
    open.forEach((index, at) => {
      const found = offered[at].find(({ candidate }) => candidate === chosen[at]);
      if (found) origin[index] = target[index] = found.at;
    });
    linked.clear();
  }
  const quotesOf = new Map<string, QuoteResult[]>(), checkedOn = new Map<number, Checked[]>();
  for (const quote of check.quotes) {
    const noteId = quote.candidates[0]?.unitId;
    if (noteId) quotesOf.set(noteId, [...quotesOf.get(noteId) ?? [], quote]);
    // Each citation part's row carries the quotation's check against that part's own source.
    for (const each of quote.checks) {
      const candidate = quote.candidates.find(({ id }) => id === each.candidateId);
      const range = candidate && ranges.find(({ note }) => note.id === candidate.unitId);
      const at = range && candidate ? partAt(range.start + candidate.start) : -1;
      if (at >= 0) checkedOn.set(at, [...checkedOn.get(at) ?? [], { ...each, quote: quote.quote,
        raw: quote.context.slice(Math.max(0, quote.start - 1), quote.end + 1) }]);
    }
  }
  // The source a part cites, read where its link names a paragraph or provision or it pinpoints one (a reference
  // reads the authority it stands for): the passage gives the link its text fragment, and the row its anchor text.
  const cited = (index: number, depth = 0): { kind: string; citation: string } | null => {
    // A reference reads the authority it stands for; one a model chose for, its origin's.
    const stands = reference[index]?.authorityId ? draft.authorities[reference[index]!.authorityId!] : undefined;
    if (kinds[index].kind) return stands ?? (origin[index] >= 0 && origin[index] !== index && depth < 50
      ? cited(origin[index], depth + 1) : null);
    const authority = partAuthority(draft, parts[index]), field = fields[index];
    if (authority) return authority;
    const kind = field.kind === "case" ? "case" : ["statute", "regulation", "gazette"].includes(field.kind) ? "legislation" : "";
    return kind ? { kind, citation: field.citation_with_style || field.bare_citation } : null;
  };
  const read = options.a2aj === false ? null : citedSourceReader({ ...legalSourceOperations,
    resolve: (request) => legalSourceOperations.resolve({ ...request, providers: ["a2aj"], discoverPdf: false }),
    readPassage: (request) => legalSourceOperations.readPassage({ ...request, discoverPdf: false }) }, signal);
  // The quotation found in a decision's or statute's A2AJ text, whose link this app makes (quoteLink).
  const a2ajFound = (index: number) => (checkedOn.get(index) ?? []).find((quote) => quote.receipt?.link
    && quote.receipt.match.location !== "unmatched" && quote.receipt.source.provider === "a2aj");
  const read_ = await Promise.all(parts.map(async (_, index)
    : Promise<{ document: NativeDocument; source?: LegalSourceReference } | null> => {
    const source = /#(?:par|sec)/u.test(linkOf(index)) || pinpointed(index).length || a2ajFound(index) ? cited(index) : null;
    // A PDF attached for the authority (a CanLII download, a file from the watched folder) is read as its source.
    const own = source && "id" in source ? attached.get(String(source.id)) : undefined;
    if (own) return { document: own };
    const found = source && read ? await read(source) : null;
    return found && !found.missing ? { document: found.document, source: found.source } : null;
  }));
  const documents = read_.map((found) => found?.document ?? null);
  // A passage of an A2AJ source is linked where the engine routes it best: the publisher's page where it prints an
  // anchor for the passage, else CanLII's (legal-structure source_links). Cited without a quotation, it is linked at
  // the citation's pinpoints, its paragraph or provision painted as a citation's pinpoint is.
  const routed = async (index: number, locator: { kind: string; label: string } | null, blockText: string,
    quotes: string[], pinpoints: string[] = []) => {
    const found = read_[index], source = found?.source;
    if (!found || !source || source.provider !== "a2aj" || !source.citation || !blockText && !pinpoints.length) return null;
    const links = await structureNative().offThread("sourceLinks", found.document, {
      ...source.url && { url: source.url }, dataset: source.collection ?? "", citation: source.citation,
      alternateCitation: source.alternateCitation ?? null, language: source.language ?? "en",
      docType: source.kind === "legislation" ? "laws" : "cases", locator, blockText, quotes, pinpoints });
    return links.best;
  };
  const locatorOf = (pinpoint: string) => pinpoint.startsWith("par") ? { kind: "paragraph" as const, label: pinpoint }
    : pinpoint.startsWith("sec") ? { kind: "section" as const, label: pinpoint.slice(3) } : null;
  const blockOf = (index: number, pinpoint: string) => {
    const locator = locatorOf(pinpoint), document = documents[index];
    return locator && document ? structureNative().readDocumentRange(document, locator.kind,
      locator.kind === "paragraph" ? pinpoint.slice(3) : locator.label, locator.kind === "paragraph"
        ? pinpoint.slice(3) : locator.label, 0)?.selected[0]?.text.trim() ?? "" : "";
  };
  // A link this app makes: its anchor given its passage's text fragment where the passage can be read,
  // then as the text fragments option keeps it. The author's and the editor's own links stay as written.
  const own = (index: number) => !!editorLinks[index] || !!authorLinks[index] || (!kinds[index].kind && usableLink(fields[index].link_candidate));
  const fragments = options.textFragments ?? "all";
  const keepsFragment = (index: number) => own(index) || fragments === "all"
    || (fragments === "pinpointless" && !pinpointed(index).length);
  // A passage's link at the part the citation pinpoints (a reference without a pinpoint of its own, that of the part
  // it takes its link from, as its anchor text shows), made once for the parts that cite it; every link is planned at
  // once, off this thread.
  const passageLinks = new Map<NativeDocument | null, Map<string, Promise<string>>>();
  const passageLink = async (link: string, document: NativeDocument | null, index: number) => {
    const pinpoints = pinpointed(pinpointedAt(index));
    let made = passageLinks.get(document);
    if (!made) passageLinks.set(document, made = new Map());
    const key = JSON.stringify([link, pinpoints]);
    let found = made.get(key);
    // At the link's own anchor ("sec6subsec1" for "s 6(1)(c)"), else the pinpoint's.
    const pinpoint = pinpoints[0], anchor = /#((?:par|sec)[^:&#?]*)/u.exec(link)?.[1] ?? pinpoint;
    if (found === undefined) made.set(key, found = (pinpoint && read_[index]?.source
      ? routed(index, locatorOf(anchor), blockOf(index, pinpoint), [], pinpoints)
      : citedPassageLink(link, document, pinpoints)).then((made) => made ?? link));
    return found;
  };
  const partLinks = await Promise.all(parts.map(async (_, index) => {
    const link = pdfToPage(linkOf(index));
    if (own(index)) return link;
    const passage = /#(?:par|sec)/u.test(link) || read_[index]?.source && pinpointed(pinpointedAt(index)).length
      ? await passageLink(link, documents[index], index) : link;
    return keepsFragment(index) ? passage : withoutFragment(passage);
  }));
  // A quotation's link: the passage's routed link with the quoted words' text fragment, where the quotation was found
  // in the A2AJ text of the source this part cites.
  const quoteLink = async (index: number, link: string) => {
    const found = a2ajFound(index), receipt = found?.receipt, document = documents[index];
    if (!receipt || receipt.link !== link || !document || structureNative().documentRevision(document) !== receipt.sourceSha256)
      return link;
    const label = receipt.match.labels[0] ?? "";
    return await routed(index, locatorOf(label), receipt.match.text, [receipt.match.fragment || found!.quote]) ?? link;
  };
  const passages = parts.map((_, index) => documents[index] ? pinpointed(index).flatMap((fragment) => {
    const [, kind, value] = /^(par|sec)(.+)$/u.exec(fragment)!;
    const block = structureNative().readDocumentRange(documents[index]!, kind === "par" ? "paragraph" : "section",
      value, value, 0)?.selected[0];
    return block?.text.trim() ? [block.text.trim()] : [];
  }).join(" ") : "");
  const indexInNote = parts.map((part) => parts.filter((other) => other.range === part.range && other.start < part.start).length);
  // A reference's chain, hop by hop, and the Python app's notes on it.
  const hop = (index: number) => kinds[index].kind !== "supra" ? kinds[index].kind.toUpperCase()
    : `SUPRA→${parts[target[index]].range.note.noteNumber ?? parts[target[index]].range.note.footnoteId}:${indexInNote[target[index]] + 1}`;
  const chainPath = (index: number, depth = 0): string => {
    if (!kinds[index].kind || target[index] < 0 || target[index] === index) return "";
    const rest = kinds[target[index]].kind && depth < 50 ? chainPath(target[index], depth + 1) : "";
    return rest ? `${hop(index)} → ${rest}` : hop(index);
  };
  const partsOf = (note: AuthoritiesDraft["units"][number]) => parts.filter((part) => part.range.note === note).length;
  const resolutionNotes = (index: number) => {
    const kind = kinds[index].kind, previous = parts[index - 1], notes: string[] = [];
    // An ibid after a note of several parts, whichever it names.
    if (kind === "ibid" && previous && previous.range !== parts[index].range && partsOf(previous.range.note) > 1)
      notes.push("Previous footnote has multiple references; style guidance prefers supra over ibid in this situation.");
    if (kind === "ibid" && !previous) notes.push("Ibid appears as the first reference; no preceding reference exists.");
    const named = kinds[index].notes[0], note = named ? ranges.find(({ note }) => String(note.noteNumber) === named)?.note : undefined;
    if (kind === "supra" && origin[index] < 0 && named)
      notes.push(!note ? `Supra target footnote (note ${named}) not found in this DOCX.`
        : partsOf(note) > 1 ? "Supra target footnote has multiple references; could not infer intended citation-part." : "");
    return notes.filter(Boolean).join(" ");
  };
  // A full part's first page: its first citation's, as a reporter or journal gives it.
  const firstPage = (index: number) => {
    const page = kinds[index].kind ? undefined : extracted.citations.find((citation) => citation.form === "full" &&
      citation.fields?.page && parts[index].start <= citation.span.start && citation.span.end <= parts[index].end)?.fields?.page;
    return typeof page === "string" ? page : (page as { text?: string } | undefined)?.text ?? "";
  };
  // Every quotation's routed link, planned at once off this thread.
  const quoteLinks = await Promise.all(parts.map((_, index) =>
    quoteLink(index, quoteFields(checkedOn.get(index) ?? []).quote_match_link)));
  return parts.flatMap((part, index): Row[] => {
    const note = part.range.note, number = note.noteNumber ?? note.footnoteId!;
    if (wanted && !wanted.has(number)) return [];
    const quotes = quotesOf.get(note.id) ?? [], field = fields[index];
    const checked = quoteFields(checkedOn.get(index) ?? []);
    const at = (other: number) => other >= 0 ? parts[other] : undefined;
    const tgt = kinds[index].kind ? at(target[index]) : undefined, org = kinds[index].kind ? at(origin[index]) : undefined;
    const authority = partAuthority(draft, org ?? part), mismatch = authority?.citedCase;
    const warning = mismatch && !draft.discrepancyDecisions?.[mismatch.id]
      ? "Citation names a different case: " + mismatch.name + " (" + mismatch.citation + ")." : "";
    const hint = kinds[index].kind === "supra" ? engine<string>("supraHint", { text: part.text, aggressive: true }) : "";
    return [{
      footnote_id: note.footnoteId!, footnote_internal_id: note.footnoteId!, footnote_display_id: note.noteNumber === null && note.noteMark ? note.noteMark : String(number),
      footnote_full: note.text.trim(), proposition_text: propositions.get(note.footnoteId!)?.text ?? "",
      citation_part_index: indexInNote[index] + 1, citation_part_kind: field.kind, citation_part_text: part.text,
      citation_part_corrected: field.corrected, citation_part_link: partLinks[index],
      ...warning && { citation_part_warning: warning },
      // A reference without a pinpoint of its own shows the passage of the part it takes its link from.
      citation_part_anchor_text: passages[pinpointedAt(index)],
      short_form: field.short_form, bare_citation: field.bare_citation,
      citation_with_style: field.citation_with_style, pinpoint_fragments: pythonJson(field.pinpoint_fragments),
      page_pinpoints: pythonJson(field.page_pinpoints.map(Number)), first_page: firstPage(index),
      has_quotes: quotes.length ? "YES" : "NO", quote_count: quotes.length,
      quotes_list_json: pythonJson(quotes.map(({ quote }) => quote.trim()), false), _quote_ids: quotes.map(({ id }) => id),
      ...checked, quote_match_link: (keepsFragment(index) ? (link: string) => link : withoutFragment)(
        quoteLinks[index]),
      journal_match_info: "",
      ref_kind: kinds[index].kind.toUpperCase(),
      ref_target_footnote_id: tgt ? String(tgt.range.note.footnoteId) : "",
      ref_target_citation_part_index: tgt ? indexInNote[target[index]] + 1 : "",
      ref_target_citation_part_text: tgt ? (hint ? `${hint}, ${tgt.text}` : tgt.text) : "",
      ref_target_footnote_full: tgt?.range.note.text.trim() ?? "",
      ref_chain_origin_footnote_id: org ? String(org.range.note.footnoteId) : "",
      ref_chain_origin_citation_part_index: org ? indexInNote[origin[index]] + 1 : "",
      ref_chain_origin_citation_part_text: org?.text ?? "", ref_resolution_notes: resolutionNotes(index),
      ref_chain_path: chainPath(index),
    }];
  });
}

type PlacedPart = { range: { note: AuthoritiesDraft["units"][number] }; local: number; start: number; end: number };
/** The citations Authorities found in a part: those starting in it. */
function partOccurrences(draft: AuthoritiesDraft, part: PlacedPart) {
  const note = part.range.note, length = part.end - part.start;
  return note.occurrenceIds.map((id) => draft.occurrences[id])
    .filter((item) => item && item.start >= part.local && item.start < part.local + length);
}
/** The authority Authorities found in a part: the one an occurrence starting in it names. */
function partAuthority(draft: AuthoritiesDraft, part: PlacedPart) {
  return partOccurrences(draft, part).filter((item) => item.authorityId)
    .map((item) => draft.authorities[item.authorityId!]).find(Boolean);
}
/** A CanLII PDF link as its page, anchor kept, unless it names a PDF page: paragraph and section anchors are the page's
 *  (alr_quote_verifier.py _canlii_pdf_to_html_sibling, applied to every part's link). */
const pdfToPage = (link: string) => engine<string>("canliiPdfPage", { url: link });

/** A link without its text fragment; its paragraph, section or page anchor stays. */
const withoutFragment = (link: string) => link.replace(/#?:~:text=.*$/u, "");

/** Whether two links open one page, whatever their anchors (pageIdentity). */
function samePage(a: string, b: string) {
  const [x, y] = [a, b].map((link) => pageIdentity(pdfToPage(link)));
  return x.site === y.site && x.page === y.page;
}

/** A link's site (its host, with or without "www.") and the document page it opens there, whatever its scheme, query or
 *  fragment: a CanLII statute's or regulation's by its jurisdiction and citation, at any version and as consolidated
 *  or annual. */
function pageIdentity(value: string) {
  try {
    const url = new URL(value), site = url.hostname.toLowerCase().replace(/^www\./u, "");
    const law = engine<{ jurisdiction: string; id: string } | null>("canliiLawPage", { url: value });
    return { site, page: law ? `${law.jurisdiction}/laws/${law.id}` : url.pathname };
  } catch {
    return { site: "", page: value };
  }
}

/** A part's link: the author's own (unless `own` is false); else its source's page: CanLII for a Canadian decision or
 *  statute A2AJ identifies or its citation names, an article's PDF at its cited page, another provider's page.
 *  Its paragraph or section anchor is added after, as the Python app adds it (the engine's canliiPinpointUrl). */
function partLink(draft: AuthoritiesDraft, part: PlacedPart, field: Fields, own = true) {
  // The web address the part writes, with or without its scheme ("online: <example.org>").
  const address = withScheme(field.link_candidate.trim());
  if (own && typeof address === "string" && usableLink(address)) return address;
  const authority = partAuthority(draft, part);
  const identity = authority?.sourceIdentity;
  if (identity?.provider === "journal") {
    const page = field.page_pinpoints.length
      ? journalLegalSourceProvider.pageLink(identity.stableSourceId, String(field.page_pinpoints[0])) : null;
    return page ?? identity.externalUrl ?? "";
  }
  if (authority && identity?.provider === "a2aj") {
    const [, language, dataset] = identity.stableSourceId.split(":");
    const lang = language === "fr" ? "fr" : "en";
    const canlii = authority.kind === "legislation"
      ? structureNative().canliiLawUrl(authority.citation, lang, true)
      : structureNative().canliiCaseUrl([authority.citation, ...identity.citationForms ?? []], lang, dataset);
    if (canlii) return canlii;
  }
  const written = field.citation_with_style || field.bare_citation;
  const fallback = ["statute", "regulation", "gazette"].includes(field.kind) ? structureNative().canliiLawUrl(written)
    : structureNative().canliiCaseUrl([written], "en", null);
  if (fallback) return fallback;
  // A decision's page from a supplied private CanLII index, where the host has one, before another provider's page: a
  // Supreme Court decision goes on CanLII rather than the Court's own site.
  const indexed = !["statute", "regulation", "gazette"].includes(field.kind) ? indexedCaseUrl(written, field.pinpoint_fragments[0]) : null;
  if (indexed) return indexed;
  // Another provider's page, as every legal link is written (a court website's with the parameters its viewer needs).
  const page = authority ? authoritySourceUrl(authority) : null;
  return page ? sourceUrl(page) ?? "" : "";
}

/** A part's quotation result, in the Python app's statuses. */
type Checked = QuoteCheck & { quote: string; raw: string };
/** A quotation in the quotation marks the article set it in, as the desktop app writes it. */
const quoted = (text: string, quote: Checked) => withOuterQuotes(text, ...outerQuoteMarks(quote.raw));
const supported = (quote: QuoteCheck) => quote.status === "verified" && !!quote.receipt?.comparison;
function quoteFields(quotes: Checked[]) {
  const empty = { quote_check_status: "", quote_corrected_citation: "", quote_check_notes: "", quote_match_pinpoint: "",
    quote_match_link: "", matched_source: "", matched_source_fragment: "", alternate_matched_source_fragment: "" };
  if (!quotes.length) return empty;
  const found = quotes.filter((quote) => quote.receipt && quote.receipt.match.location !== "unmatched");
  if (!found.length) {
    const read = quotes.some((quote) => quote.receipt);
    const short = quotes.some((quote) => quote.receipt?.match.shortInLong);
    return { ...empty, quote_check_status: "NO_MATCH", quote_corrected_citation: quotes.map((quote) => quoted(quote.quote, quote)).join("\n\n"),
      quote_check_notes: !read ? "No source text found for this citation." : short
        ? "Quote too short for full-document fuzzy checking in a long source; exact search found no match."
        : "Quote not found in source text." };
  }
  const matches = found.map((quote) => quote.receipt!.match);
  const family = found.some((quote) => quote.receipt!.source.provider === "attached") ? "CANLII" : "A2AJ";
  // A PDF attached for a decision stands where the Python app read CanLII's page: a quotation the cited passage
  // holds only in part (under 0.90) and another holds word for word is a partial match at the pinpoint, the
  // perfect match elsewhere given beside it.
  if (family === "CANLII" && found.length === quotes.length && found.every(supported) && matches.every((match) =>
    match.location.startsWith("alternate") && match.perfect && match.cited && match.cited.score < 0.9)) {
    const cited = matches.map((match) => match.cited!);
    return { ...empty, quote_check_status: "OG_PINPOINT_PARTIAL",
      quote_corrected_citation: cited.map(({ corrected }, index) => quoted(corrected, found[index])).join("\n\n"),
      quote_match_pinpoint: pinpointSummary([...new Set(cited.flatMap(({ labels }) => labels))]),
      quote_match_link: found.map((quote) => quote.receipt!.link).find(Boolean) ?? "",
      matched_source: cited.map(({ region }) => region.replace(/\n/gu, " ")).filter(Boolean).join("\n\n"),
      matched_source_fragment: cited.map(({ fragment }) => fragment).filter(Boolean).join("\n\n"),
      alternate_matched_source_fragment: matches.map((match) => match.fragment).filter(Boolean).join("\n\n"),
      _alternate_quote_check_notes: pinpointSummary([...new Set(matches.flatMap((match) => match.labels))]),
      _alternate_quote_corrected_citation: found.map((quote) => quoted(quote.quote, quote)).join("\n\n") };
  }
  const accepted = found.length === quotes.length && found.every(supported);
  const alternate = matches.filter((match) => match.location.startsWith("alternate"));
  const pinpoint = pinpointSummary([...new Set((alternate.length ? alternate : matches).flatMap((match) =>
    match.labels.length ? match.labels : match.pinpoint ? [match.pinpoint] : []))]);
  const level = accepted && alternate.length === matches.length ? "MATCH" : "PARTIAL";
  const limited = matches.some((match) => match.location.startsWith("scope_unavailable") || match.location === "cited_parent");
  return { ...empty,
    quote_check_status: alternate.length ? `ALT_PINPOINT${pinpoint ? "" : "LESS"}_${level}_${family}`
      : accepted && !limited ? "OG_PINPOINT_MATCH" : "OG_PINPOINT_PARTIAL",
    quote_check_notes: [alternate.length ? pinpoint
      : limited ? "The cited pinpoint could not be isolated in the available source structure." : "",
      quotes.some((quote) => !quote.receipt) ? "No source text was found for one or more quotations." : "",
      quotes.some((quote) => quote.receipt?.match.location === "unmatched") ? "One or more quotations were not found in the source text." : "",
      quotes.some((quote) => quote.receipt && !quote.receipt.comparison) ? "One or more quotations have not been compared with the source wording." : ""
    ].filter(Boolean).join(" "),
    quote_corrected_citation: quotes.map((quote) => quoted(quote.receipt?.comparison && quote.receipt.match.location !== "unmatched"
      && !supported(quote) ? quote.receipt.match.corrected : quote.quote, quote)).join("\n\n"),
    quote_match_pinpoint: pinpoint,
    quote_match_link: found.map((quote) => quote.receipt!.link).find(Boolean) ?? "",
    matched_source: matches.map((match) => match.region.replace(/\n/gu, " ")).filter(Boolean).join("\n\n"),
    matched_source_fragment: matches.map((match) => match.fragment).filter(Boolean).join("\n\n") };
}

const usable = (link: string) => /^https?:\/\/[^/\s]/iu.test(link.trim());
const compactPinpoint = (summary: string) => summary.replace(/\s*\[\+(\d+)\s+more instances\]/gu, " +$1 more").trim();
function statusPrefix(row: Row) {
  const status = String(row.quote_check_status), pinpoint = compactPinpoint(String(row.quote_match_pinpoint));
  const at = !pinpoint || /unknown/iu.test(pinpoint) ? " at [unknown]" : ` at ${pinpoint}`;
  if (status === "OG_PINPOINT_MATCH" || /^ALT_PINPOINT(LESS)?_MATCH_/u.test(status)) return `✓Perfect Match${at}✓`;
  const alternate = compactPinpoint(row._alternate_quote_check_notes ?? "");
  if (status === "OG_PINPOINT_PARTIAL") return `~Partial Match${at}~${alternate ? ` - ✓Perfect Match found at: ${alternate}✓` : ""}`;
  if (/^ALT_PINPOINT(LESS)?_PARTIAL_/u.test(status)) return `~Partial Match${at}~`;
  if (status !== "NO_MATCH" || !usable(String(row.citation_part_link))) return "";
  const notes = String(row.quote_check_notes);
  return notes.includes("too short for full-document fuzzy checking") ? "❌Short quote in long source; exact search found no match❌"
    : notes.includes("No source text found") ? "❌Unable to grab source text❌" : "❌No match found❌";
}
function correctedDisplay(row: Row) {
  const prefix = row.has_quotes === "YES" ? statusPrefix(row) : "";
  if (!prefix || prefix.startsWith("❌")) return prefix;
  const body = String(row.quote_corrected_citation).trim(), alternate = (row._alternate_quote_check_notes ?? "").trim();
  const notes = String(row.quote_check_notes).trim(), location = /^ALT_/u.test(String(row.quote_check_status)) ? String(row.quote_match_pinpoint).trim() : "";
  const warning = location && notes.startsWith(location) ? notes.slice(location.length).trim() : notes;
  if (row.quote_check_status !== "OG_PINPOINT_PARTIAL" || !alternate) return [prefix, body, warning].filter(Boolean).join("\n").trim();
  // A partial match at the pinpoint, then where the quotation is found word for word.
  const alternateBody = (row._alternate_quote_corrected_citation ?? "").trim();
  return [prefix.split(" - ")[0].replace(/^~|~$/gu, "").replace(/Match/gu, "match"), ...body ? [body] : [], "",
    `Perfect match found at ${compactPinpoint(alternate)}`, ...alternateBody ? [alternateBody] : []].join("\n").trim();
}
/** The quotations in a proposition, bold in the colour of the row's note number. */
function quoteRuns(text: string, quotes: string[], odd: boolean): XlsxRun[] | undefined {
  const spans: Array<[number, number]> = [];
  for (const quote of quotes.map((value) => value.trim()).filter(Boolean))
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + quote.length)) spans.push([at, at + quote.length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const runs: XlsxRun[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    if (cursor < start) runs.push({ text: text.slice(cursor, start), font: runFont() });
    runs.push({ text: text.slice(start, end), font: runFont(odd ? "FF0B5394" : "FFFF9000", "<b/>") });
    cursor = end;
  }
  if (runs.length && cursor < text.length) runs.push({ text: text.slice(cursor), font: runFont() });
  return runs.length ? runs : undefined;
}
/** A partial match beside a perfect one found elsewhere: plain, then the perfect match as the cell's link. */
function alternateRuns(text: string): XlsxRun[] | undefined {
  const at = text.indexOf("Perfect match found at");
  return at > 0 && text.includes("Partial match at") ? [{ text: text.slice(0, at), font: runFont("FF000000") },
    { text: text.slice(at), font: runFont("FF0000FF", "", "<u/>") }] : undefined;
}
/** A run's font within a cell: the cells' Calibri 13 pt, so no run falls back to a viewer's own font (each element in
 *  the order Excel reads them). */
const runFont = (color = "", bold = "", underline = "") =>
  `<rFont val="Calibri"/><family val="2"/>${bold}${color ? `<color rgb="${color}"/>` : '<color theme="1"/>'}<sz val="13"/>${underline}`;

// The desktop app's workbook fonts (its styles.xml): Calibri throughout, 13 pt but for the default, opaque colours, each
// element in the order Excel reads it.
const CALIBRI = '<name val="Calibri"/><family val="2"/>';
const FONTS = [`<font><sz val="11"/><color theme="1"/>${CALIBRI}<scheme val="minor"/></font>`,
  `<font><sz val="13"/><color theme="1"/>${CALIBRI}<scheme val="minor"/></font>`, `<font><b/><sz val="13"/><color rgb="FFFFFFFF"/>${CALIBRI}</font>`,
  `<font><u/><sz val="13"/><color rgb="FF0000FF"/>${CALIBRI}</font>`, `<font><sz val="13"/><color rgb="FFFFFFFF"/>${CALIBRI}</font>`,
  `<font><sz val="13"/><color rgb="FF000000"/>${CALIBRI}</font>`];
const FILLS = ["0C343D", "FF9000", "F3F3F3", "FFC7CE", "C3C3C3", "C6EFCE"];
const fill = (color: string) => FILLS.indexOf(color) + 2;
const TOP = '<alignment vertical="top" wrapText="1"/>', CENTER = '<alignment horizontal="center" vertical="center"/>';
const XF = (font: number, fillId: number, alignment: string) =>
  `<xf numFmtId="0" fontId="${font}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1"${fillId ? ' applyFill="1"' : ""} applyAlignment="1">${alignment}</xf>`;
const S = { body: 1, light: 2, link: 3, linkLight: 4, oddNumber: 5, evenNumber: 6, divider: 7, red: 8, grey: 9, green: 10, header: 11 } as const;
const STYLES: XlsxStyles = { fonts: FONTS, fills: FILLS, cellXfs: ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0"/>',
  XF(1, 0, TOP), XF(1, fill("F3F3F3"), TOP), XF(3, 0, TOP), XF(3, fill("F3F3F3"), TOP), XF(4, fill("0C343D"), CENTER),
  XF(5, fill("FF9000"), CENTER), XF(2, fill("0C343D"), CENTER), XF(1, fill("FFC7CE"), TOP), XF(1, fill("C3C3C3"), TOP),
  XF(1, fill("C6EFCE"), TOP), XF(2, fill("0C343D"), '<alignment horizontal="center" vertical="center" wrapText="1"/>')] };
const WIDTHS: Record<string, number> = { "Footnote #": 12, "Footnote Text": 60, "Quotes and proposition": 70, Citation: 60,
  [DIVIDER]: 12, "Corrected quote": 55, [ANALYSIS]: 55, citation_part_anchor_text: 80, ref_chain_origin_citation_part_text: 80 };

async function sheet(rows: Row[], exportDetail: AlrExportDetail, identifier = "", analysis?: Record<string, string>) {
  const diagnostics = exportDetail === "display" || exportDetail === "display-json" ? [] : [...DIAGNOSTIC_COLUMNS];
  const display = analysis ? [...DISPLAY, ANALYSIS] : DISPLAY;
  const header = rows.length ? [...display, ...diagnostics] : ["(no rows)"];
  let previousNote = "", previousProposition = "";
  const cells = rows.map((row): XlsxCell[] => {
    const odd = Number(row.footnote_internal_id) % 2 === 1, plain = odd ? S.body : S.light;
    const link = String(row.citation_part_link).trim(), linked = usable(link);
    const warning = String(row.citation_part_warning ?? "");
    const citation = (row.citation_part_text || link) + (warning ? "\n" + warning : "");
    // A note's text and proposition appear once, on its first part's row.
    const note = previousNote === row.footnote_full ? "" : row.footnote_full;
    const proposition = previousProposition === row.proposition_text ? "" : row.proposition_text;
    previousNote = row.footnote_full; previousProposition = row.proposition_text;
    const corrected = correctedDisplay(row), statusLinked = linked && corrected && !corrected.startsWith("❌");
    const quoteLink = usable(String(row.quote_match_link)) ? String(row.quote_match_link) : link;
    const alternate = row.quote_check_status === "OG_PINPOINT_PARTIAL" ? alternateRuns(corrected) : undefined;
    return [{ value: row.footnote_display_id, style: odd ? S.oddNumber : S.evenNumber }, { value: note, style: plain },
      { value: proposition, style: plain, runs: quoteRuns(proposition, JSON.parse(String(row.quotes_list_json)) as string[], odd) },
      linked ? { value: citation, link, style: warning ? S.red : odd ? S.link : S.linkLight }
        : { value: citation, style: warning ? S.red : plain },
      { value: "", style: S.divider },
      statusLinked ? { value: corrected, link: quoteLink, ...alternate ? { runs: alternate, style: plain }
        : { style: odd ? S.link : S.linkLight } } : { value: corrected, style: plain },
      // A note's analysis, separate from the mechanical findings, appears once with its proposition.
      ...analysis ? [{ value: proposition ? (row._quote_ids ?? []).flatMap((id) => analysis[id] ? [analysis[id]] : [])
        .join("\n\n") : "", style: plain }] : [],
      ...diagnostics.map((name): XlsxCell => {
        const value = row[name], status = name === "quote_check_status" ? String(value) : "";
        return { value: typeof value === "number" ? value : String(value ?? ""),
          style: status.startsWith("ALT_") || status.startsWith("OG_PINPOINT") ? S.green : status === "NO_MATCH" ? S.red
            : name === "ref_kind" && (value === "IBID" || value === "SUPRA") ? S.grey : S.body };
      })];
  });
  return styledXlsx("FootnoteReferences", [{ name: "FootnoteReferences", widths: header.map((name) => WIDTHS[name] ?? 15),
    hiddenFrom: exportDetail === "diagnostic-hidden" && diagnostics.length ? display.length + 1 : null, hideUnused: true,
    frozenHeader: true, rows: [header.map((value) => ({ value, style: S.header })), ...cells] }], STYLES, identifier);
}

/** "[CHECKED] <stem>.xlsx", and for display-json the diagnostics file paired with it by signature; `references`, how many
 *  of its rows are an ibid or a supra and how many of those are linked to their source; and the rows. `progress` hears
 *  each step. */
export async function alrCheckedWorkbook(filename: string, draft: AuthoritiesDraft, check: Check, options: AlrWorkbookOptions = {},
  model?: AlrModel, signal?: AbortSignal, attached?: ReadonlyMap<string, NativeDocument>, progress?: (message: string) => void) {
  progress?.("Connecting ibid and supra references");
  const rows = await alrRows(draft, check, options, model, signal, attached), exportDetail = options.exportDetail ?? "diagnostic-hidden";
  const name = `[CHECKED] ${filename.replace(/\.[^.]+$/u, "")}.xlsx`;
  const kind = (value: string) => rows.filter((row) => row.ref_kind === value);
  const references = { ibid: kind("IBID").length, supra: kind("SUPRA").length,
    linked: [...kind("IBID"), ...kind("SUPRA")].filter((row) => row.citation_part_link).length };
  progress?.("Writing the workbook");
  if (options.analysis) for (const id of Object.keys(options.analysis)) if (!check.quotes.some((quote) => quote.id === id))
    throw new ApplicationError(400, "Explanations must refer to quotation IDs in this check.");
  if (exportDetail !== "display-json") return { name, workbook: await sheet(rows, exportDetail, "", options.analysis), sidecar: null, references, rows };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    ["alr-sidecar-v1", name, String(rows.length), `${Date.now()}${performance.now()}`].join("|"))));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 20);
  return { name, workbook: await sheet(rows, exportDetail, `alr-sidecar:${signature}`, options.analysis), sidecar: {
    name: name.replace(/\.xlsx$/iu, ".diagnostics.json"), value: { schema: "alr_quote_verifier_diagnostics_v1",
      xlsx_file: name, xlsx_signature: signature, exported_at: new Date().toISOString().slice(0, 19), footnote_rows: rows } }, references, rows };
}
