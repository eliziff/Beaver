import fs from "node:fs";
import path from "node:path";
import { readLines, parse, normalizeKey, manifest, manifestFolded, cacheDir } from "./gap-lib.mjs";

const target = process.argv[2];
const label = process.argv[3];
if (!target) { console.log("usage: node peek-html.mjs <url> [label]"); process.exit(1); }

const key = normalizeKey(target);
const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
if (!row) { console.log("no manifest row for", target); process.exit(1); }
const file = path.join(cacheDir, row.file);
const html = fs.readFileSync(file, "utf8");

// Show the tags around the given needle(s)
const needles = process.argv.slice(4).filter(Boolean);
for (const needle of needles) {
  const idx = html.indexOf(needle);
  console.log("### needle:", JSON.stringify(needle), "found at", idx);
  if (idx >= 0) {
    console.log("HTML around needle (tag-stripped-to-plain):");
    const start = Math.max(0, idx - 200);
    const end = Math.min(html.length, idx + needle.length + 400);
    console.log(JSON.stringify(html.slice(start, end)));
  }
}
