import fs from "node:fs";
import path from "node:path";
import { readLines, parse, normalizeKey, manifest, manifestFolded, cacheDir, resultsDir } from "./gap-lib.mjs";

const urls = [
  "https://www.bccourts.ca/jdb-txt/ca/25/00/2025BCCA0009.htm",
];
for (const u of urls) {
  const key = normalizeKey(u);
  console.log("key:", JSON.stringify(key));
  const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
  console.log("row:", row ? JSON.stringify(row) : "MISS");
  // also list manifest keys matching '2025BCCA0009'
}
const matching = [...manifest.keys()].filter((k) => k.includes("2025BCCA0009"));
console.log("matching keys:", matching);
