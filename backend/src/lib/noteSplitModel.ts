// A model's reading of footnotes, for a product that offers one beside the engine's splitting mode: each note
// split into its citation parts with each part's fields, and the choice of the work a supra the engine could not
// resolve refers to. Ported from ALR-Quote-Verifier alr_quote_verifier.py (read-only reference):
// SYSTEM_INSTRUCTIONS, FOOTNOTE_SPLIT_SCHEMA and split_footnote_parts (the split), _snap_verbatim_parts (each
// part placed back on the note's own text), REF_DISAMBIG_SYSTEM, _ref_disambig_candidates, _ref_disambig_choose and
// _ref_fallback_link_guard_ok (the choice). Changed from the Python app: several notes are read per request and
// none is given the history of earlier notes, because links here are built by Beaver's link builders and
// references resolved by the engine, not taken from the model; the fields that only fed the model's own links
// are not asked for. A part the model returns that cannot be placed losslessly on its note makes the whole note
// unusable, so its caller keeps the engine's parts.
import type { StructuredLlm, StructuredUsage } from "./llm/keyConnection";
import { structureNative } from "./structureNative";

export type ModelPartFields = { corrected: string; kind: string; pinpoint_fragments: string[]; page_pinpoints: number[];
  short_form: string; bare_citation: string; citation_with_style: string };
/** A part at its place in its note's text. */
export type ModelNotePart = { start: number; end: number; text: string; fields: ModelPartFields };

