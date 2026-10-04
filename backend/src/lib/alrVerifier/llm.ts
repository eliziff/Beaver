// The model steps of ALR's paid run modes: splitting notes into citation parts (several notes per
// call) and choosing the work a supra reference names when the deterministic resolver abstains.
// Prompts and schema follow alr_quote_verifier.py SYSTEM_INSTRUCTIONS / FOOTNOTE_SPLIT_SCHEMA and
// REF_DISAMBIG_SYSTEM, reshaped for batches.
import type { FootnotePart, ModelPart, RegistryEntry } from "./parts";

export type LlmMessage = { role: "system" | "user"; content: string };
export type AlrLlmClient = {
  complete(messages: LlmMessage[], options: { schema: Record<string, unknown>; name: string }):
    Promise<{ text: string; usage?: Record<string, number> }>;
};
/** Optional memo of model answers (the app's llm_cache): keyed by a hash of the request. */
export type LlmCache = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };

const PART = {
  type: "object", additionalProperties: false,
  properties: {
    verbatim: { type: "string" }, corrected: { type: "string" }, kind: { type: "string" }, link: { type: "string" },
    pinpoint_fragments: { type: "array", items: { type: "string" } },
    page_pinpoints: { type: "array", items: { type: "integer" } },
    short_form: { type: "string" }, bare_citation: { type: "string" }, citation_with_style: { type: "string" },
  },
  required: ["verbatim", "corrected", "kind", "link", "pinpoint_fragments", "page_pinpoints", "short_form",
    "bare_citation", "citation_with_style"],
};
export const SPLIT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["footnotes"],
  properties: { footnotes: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["footnote", "parts"], properties: { footnote: { type: "integer" },
      parts: { type: "array", minItems: 1, items: PART } } } } },
};
const CHOICE_SCHEMA = { type: "object", additionalProperties: false, required: ["choice"],
  properties: { choice: { type: "integer" } } };

const SPLIT_INSTRUCTIONS = `Split each legal footnote into citation parts, correct each part to the McGill Guide, and return JSON.

Splitting:
- Default rule: split on top-level semicolons. Fix authors' errors: split two distinct citations even without a semicolon; do not split inside one citation.
- Put every supra or ibid reference in its own part. A footnote that is only one supra or ibid stays one part.
- Every part's text is unique; parts never overlap. Keep the footnote's order.
Examples: "Jane Smith, (2024) 45 Journal 100. See also Short Form, supra note 3 at 45." -> "Jane Smith, (2024) 45 Journal 100." | "See also Short Form, supra note 3 at 45." ; "Short Form, supra note 3 at 45. Ibid at 50." -> "Short Form, supra note 3 at 45." | "Ibid at 50."

Fields of each part:
- verbatim: the exact substring of the footnote (outer whitespace trimmed).
- corrected: the same citation in McGill order and punctuation. Never invent missing data; keep any notes that are not the citation.
- kind: one of statute, gazette, case, unreported, parliamentary_paper, non_parliamentary, journal, book, essay_collection, report, other.
- link: the source URL by the patterns below, or "other".
- pinpoint_fragments: "paras 15–17" -> ["par15"]; "paras 99, 101" -> ["par99", "par101"]; "s 718(c), 16, 672.54(b)" -> ["sec718", "sec16", "sec672.54"]; "r 11.10" -> ["sec11.10"]; "art 1457" -> ["sec1457"]. Keep full dotted or hyphenated provision numbers; omit subsection parentheses.
- page_pinpoints: "at 245" -> [245]; "at 763-64" -> [763, 764]; "at pp 99-101" -> [99, 100, 101]; paragraph and section pinpoints -> [].
- short_form: the bracketed short form without brackets (e.g. "Brown (SCC)"); for secondary sources without one, the author surname(s) later supra references use (e.g. "Roach", "Mishra, Logan and Prescott").
- bare_citation: the citation alone with its pinpoint: no signal, style of cause or commentary. "See, e.g., The Queen v. King, [1962] SCR 746 at 763-64" -> "[1962] SCR 746 at 763-64"; "Criminal Code, RSC 1985, c C-46, s 718(c)" -> "RSC 1985, c C-46, s 718(c)".
- citation_with_style: the full citation with its style of cause, without signals or editorial notes.

Links:
- Cases: https://www.canlii.org/en/[jurisdiction]/[court]/doc/[YYYY]/[citation]/[citation].html, plus #par[first paragraph pinpoint]; e.g. https://www.canlii.org/en/bc/bcca/doc/2026/2026bcca2/2026bcca2.html#par34. Use a CanLII citation when the case has one. QCCM, QCCQ, QCCS and QCCA use /fr/.
- Legislation: https://www.canlii.org/en/[jurisdiction]/laws/[stat|regu|astat]/[citation]/latest/[citation].html, plus #sec[first provision]; e.g. https://www.canlii.org/en/on/laws/stat/rso-1990-c-e7/latest/rso-1990-c-e7.html#sec37.
- A citation that gives a URL or perma.cc link uses it (the URL over the perma.cc link).
- A supra reference uses the link of the earlier citation it names; an ibid uses the link of the last earlier citation. Earlier citations are listed below with their links and short forms; earlier footnotes in the same request count too.
- Foreign cases and anything else without a pattern: "other".

Return {"footnotes": [{"footnote": <number>, "parts": [...]}]} with one entry per input footnote.`;

