import fs from "node:fs";
import path from "node:path";
import { cacheDir, decodeEntities, manifest, normalizeKey } from "./gap-lib.mjs";

export function pdfOnlyLink(html, baseUrl) {
  const card = html.match(/<div\b[^>]*\bdecisia-decision-pdf-only\b[^>]*>[\s\S]*?<\/div>/iu)?.[0];
  const href = card?.match(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/iu);
  const raw = href?.[1] ?? href?.[2];
  if (!raw) return null;
  try { return new URL(decodeEntities(raw), baseUrl).toString(); } catch { return null; }
}

const resolved = new Map();
export function resolveCachedSourceUrl(rawUrl) {
  if (resolved.has(rawUrl)) return resolved.get(rawUrl);
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "decisia.lexum.com" || !url.pathname.startsWith("/nsc/")) {
      resolved.set(rawUrl, rawUrl);
      return rawUrl;
    }
  } catch { return rawUrl; }
  const row = manifest.get(normalizeKey(rawUrl));
  if (!row?.file?.toLowerCase().endsWith(".html")) return rawUrl;
  const file = path.join(cacheDir, row.file);
  if (!fs.existsSync(file)) return rawUrl;
  const result = pdfOnlyLink(fs.readFileSync(file, "utf8"), rawUrl) ?? rawUrl;
  resolved.set(rawUrl, result);
  return result;
}