const SPLIT_INSTRUCTIONS = `You split legal footnotes into citation parts and correct citation formatting according to the McGill Guide.

The input is a JSON list of footnotes, each with an id and its text. Return every footnote by its id, with its parts in the order they appear.

Splitting:
1) Split each footnote into citation parts. Default rule: split on top-level semicolons.
2) Authors sometimes split incorrectly. Fix splitting errors:
   - If a semicolon is missing between two distinct citations, split anyway.
   - If a semicolon wrongly splits a single citation (e.g., inside a citation element), do NOT split there.
3) Split supra and ibid references into their own parts. Never leave a supra or ibid merged with another citation in the same part. If the whole footnote is only one supra or ibid, keep it as a single part.
4) Every part must contain unique text that does not overlap with any other part, and the parts together must hold all of the footnote's text.

Splitting examples (each → shows the correct parts):

"Jane Smith, (2024) 45 Journal 100. See also Short Form, supra note 3 at 45."
→ Part 1: "Jane Smith, (2024) 45 Journal 100."
→ Part 2: "See also Short Form, supra note 3 at 45."

"supra note 3; see also Case Name, 2025 SCC 10 at para 20."
→ Part 1: "supra note 3"
→ Part 2: "see also Case Name, 2025 SCC 10 at para 20."

"Short Form, supra note 3 at 45. Ibid at 50."
→ Part 1: "Short Form, supra note 3 at 45."
→ Part 2: "Ibid at 50."

"Citation A. See also supra note 3. See also supra note 7."
→ Part 1: "Citation A."
→ Part 2: "See also supra note 3."
→ Part 3: "See also supra note 7."

"Full Citation (2024) 45 Journal 100. See also Author, supra note 3 at 20-25. See further Other, supra note 8 at 5."
→ Part 1: "Full Citation (2024) 45 Journal 100."
→ Part 2: "See also Author, supra note 3 at 20-25."
→ Part 3: "See further Other, supra note 8 at 5."

For each part:
- verbatim: the exact substring of the footnote for that citation part (preserve spelling, punctuation and spacing; trim outer whitespace).
- corrected: the same citation, corrected to conform to McGill-style ordering and punctuation/spacing where determinable from the text. Do not invent missing bibliographic data; if information is missing, keep it missing; only fix structure, separators, spacing and obvious punctuation. Notes in the footnote other than the citation are preserved.
- kind: one of: statute, gazette, case, unreported, parliamentary_paper, non_parliamentary, journal, book, essay_collection, report, other.
- pinpoint_fragments: the pinpoint fragments of the citation part. For ranges (e.g., "paras 15–17"), only the first fragment (par15). For comma-separated pinpoints (e.g., "paras 99, 101"), each one separately (par99, par101). Examples: "Servatius BCSC, supra note 1 at paras 15–17" → ["par15"]; "Servatius BCCA, supra note 2 at paras 99, 101" → ["par99", "par101"]; "Criminal Code, RSC 1985, c C-46, s 718(c), 16, 672.54(b)" → ["sec718", "sec16", "sec672.54"]. Rules and articles are legislation provisions too: "r 11.10" → ["sec11.10"], "Rule 4-1" → ["sec4-1"], and "art 1457" → ["sec1457"]. Preserve the full dotted or hyphenated provision number; omit subsection parentheses from the fragment.
- page_pinpoints: integer page numbers from the citation's page pinpoint. "at 245" or "at p 245" → [245]; "at 763-64" → [763, 764]; "at pp 99-101" → [99, 100, 101]; "at para 20" or "at paras 15-17" → [] (paragraphs are not pages); section pinpoints → []. Empty if there is no page pinpoint.
- short_form: the short form label for this citation (e.g., "[Brown (SCC)]"), or, for secondary sources without a bracket short form, the author surname(s) used to refer to this work in later supra references (e.g., "Roach" for "Kent Roach, Criminal Law...", or "Mishra, Logan and Prescott" for a joint work). If the citation text already has a [short form] in brackets, extract it without brackets. For secondary sources (journal articles, books, reports), infer the author name(s) as they would appear in a supra reference.
- bare_citation: the citation itself with introductory signals, editorial notes, style of cause and surrounding commentary stripped away: just the bare legal citation with pinpoint. "See, e.g., The Queen v. King, [1962] SCR 746 at 763-64" → "[1962] SCR 746 at 763-64". "(R v Sullivan, [2016] OJ No 6847 at paras 47 and 80 [Sullivan (ONSC)])" → "[2016] OJ No 6847 at paras 47 and 80". "Criminal Code, RSC 1985, c C-46, s 718(c)" → "RSC 1985, c C-46, s 718(c)".
- citation_with_style: the full citation including the style of cause if present, with introductory signals and editorial notes stripped. "See, e.g., The Queen v. King, [1962] SCR 746 at 763-64" → "The Queen v. King, [1962] SCR 746 at 763-64". "Criminal Code, RSC 1985, c C-46, s 718(c)" → "Criminal Code, RSC 1985, c C-46, s 718(c)".

McGill Guide patterns (high-level):
- Statutes: Title, | volume | jurisdiction | year, | c | other elements | (session/supp) | pinpoint.
- Gazettes: Title (person/body), | (year) | Gazette abbr | part | page | (additional info).
- Jurisprudence: Style of cause, | main citation | pinpoint, | parallel citation | (jurisdiction/court) | [short form].
- Unreported: Style of cause | (date), | judicial district | docket no | (jurisdiction/court).
- Parliamentary Papers: Jurisdiction, | legislature, | title, | session, | volume | number | (date) | pinpoint | (speaker).
- Non-parliamentary documents: Jurisdiction, | issuing body, | title, | (type), | publication info | pinpoint.
- Journals: Author, | “title” | (year) | volume: | issue | journal abbr | first page | pinpoint.
- Books: Author, | title, | edition | (place: publisher, year) | pinpoint.
- Essay/entry in collection: Author, | “title” | in | editor, ed, | book title, | edition | (place: publisher, year) | first page | pinpoint.
- Reports: Author, | title, | (place: publisher, year) | pinpoint.
- Website: Author, | “title of the page/article” | (date of the page/article) | pinpoint, | online | (type of electronic source) | : | <URL> | [perma.cc URL].

Answer with JSON: {"notes": [{"id": "<footnote id>", "parts": [{"verbatim", "corrected", "kind", "pinpoint_fragments", "page_pinpoints", "short_form", "bare_citation", "citation_with_style"}]}]}.`;

