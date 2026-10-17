// Which authority a PDF a reader downloaded is, for Authorities and Authorities-lite alike: the
// matcher Authorities-lite v0.3.3 validated (103 of 105 judgments right, none wrong, no OCR).
// `call(method, request)` is the legal-structure citation engine; `pages` are the PDF's opening
// pages as native text lines ({ lines: [{ text }], marginText }), never recognized text.

// CanLII names its PDFs by neutral citation (2019abqb666.pdf); browsers append " (1)" to repeats.
export const CANLII_PDF_NAME = /^(\d{4})([a-z]{2,10})(\d+)(?: ?\(\d+\))?\.pdf$/iu;
const REPORTER_PDF_NAME = /^(\d{4})(scr|rcs)(\d*)_(\d+)(?: ?\(\d+\))?\.pdf$/iu;
const key = (call, text) => call('keyForText', { text: String(text || '') }).key;
const extract = (call, text) => call('extract', { text, offsetUnit: 'utf16', options: { resolve: false, parallel: false } }).citations;

/** The citation a CanLII filename names; CanLII IDs and neutral court codes have different keys. */
export function canliiFileCitation(name) {
  const match = CANLII_PDF_NAME.exec(name);
  return match ? `${match[1]} ${match[2].toLowerCase() === 'canlii' ? 'CanLII' : match[2].toUpperCase()} ${match[3]}` : null;
}

/** Native text written vertically at a page's side margin, before any citation parsing. */
export function rotatedMarginText(items, viewport, Util) {
  const reading = viewport.rotation ? viewport.clone({ rotation: 0 }) : viewport;
  let text = '';
  for (const item of items) {
    if (!('str' in item)) continue;
    const transform = Util.transform(reading.transform, item.transform), x = transform[4];
    if (!(Math.abs(transform[1]) > Math.abs(transform[0]) * 4) || !(x >= 0 && x <= reading.width) ||
        x > reading.width * .12 && x < reading.width * .88) continue;
    text += `${item.str}${item.hasEOL ? '\n' : ' '}`;
    if (text.length >= 5000) return text.slice(0, 5000).trim();
  }
  return text.trim();
}

/** The first page before its first numbered paragraph. */
export function headerText(pages) {
  let text = '';
  for (const line of pages[0]?.lines || []) {
    if (/^\s*(?:\[1\]|1[.)])\s/u.test(line.text)) break;
    text += `${line.text}\n`;
    if (text.length > 5000) break;
  }
  return text;
}
export function headerIdentities(pages, call) {
  const text = headerText(pages);
  const citations = text ? extract(call, text).filter(c => c.form === 'full' && ['neutral', 'can_lii', 'reporter'].includes(c.format)) : [];
  // CanLII's rotated margin stamp can follow the body in PDF reading order.
  if (!citations.some(c => ['neutral', 'can_lii'].includes(c.format)) && pages.length > 1) {
    const repeated = new Set((pages[1].marginText || '').split('\n').map(text => text.trim()));
    for (const line of new Set((pages[0].marginText || '').split('\n').map(text => text.trim()).filter(text => text && repeated.has(text)))) {
      const found = extract(call, line);
      if (found.length !== 1) continue;
      const citation = found[0], tail = line.slice(citation.span.end).trim();
      if (citation.form === 'full' && citation.format === 'can_lii' && citation.span.start === 0 &&
          (!tail || citation.parentheticals.some(part => part.kind === 'court' && part.span.text === tail))) citations.push(citation);
    }
  }
  return citations.map(c => ({ ...c.span, key: c.key, family: c.format }));
}
// Supreme Court publisher PDFs are the bilingual S.C.R./R.C.S. print: page one opens with a running head such as
// "[2019] 4 R.C.S. / CANADA c. VAVILOV / 653", which carries no neutral citation. Accept it only when the volume
// and first page (and the year, when the citation keeps it) equal one of the record's own S.C.R. citations.
function scrRunningHead(pages, citations, call) {
  const head = (pages[0]?.lines || []).slice(0, 6).map(line => line.text).join(' ');
  return call('matchesReporterHeader', { text: head, citations });
}
/** Throws unless the opening names `record` ({ citation, aliases }). */
export function verifyIdentity(pages, record, call) {
  const aliases = record.aliases.flatMap(alias => extract(call, alias));
  const identities = headerIdentities(pages, call), accepted = new Set(aliases.map(c => c.key).filter(Boolean));
  const own = identities.filter(i => i.family === 'neutral');
  const candidates = own.length ? own.slice(0, 1) : identities;
  if ((!own.length || !aliases.some(c => c.format === 'neutral')) && scrRunningHead(pages, aliases, call)) return;
  if (!candidates.some(i => i.key && accepted.has(i.key))) throw new Error(own.length
    ? `Wrong PDF: its opening citation is ${own[0].text}, not ${record.citation}.`
    : 'The opening citation could not be verified. Keep this file unbound and check its first page.');
}

