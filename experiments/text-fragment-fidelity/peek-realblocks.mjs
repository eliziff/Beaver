import fs from "node:fs";
import path from "node:path";
import { readLines, parse, normalizeKey, manifest, manifestFolded, cacheDir } from "./gap-lib.mjs";
import { tokenizeHtml, blockedString } from "./html-tokenizer.mjs";

const target = process.argv[2];
const key = normalizeKey(target);
const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
const html = fs.readFileSync(path.join(cacheDir, row.file), "utf8");
const segments = tokenizeHtml(html);
const bs = blockedString(segments);

// Print the blocked string (real block boundaries as \n) so we can compare
// with the scorecard's over-marked version.
console.log("SEGMENTS with real block boundaries only:");
console.log(JSON.stringify(bs.slice(0, 4000)));
