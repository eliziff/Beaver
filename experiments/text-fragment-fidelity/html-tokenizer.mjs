import fs from "node:fs";
import path from "node:path";
import { readLines, parse, normalizeKey, manifest, manifestFolded, cacheDir, decodeEntities } from "./gap-lib.mjs";

// Walk HTML and produce an array of {text, boundaryBefore: tag|null} segments.
// Block-level boundaries: </p>, </li>, </blockquote>, </h1-6>, </tr>, </td>,
// </th>, </div>, </section>, </article>, </pre>, <br>. Inline tags are removed
// with NO whitespace added (text nodes concatenate like a browser's textContent).
const BLOCK_CLOSE = /<\/(p|li|blockquote|h[1-6]|tr|td|th|div|section|article|pre|ul|ol|table|main|header|footer|nav|aside|figure|figcaption|form|fieldset|hr)>/giu;
const BR = /<br\s*\/?>/giu;

function tokenizeHtml(html) {
  // Remove scripts/styles/comments entirely.
  let body = html.replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ");

  // Split into tag and text tokens.
  const tokens = [];
  const re = /<[^>]+>|[^<]+/gu;
  let m;
  const parts = [];
  while ((m = re.exec(body))) parts.push(m[0]);

  const segments = [];
  let pendingBoundary = null;
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (BR.test(part)) pendingBoundary = "br";
      else if (BLOCK_CLOSE.test(part)) {
        const tag = (part.match(/\/(\w+)/) || [,"?"])[1];
        pendingBoundary = tag;
      }
      // ignore open tags and inline closes
    } else {
      // text chunk: collapse whitespace, but note we only want to collapse
      // WITHIN a text node; however for locating we keep raw then collapse.
      if (part.trim().length === 0 && !/\S/u.test(part)) {
        // pure whitespace between tags: don't emit, but block boundary may pass through
        continue;
      }
      segments.push({ text: decodeEntities(part.replace(/\s+/gu, " ")), boundaryBefore: pendingBoundary });
      pendingBoundary = null;
    }
  }
  return segments;
}

// Concatenate segments into a full string with a marker char for boundaries.
function blockedString(segments) {
  let out = "";
  for (const seg of segments) {
    if (seg.boundaryBefore) out += "\n";
    out += seg.text;
  }
  return out;
}

export { tokenizeHtml, blockedString };