const words = text => String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
export const referenceText = text => ` ${words(text).join(' ')} `;
const normalized = new WeakMap();

/** The one record ({ citation, aliases }) among those still without a PDF that a downloaded PDF
 *  is, with how it was told, or null. The filename is a routing hint for a scan; native text, when
 *  there is any, must agree on its own: a unique opening citation, else exact agreement with a
 *  record's reference text, which `reference(record)` gives only when it is needed. */
export async function matchFolderPdf(filename, pages, records, call, reference = record => record.referenceText) {
  const named = canliiFileCitation(filename), reporter = REPORTER_PDF_NAME.exec(filename);
  // The engine reads court codes in capitals only: 2019abqb666.pdf is 2019 ABQB 666.
  const nameKey = key(call, named ?? (reporter ? `[${reporter[1]}] ${reporter[3]} ${reporter[2].toUpperCase()} ${reporter[4]}` : filename.replace(/\.pdf$/iu, '')));
  const namedRecords = nameKey ? records.filter(r => r.aliases.some(a => key(call, a) === nameKey)) : [];
  const tokens = words(pages.map(p => p.lines.map(l => l.text).join('\n')).join('\n'));
  if (tokens.length < 12) return namedRecords.length === 1 ? { record: namedRecords[0], method: 'filename' } : null;
  const header = headerIdentities(pages, call), neutral = header.filter(c => c.family === 'neutral');
  const identities = new Set((neutral.length ? neutral.slice(0, 1) : header).map(c => c.key).filter(Boolean));
  const candidates = records.filter(r => r.aliases.some(a => identities.has(key(call, a))));
  const verified = candidates.filter(r => { try { verifyIdentity(pages, r, call); return true; } catch { return false; } });
  if (verified.length === 1) return { record: verified[0], method: 'citation' };
  if (verified.length > 1 || neutral.length) return null;
  // Exact opening-text agreement; never pick a best fuzzy score. Require a majority
  // and at least two phrases unique among the pending authorities' reference texts.
  const phrases = [...new Set(Array.from({ length: Math.floor(Math.min(tokens.length, 1200) / 12) },
    (_, i) => ` ${tokens.slice(i * 12, i * 12 + 12).join(' ')} `))];
  const references = await Promise.all(records.map(async (record) => {
    if (!normalized.has(record)) normalized.set(record, referenceText(await reference(record)));
    return normalized.get(record);
  }));
  const matches = references.map(ref => phrases.map(p => ref.includes(p)));
  const supported = records.filter((_, i) => {
    const count = matches[i].filter(Boolean).length;
    const unique = matches[i].filter((yes, j) => yes && !matches.some((other, k) => k !== i && other[j])).length;
    return count > phrases.length / 2 && unique >= 2;
  });
  return supported.length === 1 ? { record: supported[0], method: 'text' } : null;
}
