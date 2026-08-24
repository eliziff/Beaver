import fs from "node:fs";
import path from "node:path";
import { cacheDir, decodeEntities, manifest, normalizeKey } from "./gap-lib.mjs";

const decisiaHosts = new Set([
  "coadecisions.ontariocourts.ca", "decisia.lexum.com", "decision.tcc-cci.gc.ca",
  "decisions.cart-crac.gc.ca", "decisions.chrt-tcdp.gc.ca", "decisions.citt-tcce.gc.ca",
  "decisions.cmac-cacm.ca", "decisions.ct-tc.gc.ca", "decisions.fca-caf.gc.ca",
  "decisions.fct-cf.gc.ca", "decisions.fpslreb-crtespf.gc.ca",
  "decisions.psdpt-tpfd.gc.ca", "decisions.scc-csc.ca", "decisions.sct-trp.ca",
  "decisions.sst-tss.gc.ca", "decisions.tatc.gc.ca",
]);

function classValue(attributes) {
  const match = attributes.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function documentLink(control, source) {
  for (const match of control.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))[^>]*>/giu,
  )) {
    try {
      const candidate = new URL(decodeEntities(match[1] ?? match[2] ?? match[3]), source);
      if (candidate.origin === source.origin && /\/document\.do$/iu.test(candidate.pathname)) {
        return candidate.toString();
      }
    } catch {}
  }
  return null;
}

export function decisiaPdfEvidence(html, baseUrl) {
  let source;
  try { source = new URL(baseUrl); } catch { return null; }
  if (source.protocol !== "https:" || source.port || !decisiaHosts.has(source.hostname) ||
      !/\/item\/\d+\/index\.do$/iu.test(source.pathname)) return null;
  // The explicit control wins even when Decisia also renders a generic
  // documents control for the same PDF.
  for (const match of html.matchAll(
    /<([a-z][\w:-]*)\b([^>]*\bdecisia-decision-pdf-only\b[^>]*)>([\s\S]*?)<\/\1\s*>/giu,
  )) {
    const url = documentLink(match[3], source);
    if (url) return { url, pdfOnly: true };
  }
  for (const match of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/giu)) {
    if (!classValue(match[1]).split(/\s+/u).includes("documents")) continue;
    const url = documentLink(match[2], source);
    if (url) return { url, pdfOnly: false };
  }
  return null;
}

/** `undefined` is a cache miss; `null` is a cached index with no PDF control. */
export function cachedDerivedPdfEvidence(rawUrl) {
  let source;
  try { source = new URL(rawUrl); } catch { return undefined; }
  if (!decisiaHosts.has(source.hostname) || !/\/item\/\d+\/index\.do$/iu.test(source.pathname)) {
    return null;
  }
  const row = manifest.get(normalizeKey(rawUrl));
  if (!row?.file?.toLowerCase().endsWith(".html")) return undefined;
  const file = path.join(cacheDir, row.file);
  if (!fs.existsSync(file)) return undefined;
  return decisiaPdfEvidence(fs.readFileSync(file, "utf8"), rawUrl);
}
