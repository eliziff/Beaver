// Per-row census of one CourtListener bulk record: every markup item, every marker-like
// token in text, and the line shapes of each rendition. Returns one compact sidecar object;
// aggregation by court, decade and source happens later, from the sidecars.

export const OPINION_RENDITIONS = ['plain_text', 'html', 'html_lawbox', 'html_columbia', 'html_anon_2020',
  'xml_harvard', 'xml_scan', 'html_with_citations'];
export const CLUSTER_TEXT_FIELDS = ['judges', 'procedural_history', 'attorneys', 'nature_of_suit', 'posture',
  'syllabus', 'headnotes', 'summary', 'disposition', 'history', 'other_dates', 'cross_reference', 'correction',
  'arguments', 'headmatter'];

/** A value's shape: letter runs a/A, digit runs 9, other characters kept, first 32 characters. */
export function shape(value) {
  return value.slice(0, 48).replace(/[a-z]+/g, 'a').replace(/[A-Z]+/g, 'A').replace(/[0-9]+/g, '9')
    .replace(/\s+/g, ' ').slice(0, 32);
}

const inc = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };

// Markup: comments, declarations, processing instructions, CDATA, start/end tags, entities.
const MARKUP = /<!--([\s\S]*?)-->|<!\[CDATA\[[\s\S]*?\]\]>|<!([A-Za-z]+)[^>]*>|<\?([A-Za-z][\w:-]*)[^>]*\?>|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;
const ATTR = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

