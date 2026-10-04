// Citation parts per footnote and their links, in ALR's three phases: split each note in order with
// the citation history before it, resolve ibid/supra links against that history, then build rows.
// Ported from alr_quote_verifier.py build_footnote_parts, _deterministic_footnote_parts,
// _prefilter_pure_ref_parts, _pref_allow_leading_ibid, _snap_verbatim_parts,
// _apply_author_provided_links, _resolve_footnote_reference_links, _drop_unresolved_supra_links,
// _ref_disambig_candidates/_choose and _pinpoints_for_source_kind.
import type { AlrDocument, AuthorLink } from "./document";
import { bareCitation, engine, reanchor, refKind, supraHint, fallbackSupraHint, referenceInfo, supraNoteNumber,
  type SourceFields, type SplitPart } from "./engine";
import type { Linker } from "./links";
import type { AlrLlm, LlmSplitter } from "./llm";
import type { AlrSettings } from "./settings";
import { isUsableLink, splitUrl } from "./urls";

export type FootnotePart = {
  verbatim: string; corrected: string; kind: string; link: string;
  pinpointFragments: string[]; pagePinpoints: number[]; bareCitation: string; citationWithStyle: string;
  shortForm: string; authorProvidedLink: string; authorProvidedLinks: string[]; preProviderLink: string | null;
};
export type RegistryEntry = { verbatim: string; link: string; short_form: string; note: string };
type InferredForm = { short_form: string; short_form_norm: string; rule: string; link: string; note: string; origin: string };