const STRINGS = { type: "array", items: { type: "string" } };
const PART_SCHEMA = { type: "object", additionalProperties: false,
  required: ["verbatim", "corrected", "kind", "pinpoint_fragments", "page_pinpoints", "short_form", "bare_citation", "citation_with_style"],
  properties: { verbatim: { type: "string" }, corrected: { type: "string" }, kind: { type: "string" },
    pinpoint_fragments: STRINGS, page_pinpoints: { type: "array", items: { type: "integer" } },
    short_form: { type: "string" }, bare_citation: { type: "string" }, citation_with_style: { type: "string" } } };
export const NOTE_SPLIT_SCHEMA = { type: "object", additionalProperties: false, required: ["notes"],
  properties: { notes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "parts"],
    properties: { id: { type: "string" }, parts: { type: "array", items: PART_SCHEMA } } } } } };

type Answered = { verbatim: string } & ModelPartFields;
const emptyUsage = (): StructuredUsage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });

/** Several notes per request (at most `batchNotes`, and about `batchChars` of text), `concurrency` requests at
 *  once. Each note's parts, or null where the model's answer could not be placed on the note's text. */
export async function splitNotesWithModel(llm: StructuredLlm, notes: Array<{ id: string; text: string }>, options: {
  signal?: AbortSignal; progress?: (done: number, total: number) => void; batchNotes?: number; batchChars?: number;
  concurrency?: number } = {}) {
  const { batchNotes = 8, batchChars = 4000, concurrency = 4 } = options;
  const batches: Array<typeof notes> = [];
  for (const note of notes) {
    const last = batches.at(-1);
    if (last && last.length < batchNotes && last.reduce((sum, item) => sum + item.text.length, 0) + note.text.length <= batchChars) last.push(note);
    else batches.push([note]);
  }
  const parts = new Map<string, ModelNotePart[] | null>(), usage = emptyUsage();
  let done = 0, next = 0;
  options.progress?.(0, batches.length);
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      options.signal?.throwIfAborted();
      const answer = await llm.complete([{ role: "system", content: SPLIT_INSTRUCTIONS },
        { role: "user", content: JSON.stringify(batch.map(({ id, text }) => ({ id, text }))) }],
      { schema: NOTE_SPLIT_SCHEMA, name: "footnote_split", signal: options.signal });
      for (const key of Object.keys(usage) as Array<keyof StructuredUsage>) usage[key] += answer.usage[key] ?? 0;
      let returned: Array<{ id: string; parts: Answered[] }> = [];
      try { returned = (JSON.parse(answer.text) as { notes?: typeof returned }).notes ?? []; } catch { /* Unusable: every note keeps the engine's parts. */ }
      for (const note of batch) {
        const found = returned.find((item) => String(item.id) === note.id);
        parts.set(note.id, found ? placeParts(note.text, found.parts ?? []) : null);
      }
      options.progress?.(++done, batches.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return { parts, usage, requests: batches.length };
}

// _snap_verbatim_parts: lowercase, unified quotes and dashes, collapsed whitespace, with each character's
// place in the original text.
const SNAP: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-" };
function normalized(text: string) {
  let out = "", spaced = true;
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/\s/u.test(char)) {
      if (spaced) continue;
      out += " "; at.push(index); spaced = true;
    } else { out += (SNAP[char] ?? char).toLowerCase(); at.push(index); spaced = false; }
  }
  while (out.endsWith(" ")) { out = out.slice(0, -1); at.pop(); }
  return { out, at };
}

/** The model's parts placed on the note's text, in order and without overlap, each holding its text; null when
 *  a part is not in the note or the parts leave out more than separators. Text between parts that is only
 *  punctuation joins the part before it. */
