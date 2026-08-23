import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const cacheDir = path.join(resultsDir, "page-html");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");

const rows = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Decisia-family shells: decision pages captured before the body loaded.
const decisiaRe = /(^|\.)decisions?\.[\w-]+\.(?:gc\.)?ca$|decisia\.lexum\.com|coadecisions\.ontariocourts\.ca$/iu;
let purged = 0;
const keep = [];
for (const r of rows) {
  let host = "";
  try { host = new URL(r.url).hostname; } catch {}
  const isShell = r.file && r.file.endsWith(".html") && decisiaRe.test(host) && (r.bytes ?? 0) > 0 && (r.bytes ?? 0) < 20000;
  if (isShell) {
    try { fs.rmSync(path.join(cacheDir, r.file)); } catch {}
    purged += 1;
  } else {
    keep.push(r);
  }
}
fs.writeFileSync(manifestPath, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ purged }));
