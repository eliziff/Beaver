import { normalizeWhitespace } from "./text";

type UpstreamPdfLink = {
  url: string;
  label?: string | null;
  mediaType?: string | null;
  rel?: string | null;
};

export type OriginalPdfCandidateInput = {
  canonicalUrl: string;
  upstreamLinks?: readonly UpstreamPdfLink[];
  markup?: string | null;
};

export type OriginalPdfCandidate = {
  url: string;
  label: string | null;
  source: "canonical" | "metadata" | "markup";
  score: number;
  reasons: string[];
};

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

type CandidateSource = OriginalPdfCandidate["source"];
type RankedCandidate = OriginalPdfCandidate & {
  position: number;
};

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  canonical: 3,
  metadata: 2,
  markup: 1,
};

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

function classValue(attributes: string) {
  const match = attributes.match(
    /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
  );
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
    if (classValue(match[1]).split(/\s+/u).includes("documents")) {
      documentControls.push(match[2]);
    }
  }
  const url = controlledDecisiaPdfUrl(documentControls, source);
  return url ? { url, pdfOnly: false } : null;
}

function pdfScore(
  url: URL,
  baseUrl: URL,
  label: string,
  mediaType = "",
) {
  const path = url.pathname.toLowerCase();
  const clue = `${label} ${url.pathname} ${url.search}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (path.endsWith(".pdf")) {
    score += 50;
    reasons.push("pdf-extension");
  }
  if (path.includes("/document.do")) {
    score += 90;
    reasons.push("document-endpoint");
  }
  if (
    ["download pdf", "view pdf", "full text pdf", "full-text pdf"].some(
      (phrase) => clue.includes(phrase),
    )
  ) {
    score += 80;
    reasons.push("explicit-pdf-label");
  } else if (
    ["download", "viewcontent", "article/view", "galley"].some((phrase) =>
      clue.includes(phrase),
    )
  ) {
    score += 35;
    reasons.push("download-endpoint");
  } else if (label.trim().toLowerCase() === "pdf") {
    score += 60;
    reasons.push("pdf-label");
  }
  if (mediaType.toLowerCase().split(";", 1)[0].trim() === "application/pdf") {
    score += 100;
    reasons.push("pdf-media-type");
  }
  if (url.host.toLowerCase() === baseUrl.host.toLowerCase()) {
    score += 15;
    reasons.push("same-origin");
  }
  return { score, reasons };
}

function markupLinks(markup: string): UpstreamPdfLink[] {
  const links: UpstreamPdfLink[] = [];
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    const href = match[1].match(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const url = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!url) continue;
    links.push({
      url,
      label: plainInlineText(match[2]),
    });
  }
  return links;
}

/**
 * Derive and rank plausible original PDFs without performing network I/O.
 *
 * Upstream provider adapters normalize their URL metadata into `upstreamLinks`.
 * Raw landing-page markup is inspected only for anchor destinations.
 */
export function deriveOriginalPdfCandidates(
  input: OriginalPdfCandidateInput,
): OriginalPdfCandidate[] {
  const canonical = httpUrl(input.canonicalUrl);
  if (!canonical) return [];
  const candidates = new Map<string, RankedCandidate>();
  let position = 0;

  const add = (
    rawUrl: string | URL,
    source: CandidateSource,
    label = "",
    mediaType = "",
  ) => {
    const url =
      rawUrl instanceof URL ? new URL(rawUrl) : httpUrl(rawUrl, canonical);
    if (!url) return;
    const normalizedLabel = plainInlineText(label);
    const { score, reasons } = pdfScore(
      url,
      canonical,
      normalizedLabel,
      mediaType,
    );
    if (score < 50) return;
    const key = url.toString();
    const candidate: RankedCandidate = {
      url: key,
      label: normalizedLabel || null,
      source,
      score,
      reasons,
      position: position++,
    };
    const existing = candidates.get(key);
    if (!existing) {
      candidates.set(key, candidate);
      return;
    }
    const preferredSource =
      SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
        ? candidate
        : existing;
    candidates.set(key, {
      ...preferredSource,
      label: preferredSource.label ?? existing.label ?? candidate.label,
      score: Math.max(existing.score, candidate.score),
      reasons: [...new Set([...existing.reasons, ...candidate.reasons])],
      position: Math.min(existing.position, candidate.position),
    });
  };

  add(canonical, "canonical");
  for (const link of input.upstreamLinks ?? []) {
    add(link.url, "metadata", link.label ?? link.rel ?? "", link.mediaType ?? "");
  }
  const decisia = decisiaIndexUrl(canonical);
  if (decisia) {
    const pdf = verifiedDecisiaPdf(input.markup ?? "", decisia);
    if (pdf) add(pdf.url, "markup", "PDF");
  } else for (const link of markupLinks(input.markup ?? "")) {
      add(link.url, "markup", link.label ?? "");
    }

  return [...candidates.values()]
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source] ||
        right.score - left.score ||
        left.position - right.position ||
        left.url.localeCompare(right.url),
    )
    .map(({ position: _position, ...candidate }) => candidate);
}