export function placeParts(text: string, answered: Answered[]): ModelNotePart[] | null {
  if (!answered.length) return null;
  const note = normalized(text), spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const part of answered) {
    const wanted = normalized(part.verbatim ?? "").out.trim();
    if (!wanted) return null;
    let found = note.out.indexOf(wanted, cursor);
    if (found < 0) found = note.out.indexOf(wanted);
    if (found < 0) return null;
    spans.push([found, found + wanted.length]);
    cursor = Math.max(cursor, found);
  }
  for (let index = 0; index + 1 < spans.length; index++) {
    if (spans[index][1] > spans[index + 1][0]) spans[index][1] = spans[index + 1][0];
    if (spans[index][1] <= spans[index][0]) return null;
  }
  for (const span of spans) while (span[1] < note.out.length && note.out[span[1]] === ",") span[1]++;
  // In the note's own offsets.
  const placed = spans.map(([start, end]) => [note.at[start], note.at[end - 1] + 1]);
  for (let index = 0; index < placed.length; index++) {
    const before = index ? placed[index - 1][1] : 0, gap = text.slice(before, placed[index][0]);
    if (placed[index][0] < before) return null;
    if (/[\p{L}\p{N}]/u.test(gap)) return null;
    // Punctuation an author left between parts stays with the part it follows (or, before the first, the first).
    const kept = gap.replace(/[\s;]+$/u, "").replace(/^[\s;]+/u, "");
    if (kept && index) placed[index - 1][1] = before + gap.indexOf(kept) + kept.length;
    else if (kept) placed[index][0] = gap.indexOf(kept);
  }
  const tail = text.slice(placed.at(-1)![1]);
  if (/[\p{L}\p{N}]/u.test(tail)) return null;
  const trailing = tail.replace(/[\s;]+$/u, "");
  if (trailing.trim()) placed.at(-1)![1] += tail.indexOf(trailing.trim()) + trailing.trim().length;
  return placed.map(([start, end], index) => {
    const { verbatim: _verbatim, ...fields } = answered[index];
    return { start, end, text: text.slice(start, end), fields: { corrected: fields.corrected ?? "", kind: fields.kind ?? "other",
      pinpoint_fragments: fields.pinpoint_fragments ?? [], page_pinpoints: (fields.page_pinpoints ?? []).map(Number),
      short_form: fields.short_form ?? "", bare_citation: fields.bare_citation ?? "", citation_with_style: fields.citation_with_style ?? "" } };
  });
}

// The reference chooser: one small request for a supra the engine left unresolved.
const CHOOSE_INSTRUCTIONS = `You resolve supra/ibid references in Canadian legal footnotes.
You are given one reference part and a numbered list of candidate prior
citations from the same document (footnote number where it appeared, short
form, citation text, link). Authors' "supra note N" numbers are often wrong
by one to three; treat the name/subject match as primary and the footnote
number as a tie-breaker. When body text the footnote is attached to is
shown, it usually names the work the reference points to. Pick the candidate
the reference points to. If none of them is the referenced work, or the
referenced work has no usable link, answer 0.
Answer with JSON: {"choice": <number>} where 0 means none.`;
const CHOOSE_SCHEMA = { type: "object", additionalProperties: false, required: ["choice"], properties: { choice: { type: "integer" } } };

/** An earlier part of the same document a reference may name. */
export type ReferenceCandidate = { note: string; shortForm: string; text: string; link: string };
const STOPWORDS = new Set(["supra", "note", "notes", "ibid", "at", "para", "paras", "the", "of", "and", "in", "see", "also",
  "v", "r", "c", "et", "al", "this", "that", "a", "an", "to", "for", "is", "was", "on", "by", "with", "as", "or"]);
