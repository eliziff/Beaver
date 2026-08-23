import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const manifestPath = path.join(import.meta.dirname, "results/page-html-manifest.jsonl");
const cacheDir = path.join(import.meta.dirname, "results/page-html");
const seeds = fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).filter(s=>s.url.includes("ct-tc"));
const ids = [...new Set(seeds.map(s=>s.url.match(/\/item\/(\d+)\//)?.[1]).filter(Boolean))];
console.log("CT ids", ids.length, ids.slice(0,5));

function fileFor(url){ return crypto.createHash("sha1").update(url).digest("hex") + ".pdf"; }

for (const id of ids) {
  const url = `https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/${id}/1/document.do`;
  const file = fileFor(url);
  const dest = path.join(cacheDir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
    console.log(`cached ${id} skip`);
    continue;
  }
  console.log(`fetch ${id} ...`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
    if (!res.ok) { console.log(`  ${id} ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`  ${id} ${buf.length} -> ${file}`);
    const row = { url, file, bytes: buf.length, contentType: "application/pdf" };
    fs.appendFileSync(manifestPath, JSON.stringify(row)+"\n");
  } catch(e){ console.log(`  ${id} err ${e.message}`); }
  await new Promise(r=>setTimeout(r, 600));
}
console.log("done");
