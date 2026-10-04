// Ibid/supra chains for the workbook's ref_* columns, and what a reference row inherits from the
// citation its chain ends at. Ported from alr_quote_verifier.py resolve_reference_chains,
// _choose_supra_target_part_index, _attach_ref_chain_origin_sources, _should_use_ref_chain_origin,
// _effective_ref_origin_link and _apply_ref_chain_origin_sources.
import { isIbid, reanchor, supraHint, supraNoteNumber } from "./engine";
import type { AlrRow } from "./rows";
import { appendFirstPinpoint, isUsableLink, normalizeAnchor, splitUrl } from "./urls";

export const REF_FIELDS = ["ref_kind", "ref_target_footnote_id", "ref_target_citation_part_index",
  "ref_target_citation_part_text", "ref_target_footnote_full", "ref_chain_origin_footnote_id",
  "ref_chain_origin_citation_part_index", "ref_chain_origin_citation_part_text", "ref_resolution_notes",
  "ref_chain_path"] as const;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Which part of a multi-citation note a "supra note N" means: the one its short form names. */
function supraTargetPart(targetId: number, citing: string, byNote: Map<number, AlrRow[]>, noteLabel: number): [number, string | null] {
  const candidates = [...(byNote.get(targetId) ?? [])].sort((a, b) => a.citation_part_index - b.citation_part_index);
  if (!candidates.length) return [1, "Supra target footnote not found in this DOCX."];
  if (candidates.length === 1) return [candidates[0].citation_part_index || 1, null];
  const hint = supraHint(citing, true);
  if (!hint) return [candidates[0].citation_part_index || 1,
    "Supra target footnote has multiple references; could not infer intended citation-part (no short form). Defaulted to part 1."];
  const score = (row: AlrRow, token: string) => {
    const text = row.citation_part_text.toLowerCase(), short = row.short_form.toLowerCase();
    if (text.includes(`[${token}]`) || (short && short === token)) return 4;
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escape(token)}(?![\\p{L}\\p{N}_])`, "u").test(text)) return 2;
    return text.includes(token) ? 1 : 0;
  };
  const best = (token: string) => candidates.reduce((top, row) => score(row, token) > score(top, token) ? row : top, candidates[0]);
  for (const token of [hint.toLowerCase(), hint.toLowerCase().split(/\s+/u).at(-1)!]) {
    const found = best(token);
    if (score(found, token) > 0) return [found.citation_part_index || 1, null];
  }
  const available = candidates.map((row) => `part ${row.citation_part_index}='${row.short_form || row.citation_part_text.slice(0, 80)}'`).join("; ");
  return [candidates[0].citation_part_index || 1,
    `Supra short form ('${hint}') did not match any citation-part in note ${noteLabel}. Available: ${available}. Defaulted to part 1.`];
}

export function resolveReferenceChains(rows: AlrRow[], footnotes: Map<number, string>, partsPerNote: Map<number, number>,
  displayNumberToId: Map<number, number>, displayIds: Map<number, string>) {
  const key = (row: AlrRow) => `${row.footnote_id}:${row.citation_part_index}`;
  const byKey = new Map(rows.map((row) => [key(row), row])), order = rows.map(key);
  const byNote = new Map<number, AlrRow[]>();
  for (const row of rows) byNote.set(row.footnote_id, [...(byNote.get(row.footnote_id) ?? []), row]);
  const display = (id: number) => displayIds.get(id) ?? String(id);

  const follow = (start: number): [string | null, string[], string[]] => {
    const visited = new Set<string>(), path: string[] = [], warnings: string[] = [];
    let current: string | null = order[start];
    while (current) {
      if (visited.has(current)) { warnings.push("Reference chain loop detected."); return [null, path, warnings]; }
      visited.add(current);
      const row = byKey.get(current);
      if (!row) { warnings.push("Reference chain target not found in part index."); return [null, path, warnings]; }
      const text = row.citation_part_text.trim(), note = supraNoteNumber(text);
      if (note !== null) {
        const target = displayNumberToId.get(note);
        if (!target) { warnings.push(`Supra target footnote (note ${note}) not found in this DOCX.`); return [null, path, warnings]; }
        const [part, warning] = supraTargetPart(target, text, byNote, note);
        path.push(`SUPRA→${note}:${part}`);
        if (warning) warnings.push(warning);
        const next = `${target}:${part}`;
        if (!byKey.has(next)) { warnings.push(`Supra target footnote (note ${note}) not found in this DOCX.`); return [null, path, warnings]; }
        current = next; continue;
      }
      if (isIbid(text)) {
        path.push("IBID");
        const index = order.indexOf(current);
        if (index <= 0) { warnings.push("Ibid appears as the first reference; no preceding reference exists."); return [null, path, warnings]; }
        current = order[index - 1]; continue;
      }
      return [current, path, warnings];
    }
    return [null, path, warnings];
  };

  rows.forEach((row, index) => {
    const text = row.citation_part_text.trim(), note = supraNoteNumber(text);
    if (note !== null) {
      row.ref_kind = "SUPRA";
      const target = displayNumberToId.get(note);
      if (target !== undefined) {
        row.ref_target_footnote_id = display(target);
        const [part] = supraTargetPart(target, text, byNote, note);
        row.ref_target_citation_part_index = part;
        row.ref_target_footnote_full = footnotes.get(target) ?? "";
        let targetText = byKey.get(`${target}:${part}`)?.citation_part_text ?? "";
        const hint = supraHint(text, true);
        if (hint) targetText = `${hint}, ${targetText}`;
        row.ref_target_citation_part_text = targetText;
      }
    } else if (isIbid(text)) {
      row.ref_kind = "IBID";
      const previous = index > 0 ? byKey.get(order[index - 1]) : undefined;
      if (previous) {
        row.ref_target_footnote_id = display(previous.footnote_id);
        row.ref_target_citation_part_index = previous.citation_part_index;
        row.ref_target_citation_part_text = previous.citation_part_text;
        row.ref_target_footnote_full = footnotes.get(previous.footnote_id) ?? "";
        if (previous.footnote_id !== row.footnote_id && (partsPerNote.get(previous.footnote_id) ?? 0) > 1)
          row.ref_resolution_notes = `${row.ref_resolution_notes} Previous footnote has multiple references; style guidance prefers supra over ibid in this situation.`.trim();
      }
    }
    const [origin, path, warnings] = follow(index);
    row.ref_chain_path = path.join(" → ");
    if (origin) {
      const found = byKey.get(origin)!;
      row.ref_chain_origin_footnote_id = display(found.footnote_id);
      row.ref_chain_origin_citation_part_index = found.citation_part_index;
      row.ref_chain_origin_citation_part_text = found.citation_part_text;
      if (found.first_page) row.first_page = found.first_page;
    }
    if (warnings.length) row.ref_resolution_notes = `${row.ref_resolution_notes} ${warnings.join(" ")}`.trim();
  });
}

const shortKey = (value: string) => (value ?? "").trim().replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
  .replace(/^[[({"'\s]+|[\])}"'\s]+$/gu, "").replace(/\s+/gu, " ").trim().replace(/\.+$/u, "").trim().toLowerCase();
const fragmentsOf = (value: string) => { try { return (JSON.parse(value || "[]") as unknown[]).map(String).filter((item) => item.trim()); } catch { return []; } };
const firstPage = (row: AlrRow) => { try { const pages = JSON.parse(row.page_pinpoints || "[]") as unknown[]; return pages.length ? Number(pages[0]) : null; } catch { return null; } };

/** A supra row takes its chain origin's source only when its own short form agrees with that origin. */
export function usesChainOrigin(row: AlrRow) {
  if (row.ref_kind !== "SUPRA") return true;
  const link = row.citation_part_link.trim();
  const reference = shortKey(row.short_form || supraHint(row.citation_part_text || row.citation_part_corrected, true));
  const originMatches = () => !reference || (!!shortKey(row._origin?.short_form ?? "") && shortKey(row._origin?.short_form ?? "") === reference);
  if (isUsableLink(link)) {
    const requested = fragmentsOf(row.pinpoint_fragments).map(normalizeAnchor), page = firstPage(row);
    if (!requested.length && page === null) return false;
    const fragment = normalizeAnchor(splitUrl(link)[1]);
    const agrees = !!fragment && (requested.length ? requested.includes(fragment) : fragment.startsWith("page="));
    return agrees ? false : originMatches();
  }
  if (reference) return originMatches();
  const hint = supraHint(row.citation_part_text || row.citation_part_corrected, true);
  const tokens = (hint.toLowerCase().match(/[a-z][a-z'-]*/gu) ?? []).filter((token) => token.length >= 3);
  const origin = new Set((row.ref_chain_origin_citation_part_text || row._origin?.bare_citation || "").toLowerCase().match(/[a-z][a-z'-]*/gu) ?? []);
  return !tokens.length || tokens.some((token) => origin.has(token));
}

/** Reference rows take their origin's link (re-anchored), journal identity and source text. */
export function applyChainOrigins(rows: AlrRow[]) {
  const byDisplay = new Map(rows.map((row) => [`${row.footnote_display_id}:${row.citation_part_index}`, row]));
  const byId = new Map(rows.map((row) => [`${row.footnote_id}:${row.citation_part_index}`, row]));
  for (const row of rows) {
    const id = String(row.ref_chain_origin_footnote_id ?? "").trim(), index = row.ref_chain_origin_citation_part_index;
    if (!id || index === "") continue;
    const origin = byDisplay.get(`${id}:${index}`) ?? byId.get(`${id}:${index}`);
    if (!origin || origin === row) continue;
    row._origin = { kind: origin.citation_part_kind, bare_citation: origin.bare_citation, link: origin.citation_part_link,
      short_form: origin.short_form, pinpoint_fragments: origin.pinpoint_fragments, journal_article_id: origin._journal_article_id,
      journal_link_resolved: origin._journal_link_resolved };
  }
  for (const row of rows) {
    if (row.ref_kind !== "IBID" && row.ref_kind !== "SUPRA") continue;
    if (!row._origin || !usesChainOrigin(row)) continue;
    const originLink = row._origin.link.trim();
    let effective = "";
    if (isUsableLink(originLink)) {
      const fragments = fragmentsOf(row.pinpoint_fragments), [base] = splitUrl(originLink);
      effective = fragments.length ? appendFirstPinpoint(base || originLink, fragments)
        : firstPage(row) !== null ? base || originLink : originLink;
    }
    // Registry and sibling links are more precise than a note-number chain; they stay.
    if (effective && !["registry", "sibling"].includes(row._ref_link_resolution))
      row.citation_part_link = reanchor(effective, row.citation_part_text);
    if (row._origin.journal_article_id) row._journal_article_id = row._origin.journal_article_id;
    if (row._origin.journal_link_resolved) row._journal_link_resolved = true;
  }
}