const CHOOSER_INSTRUCTIONS = `You resolve supra/ibid references in Canadian legal footnotes.
You are given one reference part and a numbered list of candidate prior citations from the same document (footnote number where it appeared, short form, citation text, link). Authors' "supra note N" numbers are often wrong by one to three; treat the name/subject match as primary and the footnote number as a tie-breaker. When body text the footnote is attached to is shown, it usually names the work the reference points to. Pick the candidate the reference points to. If none of them is the referenced work, or the referenced work has no usable link, answer 0.
Answer with JSON: {"choice": <number>} where 0 means none.`;

async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parseJson(text: string) {
  let value = (text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const first = value.indexOf("{"), last = value.lastIndexOf("}");
  if (first >= 0 && last > first) value = value.slice(first, last + 1);
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

export type Upcoming = Array<{ id: number; note: string }>;
export type LlmSplitter = {
  split(id: number, note: string, history: readonly RegistryEntry[], upcoming: Upcoming,
    finalize: (parts: ModelPart[]) => Promise<FootnotePart[]>): Promise<FootnotePart[]>;
};
export type AlrLlm = {
  splitter(): LlmSplitter;
  chooseReference(verbatim: string, candidates: RegistryEntry[], proposition: string): Promise<string>;
  usage: Record<string, number>;
  calls: number;
};

/** Notes per model call: enough to amortize the instructions, few enough that history stays current. */
export const SPLIT_BATCH = 8;

export function alrLlm(client: AlrLlmClient, cache?: LlmCache): AlrLlm {
  const usage: Record<string, number> = {};
  const state = { calls: 0 };
  const ask = async (messages: LlmMessage[], schema: Record<string, unknown>, name: string) => {
    const key = await sha256(JSON.stringify([name, messages, schema]));
    const cached = await cache?.get(key);
    if (cached) return parseJson(cached);
    const answer = await client.complete(messages, { schema, name });
    state.calls++;
    for (const [field, value] of Object.entries(answer.usage ?? {})) if (typeof value === "number") usage[field] = (usage[field] ?? 0) + value;
    const parsed = parseJson(answer.text);
    if (parsed) await cache?.set(key, answer.text);
    return parsed;
  };
  const historyText = (history: readonly RegistryEntry[]) => history.map((entry) =>
    `- Citation: ${entry.verbatim} --> Link: ${entry.link.split("#")[0]} --> short_form: ${entry.short_form.trim() || "N/A"}\n`).join("");
  return {
    usage,
    get calls() { return state.calls; },
    splitter() {
      const answered = new Map<number, ModelPart[]>();
      return {
        async split(id, note, history, upcoming, finalize) {
          if (!answered.has(id)) {
            const batch = [{ id, note }, ...upcoming.filter((item) => !answered.has(item.id)).slice(0, SPLIT_BATCH - 1)];
            const earlier = historyText(history);
            const parsed = await ask([
              { role: "system", content: `${SPLIT_INSTRUCTIONS}\n\nEarlier citations (citation --> link --> short form):\n${earlier || "(none)\n"}` },
              { role: "user", content: JSON.stringify(batch.map((item) => ({ footnote: item.id, text: item.note }))) },
            ], SPLIT_SCHEMA, "footnote_split");
            const footnotes = Array.isArray(parsed?.footnotes) ? parsed!.footnotes as Array<{ footnote?: number; parts?: ModelPart[] }> : [];
            for (const item of batch) {
              const found = footnotes.find((entry) => entry.footnote === item.id);
              answered.set(item.id, (found?.parts ?? []).filter((part) => (part.verbatim ?? "").trim()));
            }
          }
          const parts = answered.get(id) ?? [];
          // An unusable answer leaves the note as one unlinked part, as ALR does.
          return parts.length ? finalize(parts) : [];
        },
      };
    },
    async chooseReference(verbatim, candidates, proposition) {
      const lines = [`Reference part: ${verbatim}`];
      if (proposition) lines.push(`Body text the footnote is attached to: ${proposition.slice(0, 600)}`);
      lines.push("", "Candidates:", ...candidates.map((entry, index) => `${index + 1}. [fn ${entry.note || "?"}] short_form: ` +
        `${entry.short_form || "(none)"} | citation: ${entry.verbatim.slice(0, 160)} | link: ${entry.link || "other"}`),
      "0. none of these / no usable link");
      const parsed = await ask([{ role: "system", content: CHOOSER_INSTRUCTIONS }, { role: "user", content: lines.join("\n") }],
        CHOICE_SCHEMA, "supra_choice");
      const choice = Number(parsed?.choice ?? 0);
      const link = Number.isInteger(choice) && choice >= 1 && choice <= candidates.length ? candidates[choice - 1].link.trim() : "";
      return link && link.toLowerCase() !== "other" ? link : "";
    },
  };
}