const FREE_TEXT_ATTRS = new Set(['aria-description', 'title', 'alt', 'aria-label']);
const hrefShape = (v) => { const m = v.match(/^([a-z]+:\/\/[^/]+)?(\/?[^/?#]*)?/i); return (m?.[1] ? m[1].replace(/^[a-z]+:\/\//i, '') : '') + shape(m?.[2] ?? '') + (v.includes('#') ? '#' : ''); };

/** Every markup item of a markup string, counted: <tag, /tag, tag.class, tag@attr, tag@attr=shape, &entity;, comments. */
export function markupTokens(s) {
  const tok = {};
  MARKUP.lastIndex = 0; let m;
  while ((m = MARKUP.exec(s))) {
    if (m[1] !== undefined) { inc(tok, '<!--' + shape(m[1].trim()) + '-->'); continue; }
    if (m[0].startsWith('<![CDATA[')) { inc(tok, '<![CDATA['); continue; }
    if (m[2] !== undefined) { inc(tok, '<!' + m[2].toLowerCase()); continue; }
    if (m[3] !== undefined) { inc(tok, '<?' + m[3]); continue; }
    if (m[5] !== undefined) {
      const name = m[5];
      if (m[4]) { inc(tok, '</' + name); continue; }
      inc(tok, '<' + name);
      const attrs = m[6];
      if (attrs && attrs.trim() && attrs.trim() !== '/') {
        ATTR.lastIndex = 0; let a;
        while ((a = ATTR.exec(attrs))) {
          const an = a[1]; if (an === '/') continue;
          const v = a[2] ?? a[3] ?? a[4];
          inc(tok, name + '@' + an);
          if (v !== undefined) {
            if (an === 'class') for (const c of v.split(/\s+/)) { if (c) inc(tok, name + '.' + c); }
            if (!FREE_TEXT_ATTRS.has(an)) inc(tok, name + '@' + an + '=' + (an === 'href' || an === 'src' ? hrefShape(v) : shape(v)));
          }
        }
      }
      if (/\/\s*$/.test(attrs ?? '')) inc(tok, name + '/>');
      continue;
    }
    if (m[7] !== undefined) inc(tok, '&' + (m[7][0] === '#' ? numericEntity(m[7]) : m[7]) + ';');
  }
  return tok;
}
function numericEntity(e) {
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return '#U+' + (Number.isFinite(cp) ? cp.toString(16).toUpperCase().padStart(4, '0') : '?');
}

// Text projection of markup: block boundaries become newlines; other tags vanish; common entities decode.
const BLOCK = /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|pre|center|footnote|footnotes|opinion|author|judges|parties|docketnumber|court|decisiondate|otherdate|attorneys|syllabus|summary|headnotes|history|disposition|correction|seealso|heading|casebody|headmatter|section|article|dd|dt|dl|hr|body|html|title)\b[^>]*>/gi;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', sect: '§', para: '¶', mdash: '—', ndash: '–' };
export function textOf(markup) {
  return markup.replace(/<!--[\s\S]*?-->/g, '').replace(BLOCK, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (all, e) => {
      if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return all; } }
      return ENT[e] ?? all;
    });
}

// Marker-like token families in text. Each counted in total and at line start (":ls").
export const FAMILIES = [
  ['bracket_star', /\[\*+\s?\d{1,5}\]/g],
  ['star_page_word', /\*\s?Page\s+\d{1,5}/g],
  ['double_star', /(?<![\w*])\*\*\s?\d{1,5}(?!\d)/g],
  ['star_n', /(?<![\w*\[])\*\s?\d{1,5}(?![\d\]])/g],
  ['bracket_pilcrow', /\[¶\s*\d+(?:\.\d+)?\.?\]/g],
  ['brace_pilcrow', /\{¶\s*\d+(?:\.\d+)?\.?\}/g],
  ['mojibake_pilcrow', /Â¶\s*\d*/g],
  ['pilcrow_n', /(?<![\[{Â])¶\s*\d+/g],
  ['pilcrow_other', /(?<![\[{Â])¶(?!\s*\d)/g],
  ['section_sign', /§+/g],
  ['bracket_n', /\[\d{1,4}\]/g],
  ['brace_n', /\{\d{1,4}\}/g],
  ['bracket_fn', /\[(?:fn|FN|Fn)\s?\d+\]/g],
  ['fn_n', /\bFN\s?\d+\b/g],
  ['page_n_of_m', /\bPage\s+\d+\s+of\s+\d+\b/gi],
  ['ct_page', /\bCT\s+Page\s+\d+/g],
  ['ecf_stamp', /Case\s+[\w:.\-]+\s+Document\s+[\w\-]+\s+Filed\s+[\d\/.\-]+\s+Page\s+\d+\s+of\s+\d+/g],
  ['continued', /\((?:continued|Continued|CONTINUED)[.…]*\)/g],
  ['cite_as', /\[Cite as [^\]]{0,120}\]/g],
  ['slip_op', /\bSlip Op(?:inion)?\.?\b/g],
];
// Whole-line families (tested per line, trimmed).
export const LINE_FAMILIES = [
  ['line_dash_n_dash', /^-\s?\d{1,4}\s?-$/],
  ['line_bare_number', /^\d{1,4}$/],
  ['line_page_n', /^Page\s+\d{1,4}$/i],
  ['line_roman_label', /^[IVXLC]{1,7}\.?$/],
  ['line_letter_label', /^[A-Z]\.?$/],
  ['line_paren_label', /^\(?(?:[a-z]{1,2}|\d{1,3}|[ivx]{1,5})\)$/],
  ['line_number_label', /^\d{1,3}\.$/],
  ['line_star_n', /^\*\s?\d{1,5}$/],
  ['line_bracket_star', /^\[\*+\s?\d{1,5}\]$/],
  ['line_bracket_n', /^\[\d{1,4}\]$/],
  ['line_all_caps', /^[^a-z]*[A-Z]{3,}[^a-z]*$/],
];
// Line-start labels (prefix of a longer line).
export const LEADING = [
  ['lead_roman', /^[IVXLC]{1,7}\.\s/],
  ['lead_letter', /^[A-Z]\.\s/],
  ['lead_paren', /^\((?:[a-z]{1,2}|\d{1,3}|[ivx]{1,5})\)\s/],
  ['lead_number', /^\d{1,3}\.\s/],
  ['lead_bracket_n', /^\[\d{1,4}\]\s?/],
  ['lead_star', /^\*\s?\d{1,5}\s/],
  ['lead_pilcrow', /^[\[{]?¶\s*\d+/],
  ['lead_footnote_n', /^\d{1,3}\s+[A-Z]/],
];

/** Marker families, line families, open-ended line-start shapes, repeated lines and short lines of a text. */
export function textCensus(text) {
  const mk = {}; let firstStar = -1;
  for (const [name, re] of FAMILIES) {
    re.lastIndex = 0; let m, n = 0;
    while ((m = re.exec(text))) {
      n++;
      if (name === 'star_n' || name === 'bracket_star' || name === 'star_page_word') {
        if (firstStar < 0 || m.index < firstStar) firstStar = m.index;
      }
      let k = m.index - 1; while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
      if (k < 0 || text[k] === '\n') inc(mk, name + ':ls');
    }
    if (n) inc(mk, name, n);
  }
  const lines = text.split('\n');
  const ls = {}, short = {}, seen = new Map();
  let nonEmpty = 0;
  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ').trim();
    if (!line) continue;
    nonEmpty++;
    for (const [name, re] of LINE_FAMILIES) if (re.test(line)) inc(mk, name);
    for (const [name, re] of LEADING) if (re.test(line)) inc(mk, name);
    const first = line.split(/\s/, 1)[0];
    if (first.length <= 8 && /[^A-Za-z]/.test(first)) inc(ls, shape(first));
    if (line.length <= 30) inc(short, shape(line));
    const norm = line.length <= 120 ? line.replace(/\d+/g, '9').replace(/\s+/g, ' ') : null;
    if (norm) seen.set(norm, (seen.get(norm) ?? 0) + 1);
  }
  const rep = {};
  for (const [k, v] of seen) if (v >= 3) rep[k.slice(0, 80)] = v;
  return { mk, ls: top(ls, 40), short: top(short, 40), rep: top(rep, 15), lines: nonEmpty,
    firstStar, textLen: text.length };
}
function top(map, n) {
  const e = Object.entries(map); if (e.length <= n) return e.length ? map : undefined;
  e.sort((a, b) => b[1] - a[1]); const o = Object.fromEntries(e.slice(0, n)); o['…more'] = e.length - n; return o;
}

/** One rendition/field: bytes, markup tokens (markup fields), text census. */
export function fieldCensus(value, isMarkup) {
  const o = { b: Buffer.byteLength(value) };
  if (isMarkup) o.tok = markupTokens(value);
  const text = isMarkup ? textOf(value) : value;
  Object.assign(o, textCensus(text));
  if (o.firstStar >= 0) o.preStar = o.firstStar; delete o.firstStar;
  return o;
}

/** Plain text that nonetheless carries markup-like tags or entities. */
const looksMarked = (s) => /<\/?[A-Za-z][\w:-]*[\s>\/]|&(?:#\d+|[a-z]+);/.test(s.slice(0, 200000));

export function opinionCensus(cols, f) {
  const g = (k) => f[cols[k]];
  const R = {};
  for (const r of OPINION_RENDITIONS) {
    const v = g(r);
    if (v === null || v === undefined) continue;
    if (v === '') { R[r] = { b: 0 }; continue; }
    const markup = r !== 'plain_text';
    R[r] = fieldCensus(v, markup);
    if (!markup && looksMarked(v)) R[r].tok = markupTokens(v);
  }
  const dl = g('download_url');
  return { id: Number(g('id')), cl: Number(g('cluster_id')), ty: g('type'), ocr: g('extracted_by_ocr'),
    pc: g('page_count'), au: g('author_id') !== null, pcur: g('per_curiam'),
    dl: dl === null ? null : dl === '' ? '' : (dl.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] ?? shape(dl)),
    dlx: dl ? (dl.match(/\.([A-Za-z0-9]{1,5})(?:[?#]|$)/)?.[1]?.toLowerCase() ?? '') : undefined,
    lp: g('local_path') === null ? null : g('local_path') === '' ? '' : (g('local_path').match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? 'other'),
    R };
}

export function clusterCensus(cols, f) {
  const g = (k) => f[cols[k]];
  const F = {};
  for (const k of CLUSTER_TEXT_FIELDS) {
    const v = g(k);
    if (v === null || v === undefined) continue;
    if (v === '') { F[k] = { b: 0 }; continue; }
    F[k] = fieldCensus(v, true);
  }
  return { id: Number(g('id')), dk: Number(g('docket_id')), df: g('date_filed'), dfa: g('date_filed_is_approximate'),
    src: g('source'), ps: g('precedential_status'), jh: g('filepath_json_harvard'), ph: g('filepath_pdf_harvard'),
    cc: g('citation_count'), slug: g('slug'), F };
}

export function docketCensus(cols, f) {
  const g = (k) => f[cols[k]];
  return { id: Number(g('id')), court: g('court_id'), src: g('source') };
}