const engine = <T>(method: string, request: unknown) => structureNative().citationEngineCall(method, JSON.stringify(request)) as T;
const normalizedReference = (text: string) => engine<{ normalized: string }>("referenceInfo", { text }).normalized;
const tokens = (text: string) => new Set((normalizedReference(text).match(/[a-z][a-z'’-]+/gu) ?? []).filter((token) => !STOPWORDS.has(token)));
const baseLink = (link: string) => link.split("#", 1)[0].replace(/\s+/gu, " ").trim().toLowerCase();
const linked = (link: string) => !!link.trim() && link.trim().toLowerCase() !== "other";

/** The earlier parts most like the reference (its name, else the passage its note ends), at most eight, each work once. */
export function rankReferenceCandidates(reference: string, earlier: ReferenceCandidate[], proposition: string) {
  const hint = engine<string>("supraHint", { text: reference, aggressive: false })
    || engine<string>("supraHint", { text: reference, aggressive: false, fallback: true });
  const hinted = tokens(hint), wanted = hinted.size ? hinted : tokens(reference);
  const fromPassage = hinted.size ? new Set<string>() : tokens(proposition);
  const exact = normalizedReference(hint).replace(/^[[\]() ]+|[[\]() ]+$/gu, "");
  const seen = new Set<string>();
  const scored = earlier.flatMap((candidate) => {
    const key = `${normalizedReference(candidate.shortForm)}|${baseLink(candidate.link)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const own = new Set([...tokens(candidate.shortForm), ...tokens(candidate.text.slice(0, 160))]);
    let score = 2 * [...wanted].filter((token) => own.has(token)).length + [...fromPassage].filter((token) => own.has(token)).length;
    if (exact && normalizedReference(candidate.shortForm).replace(/^[[\]() ]+|[[\]() ]+$/gu, "") === exact) score += 20;
    return [{ score, candidate }];
  }).sort((a, b) => b.score - a.score);
  const top = scored.filter(({ score }) => score > 0).slice(0, 8);
  return { candidates: (top.length ? top : scored.slice(0, 8)).map(({ candidate }) => candidate),
    proposition: hinted.size ? "" : proposition };
}

/** The candidate the model says the reference names, or null; refused (null) when the reference's note number has
 *  linked works within three notes of it and the chosen one is not among them. */
export async function chooseReferenceTarget(llm: StructuredLlm, reference: string, earlier: ReferenceCandidate[],
  proposition: string, signal?: AbortSignal) {
  const { candidates, proposition: shown } = rankReferenceCandidates(reference, earlier, proposition);
  if (!candidates.length) return { chosen: null, usage: emptyUsage() };
  const lines = [`Reference part: ${reference}`, ...shown ? [`Body text the footnote is attached to: ${shown.slice(0, 600)}`] : [],
    "", "Candidates:", ...candidates.map((item, index) => `${index + 1}. [fn ${item.note || "?"}] short_form: ${
      item.shortForm || "(none)"} | citation: ${item.text.slice(0, 160)} | link: ${item.link || "other"}`),
    "0. none of these / no usable link"];
  const answer = await llm.complete([{ role: "system", content: CHOOSE_INSTRUCTIONS }, { role: "user", content: lines.join("\n") }],
    { schema: CHOOSE_SCHEMA, name: "supra_choice", signal });
  let choice = 0;
  try { choice = Number(JSON.parse(answer.text).choice) || 0; } catch { /* None chosen. */ }
  const chosen = choice >= 1 && choice <= candidates.length && linked(candidates[choice - 1].link) ? candidates[choice - 1] : null;
  if (!chosen) return { chosen: null, usage: answer.usage };
  const noted = Number(engine<{ notes: string[] }>("referenceInfo", { text: reference }).notes[0]);
  if (Number.isInteger(noted)) {
    const near = new Set(Array.from({ length: 7 }, (_, offset) => String(noted + offset - 3)));
    const pool = new Set(earlier.filter((item) => near.has(item.note) && linked(item.link)).map((item) => baseLink(item.link)));
    if (pool.size && !pool.has(baseLink(chosen.link))) return { chosen: null, usage: answer.usage };
  }
  return { chosen, usage: answer.usage };
}
