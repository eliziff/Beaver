import fs from "node:fs";
import path from "node:path";
import { normalizeKey, manifest, manifestFolded, cacheDir } from "./gap-lib.mjs";

const target = process.argv[2];
const needles = process.argv.slice(3);
const key = normalizeKey(target);
const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
const html = fs.readFileSync(path.join(cacheDir, row.file), "utf8");

for (const needle of needles) {
  const idx = html.indexOf(needle);
  console.log("### needle:", JSON.stringify(needle), "found at", idx);
  if (idx >= 0) {
    const start = Math.max(0, idx - 300);
    const end = Math.min(html.length, idx + needle.length + 500);
    // Replace literal newlines in HTML with ⏎ so we can see structure
    console.log(html.slice(start, end).replace(/\r\n?/gu, "⏎"));
  }
}