/** Only pinpoint forms that can belong to the source type survive. */
export function pinpointsForKind(kind: string, fragments: readonly string[], pages: ReadonlyArray<number | string>) {
  const source = (kind ?? "").trim().toLowerCase();
  const caseSource = source === "case" || source === "unreported";
  const lawSource = ["statute", "regulation", "legislation"].includes(source);
  const paragraph = String.raw`par\d{1,4}`, section = String.raw`sec\d{1,8}(?:[.-]\d{1,8}){0,3}(?:\([^)]+\))*`;
  const pattern = caseSource ? paragraph : lawSource ? section : source === "" || source === "other"
    ? `(?:${paragraph}|${section})` : "";
  const matcher = pattern ? new RegExp(`^(?:${pattern})$`, "iu") : null;
  const kept = fragments.map((value) => String(value ?? "").trim()).filter((value) => matcher?.test(value.replace(/^#+/u, "")));
  const keptPages: number[] = [];
  if (!lawSource) for (const page of pages) {
    const number = Number(page);
    if (Number.isInteger(number) && number > 0 && !keptPages.includes(number)) keptPages.push(number);
  }
  return { fragments: kept, pages: keptPages };
}

/** Re-aligns each part's text to the exact note substring; a comma right after a part joins it. */
export function snapVerbatims(note: string, parts: FootnotePart[]): FootnotePart[] {
  if (!note || !parts.length) return parts;
  const fold: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-" };
  const normalize = (text: string) => {
    let out = "", previousSpace = true;
    const map: number[] = [];
    for (let index = 0; index < text.length; index++) {
      const ch = text[index];
      if (/\s/u.test(ch)) { if (previousSpace) continue; out += " "; map.push(index); previousSpace = true; }
      else { out += (fold[ch] ?? ch).toLowerCase(); map.push(index); previousSpace = false; }
    }
    while (out.endsWith(" ")) { out = out.slice(0, -1); map.pop(); }
    return { out, map };
  };
  const whole = normalize(note), spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const part of parts) {
    const value = normalize(part.verbatim ?? "").out.trim();
    if (!value) return parts;
    let at = whole.out.indexOf(value, cursor);
    if (at < 0) at = whole.out.indexOf(value);
    if (at < 0) return parts;
    spans.push([at, at + value.length]);
    cursor = Math.max(cursor, at);
  }
  for (let i = 0; i < spans.length - 1; i++) if (spans[i][1] > spans[i + 1][0]) {
    spans[i][1] = spans[i + 1][0];
    if (spans[i][1] <= spans[i][0]) return parts;
  }
  for (const span of spans) while (span[1] < whole.out.length && whole.out[span[1]] === ",") span[1]++;
  return parts.map((part, index) => {
    const [a, b] = spans[index];
    const snapped = note.slice(whole.map[a], whole.map[b - 1] + 1).trim();
    return snapped === part.verbatim ? part : { ...part, verbatim: snapped };
  });
}

/** An author's hyperlink belongs to the part whose text it falls in; it becomes that part's link. */
export async function applyAuthorLinks(note: string, parts: FootnotePart[], links: AuthorLink[] | undefined, linker: Linker) {
  if (!note || !parts.length || !links?.length) return parts;
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const part of parts) {
    let start = note.indexOf(part.verbatim, cursor);
    if (start < 0) start = note.indexOf(part.verbatim);
    if (start < 0) { spans.push([-1, -1]); continue; }
    spans.push([start, start + part.verbatim.length]); cursor = start + part.verbatim.length;
  }
  const targets = new Map<number, string[]>();
  for (const link of links) {
    const target = (link.target ?? "").trim();
    if (!target) continue;
    const index = spans.findIndex(([start, end]) => start >= 0 && Math.max(start, link.start) < Math.min(end, link.end));
    if (index < 0) continue;
    const bucket = targets.get(index) ?? [];
    if (!bucket.includes(target)) bucket.push(target);
    targets.set(index, bucket);
  }
  const repaired = [...parts];
  for (const [index, found] of targets) {
    const part = repaired[index];
    const link = await linker.resolve({ verbatim: part.verbatim, citationWithStyle: part.citationWithStyle,
      kind: part.kind, candidate: found[0], fragments: part.pinpointFragments, bare: part.bareCitation });
    repaired[index] = { ...part, link, authorProvidedLink: found[0], authorProvidedLinks: found, preProviderLink: found[0] };
  }
  return repaired;
}

const blankPart = (fields: Partial<FootnotePart> & { verbatim: string }): FootnotePart => ({ corrected: fields.verbatim,
  kind: "other", link: "", pinpointFragments: [], pagePinpoints: [], bareCitation: fields.verbatim,
  citationWithStyle: fields.verbatim, shortForm: "", authorProvidedLink: "", authorProvidedLinks: [],
  preProviderLink: null, ...fields });

/** A note made only of ibid/supra clauses, one part per clause; null when the splitter is needed. */
function pureReferenceParts(note: string, allowLeadingIbid: boolean) {
  const clauses = engine<Array<{ text: string; name: string; pinpointFragments: string[]; pagePinpoints: number[] }> | null>(
    "pureReferenceClauses", { text: note });
  if (!clauses || (!allowLeadingIbid && refKind(clauses[0].text) === "ibid")) return null;
  return snapVerbatims(note, clauses.map((clause) => blankPart({ verbatim: clause.text, shortForm: clause.name,
    pinpointFragments: clause.pinpointFragments, pagePinpoints: clause.pagePinpoints, link: "" })));
}

/** A previous note whose last part carries a link gives a leading ibid a deterministic origin. */
function allowLeadingIbid(previous: FootnotePart[] | null) {
  const last = previous?.at(-1);
  if (!last) return false;
  const link = (last.preProviderLink ?? last.link).trim();
  return isUsableLink(link);
}

/** The engine's split and fields for a note; null when the mode needs a model for it. */
async function deterministicParts(note: string, linker: Linker, free: boolean) {
  const split = engine<{ status: string; parts: SplitPart[]; reasons: string[] }>("splitSources",
    { text: note, recallFirst: free, offsetUnit: "utf16" });
  if (split.status !== "deterministic_complete") return null;
  const fields = split.parts.map((part) => engine<SourceFields>("sourceFields", { part }));
  if (!free && split.parts.some((part) => refKind(part.text))) return null;
  if (!free && fields.some((field) => field.status !== "complete")) return null;
  const parts: FootnotePart[] = [];
  for (const [index, source] of split.parts.entries()) {
    const item = fields[index];
    const { fragments, pages } = pinpointsForKind(item.kind, item.pinpoint_fragments, item.page_pinpoints);
    const citationWithStyle = item.citation_with_style || source.text;
    const bare = bareCitation(citationWithStyle, item.kind) || item.bare_citation || source.text;
    const candidate = refKind(source.text) ? "" : item.link_candidate;
    const link = await linker.resolve({ verbatim: source.text, citationWithStyle, kind: item.kind, candidate,
      fragments, bare });
    parts.push(blankPart({ verbatim: source.text, corrected: item.corrected || source.text, kind: item.kind, link,
      pinpointFragments: fragments, pagePinpoints: pages, shortForm: item.short_form, bareCitation: bare,
      citationWithStyle, preProviderLink: link }));
  }
  // Linkable authorities need an identity later references can inherit.
  if (!free && parts.some((part) => ["case", "unreported", "statute"].includes(part.kind.trim().toLowerCase()) &&
      !isUsableLink(part.link.trim()))) return null;
  return { parts: snapVerbatims(note, parts), reasons: split.reasons };
}

/** Whether Ultra Economy's strict split could stand in for a model call (links aside). */
function strictlySplittable(note: string) {
  const split = engine<{ status: string; parts: SplitPart[] }>("splitSources", { text: note, recallFirst: false, offsetUnit: "utf16" });
  return split.status === "deterministic_complete" && split.parts.every((part) => !refKind(part.text) &&
    engine<SourceFields>("sourceFields", { part }).status === "complete");
}

const REF_STOPWORDS = new Set(("supra note notes ibid at para paras the of and in see also v r c et al this that a an " +
  "to for is was on by with as or").split(" "));
const refTokens = (text: string) => new Set((referenceInfo(text).normalized.match(/[a-z][a-z'’-]+/gu) ?? [])
  .filter((token) => !REF_STOPWORDS.has(token)));
const baseUrl = (link: string) => splitUrl(link ?? "")[0].trim();

/** Rank earlier citations for a reference the deterministic resolver abstained on. */
function disambiguationCandidates(verbatim: string, registry: RegistryEntry[], proposition: string) {
  const hint = supraHint(verbatim, true) || fallbackSupraHint(verbatim) || "";
  const hintTokens = refTokens(hint), hasHint = hintTokens.size > 0;
  const query = hasHint ? hintTokens : refTokens(verbatim), context = hasHint ? new Set<string>() : refTokens(proposition);
  const hintNorm = referenceInfo(hint).normalized.replace(/^[[\]() ]+|[[\]() ]+$/gu, "");
  const scored: Array<[number, RegistryEntry]> = [], seen = new Set<string>();
  for (const entry of registry) {
    const link = (entry.link ?? "").replace(/\s+/gu, " ").trim();
    const key = JSON.stringify([referenceInfo(entry.short_form).normalized, baseUrl(link).toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    const tokens = new Set([...refTokens(entry.short_form), ...refTokens(entry.verbatim.slice(0, 160))]);
    let score = 2 * [...query].filter((token) => tokens.has(token)).length + [...context].filter((token) => tokens.has(token)).length;
    if (hintNorm && referenceInfo(entry.short_form).normalized.replace(/^[[\]() ]+|[[\]() ]+$/gu, "") === hintNorm) score += 20;
    scored.push([score, entry]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  let top = scored.filter(([score]) => score > 0).slice(0, 8).map(([, entry]) => entry);
  if (!top.length) top = scored.slice(0, 8).map(([, entry]) => entry);
  return { candidates: top, proposition: hasHint ? "" : proposition };
}

/** A model's choice survives only when it names a work cited within three notes of the cited note. */
function noteWindowAccepts(verbatim: string, link: string, registry: RegistryEntry[]) {
  const note = supraNoteNumber(verbatim);
  if (note === null) return true;
  const notes = new Set(Array.from({ length: 7 }, (_, i) => String(note - 3 + i)));
  const pool = new Set(registry.filter((entry) => notes.has(entry.note) && isUsableLink((entry.link ?? "").trim()))
    .map((entry) => baseUrl(entry.link.replace(/\s+/gu, " ")).toLowerCase()));
  return !pool.size || pool.has(baseUrl(link.replace(/\s+/gu, " ")).toLowerCase());
}

type Resolution = { methods: Map<number, string> };
/** The engine's registry source: the link is the identity a reference resolves to. */
const asSource = (entry: RegistryEntry) => ({ verbatim: entry.verbatim, target: isUsableLink(entry.link) ? entry.link : "",
  short_form: entry.short_form, note: entry.note });
async function resolveReferences(split: FootnotePart[], registry: RegistryEntry[], options: {
  aggressive: boolean; supraAggressive: boolean; allowFallback: boolean; proposition: string;
  inferred: InferredForm[]; chooser?: AlrLlm["chooseReference"] }): Promise<Resolution> {
  const methods = new Map<number, string>(), abstained: number[] = [];
  for (const [index, part] of split.entries()) {
    const kind = refKind(part.verbatim);
    if (!kind) continue;
    if (kind === "ibid") {
      const origin = index > 0 ? split[index - 1].link : registry.at(-1)?.link ?? "";
      if (origin) { split[index] = { ...part, link: reanchor(origin, part.verbatim) }; methods.set(index, index > 0 ? "sibling" : "registry"); }
      else { split[index] = { ...part, link: reanchor(part.link, part.verbatim) }; methods.set(index, "model"); }
      continue;
    }
    const [resolved, method] = engine<[string, string]>("resolveRegistryReference",
      { text: part.verbatim, registry: registry.map(asSource), aggressive: options.supraAggressive });
    if (resolved) {
      split[index] = { ...part, link: reanchor(resolved, part.verbatim) };
      methods.set(index, method === "note_number" ? "note_number" : "registry");
      continue;
    }
    // ALR links a supra whose note number names another note (or none) by the short name it writes,
    // when that name names exactly one earlier citation (the engine's "named" linking).
    if (["note_name_conflict", "note_without_authority", "abstain_ambiguous_note_number"].includes(method)) {
      const name = supraHint(part.verbatim, true);
      const [named, namedMethod] = name ? engine<[string, string]>("resolveRegistryReference",
        { text: `${name}, supra`, registry: registry.map(asSource), aggressive: options.supraAggressive }) : ["", ""];
      if (named && ["exact_sf", "token_sf", "bracket_definition"].includes(namedMethod)) {
        split[index] = { ...part, link: reanchor(named, part.verbatim) }; methods.set(index, "registry"); continue;
      }
    }
    if (options.aggressive) {
      const [fallback, fallbackMethod] = engine<[string, string]>("resolveInferredReference",
        { text: part.verbatim, registry: registry.map(asSource), inferredForms: options.inferred.map((form) =>
          ({ short_form: form.short_form, short_form_norm: form.short_form_norm, rule: form.rule, target: form.link,
            note: form.note, verbatim: form.origin })) });
      if (fallback) { split[index] = { ...part, link: reanchor(fallback, part.verbatim) }; methods.set(index, fallbackMethod); continue; }
    }
    abstained.push(index);
    split[index] = { ...part, link: reanchor(part.link, part.verbatim) };
    methods.set(index, "model");
  }
  if (abstained.length && options.allowFallback && options.chooser) {
    for (const index of abstained) {
      const part = split[index];
      const { candidates, proposition } = disambiguationCandidates(part.verbatim, registry, options.proposition);
      if (!candidates.length) continue;
      const link = await options.chooser(part.verbatim, candidates, proposition).catch(() => "");
      if (link && noteWindowAccepts(part.verbatim, link, registry)) {
        split[index] = { ...part, link: reanchor(link, part.verbatim) }; methods.set(index, "disambig");
      } else if (link) methods.set(index, "disambig_rejected");
    }
  }
  // A wrong link is worse than none: references every stage abstained on lose the model's link.
  if (options.allowFallback) for (const index of abstained) if (["model", "disambig_rejected"].includes(methods.get(index)!)) {
    split[index] = { ...split[index], link: "" }; methods.set(index, "dropped_abstain");
  }
  return { methods };
}

export type PartRow = { footnoteId: number; index: number; part: FootnotePart; refLinkResolution: string };

export async function buildFootnoteParts(document: AlrDocument, order: number[], settings: AlrSettings,
  linker: Linker, llm: AlrLlm | null, progress: (done: number, total: number) => void) {
  const free = settings.run_mode === "free";
  const prefilter = settings.run_mode !== "high_accuracy";
  const deterministicSplitter = settings.run_mode === "free" || settings.run_mode === "ultra_economy";
  const aggressive = settings.supra_linking === "aggressive";
  // Python's default supra short-form mode is "aggressive" (SUPRA_MODE); supra_linking adds the fallbacks.
  const supraAggressive = true;
  const splitter: LlmSplitter | null = free ? null : llm?.splitter() ?? null;
  if (!free && !splitter) throw new Error(`Run mode ${settings.run_mode} needs an AI model; choose Free or connect one.`);

  const byId = new Map<number, FootnotePart[]>();
  const history: RegistryEntry[] = [], historyInferred: InferredForm[] = [];
  let previous: FootnotePart[] | null = null;
  const remember = (id: number, split: FootnotePart[], registry: RegistryEntry[], inferred: InferredForm[]) => {
    const note = document.displayIds.get(id) ?? String(id);
    for (const part of split) {
      registry.push({ verbatim: part.verbatim, link: part.link, short_form: part.shortForm, note });
      if (aggressive && isUsableLink(part.link)) for (const form of engine<Array<{ value: string; rule: string }>>(
        "inferShortForms", { text: part.verbatim, kind: part.kind })) inferred.push({ short_form: form.value,
        short_form_norm: engine<string>("normalizeShortForm", { text: form.value }), rule: form.rule, link: part.link,
        note, origin: part.verbatim });
    }
  };
  const settle = (id: number, split: FootnotePart[]) => {
    byId.set(id, split);
    if (split.length) { previous = split; remember(id, split, history, historyInferred); }
  };

  // Phase 1: each note in order, seeing the citations before it.
  let done = 0;
  for (const id of order) {
    const note = document.footnotes.get(id) ?? "";
    const pure = prefilter && note ? pureReferenceParts(note, allowLeadingIbid(previous)) : null;
    if (pure) {
      if (deterministicSplitter) await resolveReferences(pure, history, { aggressive, supraAggressive, allowFallback: false,
        proposition: "", inferred: historyInferred });
      settle(id, pure); progress(++done, order.length); continue;
    }
    const deterministic = deterministicSplitter && note ? await deterministicParts(note, linker, free) : null;
    if (deterministic) {
      const split = await applyAuthorLinks(note, deterministic.parts, document.authorLinks.get(id), linker);
      await resolveReferences(split, history, { aggressive, supraAggressive, allowFallback: false, proposition: "",
        inferred: historyInferred });
      settle(id, split); progress(++done, order.length); continue;
    }
    // Free mode keeps a note the splitter could not finish as one lossless part.
    if (!note || !splitter) { byId.set(id, []); progress(++done, order.length); continue; }
    const upcoming = order.slice(order.indexOf(id) + 1).map((next) => ({ id: next, note: document.footnotes.get(next) ?? "" }))
      .filter((item) => item.note && !(prefilter && engine("pureReferenceClauses", { text: item.note })) &&
        !(deterministicSplitter && strictlySplittable(item.note)));
    const split = await splitter.split(id, note, history, upcoming, async (raw) => {
      const parts: FootnotePart[] = [];
      for (const item of raw) parts.push(await modelPart(item, linker));
      return applyAuthorLinks(note, snapVerbatims(note, parts), document.authorLinks.get(id), linker);
    });
    settle(id, split); progress(++done, order.length);
  }

  // Phase 2: references against every earlier part.
  const methods = new Map<string, string>();
  const registry: RegistryEntry[] = [], inferred: InferredForm[] = [];
  for (const id of order) {
    const split = byId.get(id) ?? [];
    const resolution = await resolveReferences(split, registry, { aggressive, supraAggressive, allowFallback: true,
      proposition: document.propositions.get(id) ?? "", inferred, chooser: free ? undefined : llm?.chooseReference });
    for (const [index, method] of resolution.methods) methods.set(`${id}:${index + 1}`, method);
    remember(id, split, registry, inferred);
  }

  // Phase 3: one row per part; an empty split keeps the note as one unlinked part.
  const rows: PartRow[] = [], partsPerNote = new Map<number, number>();
  for (const id of order) {
    const note = document.footnotes.get(id) ?? "";
    let split = byId.get(id) ?? [];
    if (!split.length && note) split = await applyAuthorLinks(note, [blankPart({ verbatim: note })], document.authorLinks.get(id), linker);
    partsPerNote.set(id, split.length);
    split.forEach((part, index) => rows.push({ footnoteId: id, index: index + 1, part,
      refLinkResolution: methods.get(`${id}:${index + 1}`) ?? "" }));
  }
  return { rows, partsPerNote };
}

export type ModelPart = { verbatim?: string; corrected?: string; kind?: string; link?: string;
  pinpoint_fragments?: string[]; page_pinpoints?: number[]; short_form?: string; bare_citation?: string;
  citation_with_style?: string };

/** A model's part with ALR's repairs: fallbacks for missing fields, decimal sections, kind-fit pinpoints. */
async function modelPart(item: ModelPart, linker: Linker): Promise<FootnotePart> {
  const verbatim = (item.verbatim ?? "").trim(), kind = (item.kind ?? "other").trim() || "other";
  const citationWithStyle = (item.citation_with_style ?? "").trim() || verbatim;
  const bare = (item.bare_citation ?? "").trim() || bareCitation(citationWithStyle, kind) || verbatim;
  const candidate = (item.link ?? "other").trim() || "other";
  // "sec672" where the citation shows exactly one "672.54" is the decimal provision.
  const repaired = (item.pinpoint_fragments ?? []).map((raw) => {
    const integer = /^sec(\d+)$/iu.exec(String(raw ?? "").trim());
    if (!integer) return raw;
    const decimals = new Set([...verbatim.matchAll(new RegExp(`\\b${integer[1]}\\.(\\d+)`, "gu"))].map((match) => match[1]));
    return decimals.size === 1 ? `sec${integer[1]}.${[...decimals][0]}` : raw;
  });
  const { fragments, pages } = pinpointsForKind(kind, repaired, item.page_pinpoints ?? []);
  const link = await linker.resolve({ verbatim, citationWithStyle, kind, candidate, fragments, bare });
  return blankPart({ verbatim, corrected: (item.corrected ?? "").trim(), kind, link, pinpointFragments: fragments,
    pagePinpoints: pages, shortForm: (item.short_form ?? "").trim(), bareCitation: bare, citationWithStyle,
    preProviderLink: candidate });
}
