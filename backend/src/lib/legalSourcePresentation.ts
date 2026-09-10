import { normalizeWhitespace } from "./text";

export type VerifiedPdfEvidence = {
  url: string;
  pdfOnly: boolean;
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (match, code: string) => {
      const value = Number.parseInt(code, 10);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&#x([0-9a-f]+);/giu, (match, code: string) => {
      const value = Number.parseInt(code, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    });
}

export function plainInlineText(value: string) {
  return normalizeWhitespace(decodeHtmlEntities(value
    .replace(/<script\b[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/giu, " ")
    .replace(/\[([^\]\r\n]+)\]\([^)\r\n]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\\([\\`*_{}\[\]()#+.!>~-])/gu, "$1")
    .replace(/[*_`~]/gu, "")));
}

function httpUrl(rawUrl: string, baseUrl?: URL) {
  try {
    const url = new URL(decodeHtmlEntities(rawUrl.trim()), baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

const DECISIA_HOSTS = new Set([
  "coadecisions.ontariocourts.ca",
  "decisia.lexum.com",
  "decision.tcc-cci.gc.ca",
  "decisions.cart-crac.gc.ca",
  "decisions.chrt-tcdp.gc.ca",
  "decisions.citt-tcce.gc.ca",
  "decisions.cmac-cacm.ca",
  "decisions.ct-tc.gc.ca",
  "decisions.fca-caf.gc.ca",
  "decisions.fct-cf.gc.ca",
  "decisions.fpslreb-crtespf.gc.ca",
  "decisions.psdpt-tpfd.gc.ca",
  "decisions.scc-csc.ca",
  "decisions.sct-trp.ca",
  "decisions.sst-tss.gc.ca",
  "decisions.tatc.gc.ca",
]);

export function decisiaIndexUrl(rawUrl: string | URL) {
  const source = httpUrl(String(rawUrl));
  if (!source || source.protocol !== "https:" || source.port ||
      !DECISIA_HOSTS.has(source.hostname.toLowerCase()) ||
      !/\/item\/\d+\/index\.do$/iu.test(source.pathname)) return null;
  source.search = "";
  source.hash = "";
  return source;
}

/** One attribute's value in any quoting style; "" when the attribute is absent. */
const attributePattern = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "iu");

const CLASS_ATTRIBUTE = attributePattern("class");
const HREF_ATTRIBUTE = attributePattern("href");
const SRC_ATTRIBUTE = attributePattern("src");

function attributeValue(attributes: string, pattern: RegExp) {
  const match = attributes.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function controlledDecisiaPdfUrl(controls: string[], source: URL) {
  for (const control of controls) {
    for (const link of markupLinks(control)) {
      const candidate = httpUrl(link.url, source);
      if (candidate?.origin === source.origin &&
          /\/document\.do$/iu.test(candidate.pathname)) return candidate.toString();
    }
  }
  return null;
}

/** Read only Decisia's representation controls, never judgment-body links. */
export function verifiedDecisiaPdf(
  markup: string,
  rawUrl: string | URL,
): VerifiedPdfEvidence | null {
  const source = decisiaIndexUrl(rawUrl);
  if (!source) return null;
  const pdfOnlyControls = [...markup.matchAll(
    /<([a-z][\w:-]*)\b([^>]*\bdecisia-decision-pdf-only\b[^>]*)>([\s\S]*?)<\/\1\s*>/giu,
  )].map((match) => match[3]);
  const pdfOnlyUrl = controlledDecisiaPdfUrl(pdfOnlyControls, source);
  if (pdfOnlyUrl) return { url: pdfOnlyUrl, pdfOnly: true };

  const documentControls: string[] = [];
  for (const match of markup.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/giu)) {
    if (attributeValue(match[1], CLASS_ATTRIBUTE).split(/\s+/u).includes("documents")) {
      documentControls.push(match[2]);
    }
  }
  const url = controlledDecisiaPdfUrl(documentControls, source);
  return url ? { url, pdfOnly: false } : null;
}

function markupLinks(markup: string) {
  const links: { url: string; label: string }[] = [];
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    const url = attributeValue(match[1], HREF_ATTRIBUTE);
    if (!url) continue;
    links.push({
      url,
      label: plainInlineText(match[2]),
    });
  }
  return links;
}

/** Ranks explicit publisher download controls; callers still validate the response as PDF. */
export function rankedPublisherPdfLinks(markup: string, rawUrl: string | URL) {
  const source = httpUrl(String(rawUrl));
  if (!source) return [];
  const links = markupLinks(markup).map((link) => ({ ...link, frame: false }));
  for (const match of markup.matchAll(/<iframe\b([^>]*)>/giu)) {
    const url = attributeValue(match[1], SRC_ATTRIBUTE);
    if (url) links.push({ url, label: "", frame: true });
  }
  return links.map(({ url: raw, label, frame }, position) => {
    const url = httpUrl(raw, source);
    if (!url) return null;
    const clue = `${label} ${url.pathname} ${url.search}`.toLowerCase();
    let score = url.pathname.toLowerCase().endsWith(".pdf") ? 50 : 0;
    if (frame && url.origin === source.origin && url.pathname === source.pathname &&
        url.searchParams.get("iframe") === "true") score += 90;
    if (url.pathname.toLowerCase().includes("/document.do")) score += 90;
    if (/download pdf|view pdf|full[- ]text pdf/u.test(clue)) score += 80;
    else if (/download|viewcontent|article\/view|galley/u.test(clue)) score += 35;
    else if (label.toLowerCase() === "pdf") score += 60;
    if (url.origin === source.origin) score += 15;
    return score >= 50 ? { score, position, url: url.toString() } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .map(({ url }) => url);
}
