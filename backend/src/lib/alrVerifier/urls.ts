// Link handling ALR applies to citation links (alr_quote_verifier.py _split_url, _sanitize_url_candidate,
// _canlii_source_lookup_url, _append_first_pinpoint_fragment, _strip_invalid_page_fragment and kin).
import { isCanliiUrl } from "mike/shared/runtime/canliiPageUrls.mjs";

const TRAILING_URL_PUNCT = /[.,;:!?)\]}>"'“”’‘]+$/u;

export function splitUrl(url: string): [string, string] {
  const value = (url ?? "").trim();
  if (!value) return ["", ""];
  const hash = value.indexOf("#");
  return hash < 0 ? [value, ""] : [value.slice(0, hash), value.slice(hash + 1)];
}
export const recombineUrl = (base: string, fragment: string) =>
  !base ? "" : fragment.replace(/^#+/u, "") ? `${base}#${fragment.replace(/^#+/u, "")}` : base;
export const isCanlii = (url: string) => isCanliiUrl(url ?? "");
const path = (url: string) => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } };
export const host = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } };

/** CanLII .pdf links become their .html page (anchors exist only there), except #page=N links. */
export function canliiPdfToHtml(url: string) {
  const [base, fragment] = splitUrl(url);
  if (!base || !isCanlii(base) || !path(base).endsWith(".pdf") || /^page=-?\d+$/iu.test(fragment.trim())) return url;
  return recombineUrl(base.replace(/\.pdf$/iu, ".html"), fragment);
}
/** The URL in a mixed string, without sentence punctuation after it. */
export function sanitizeUrl(raw: string) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const found = /https?:\/\/\S+/iu.exec(value);
  return canliiPdfToHtml((found ? found[0] : value.split(/\s+/u)[0]).replace(TRAILING_URL_PUNCT, ""));
}
/** CanLII URLs as their HTML page without PDF page markers. */
export function canliiLookupUrl(url: string) {
  const [base, fragment] = splitUrl(url);
  if (!base || !isCanlii(base)) return url;
  const html = path(base).endsWith(".pdf") ? recombineUrl(base.replace(/\.pdf$/iu, ".html"), fragment) : url;
  const [htmlBase, htmlFragment] = splitUrl(html);
  return /^page=-?\d+$/iu.test(htmlFragment.trim()) ? htmlBase : html;
}
export function normalizeAnchor(fragment: string) {
  const value = (fragment ?? "").trim().replace(/^#+/u, "");
  return value.replace(/^[.,;:!?)\]}>"'“”’‘]+|[.,;:!?)\]}>"'“”’‘]+$/gu, "").replace(/\s+/gu, "");
}
const usable = (link: string) => !!link && link.toLowerCase() !== "other";
export const isUsableLink = usable;

/** Adds the first par/sec pinpoint as a CanLII anchor when the link has none. */
export function appendFirstPinpoint(link: string, fragments: readonly string[]) {
  const candidate = sanitizeUrl(link);
  if (!usable(candidate)) return link;
  const [base, existing] = splitUrl(candidate);
  if (!base || existing || !isCanlii(base) || path(base).endsWith(".pdf")) return link;
  const first = fragments.map(normalizeAnchor).find(Boolean) ?? "";
  if (first.startsWith("par") && path(base).includes("/doc/")) return recombineUrl(base, first);
  if (first.startsWith("sec") && path(base).includes("/laws/")) return recombineUrl(base, first);
  return link;
}
export function stripInvalidPageFragment(url: string) {
  const [base, fragment] = splitUrl(url);
  const page = /^page=(-?\d+)$/iu.exec(fragment.trim());
  return page && Number(page[1]) < 1 ? base : url;
}
/** "2023 SCC 17" from a CanLII decision URL slug (…/doc/2023/2023scc17/…). */
export function canliiDocCitation(url: string) {
  const candidate = canliiLookupUrl(sanitizeUrl(url ?? ""));
  if (!isCanlii(candidate)) return "";
  const slug = /\/doc\/\d{4}\/((\d{4})([a-z]+)(\d+))\//iu.exec(candidate);
  if (!slug) return "";
  return `${slug[2]} ${slug[3].toLowerCase() === "canlii" ? "CanLII" : slug[3].toUpperCase()} ${slug[4]}`;
}
