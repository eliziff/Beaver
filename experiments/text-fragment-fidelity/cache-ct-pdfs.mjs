import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ids = ["464120","463861","463834","463900","464444","464621","463717","464239","464295","463654","463732","464250","464339"];
const manifestPath = path.join(import.meta.dirname, "results/page-html-manifest.jsonl");
const cacheDir = path.join(import.meta.dirname, "results/page-html");
fs.mkdirSync(cacheDir, { recursive: true });

function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = [...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k,v])=>`${k}=${v}`).join("&")}`;
  } catch { return rawUrl.split("#")[0]; }
}
function fileFor(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  // Use .pdf for PDFs
  return `${hash}.pdf`;
}

for (const id of ids) {
  const url = `https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/${id}/1/document.do`;
  const file = fileFor(url);
  const dest = path.join(cacheDir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
    console.log(`cached ${id} -> ${file} (${fs.statSync(dest).size} bytes) skip`);
    continue;
  }
  console.log(`fetch ${id} ${url} ...`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
    if (!res.ok) { console.log(`  ${id} failed ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`  ${id} saved ${buf.length} bytes -> ${file}`);
    // Append to manifest
    const row = { url, file, bytes: buf.length, contentType: res.headers.get("content-type") || "application/pdf" };
    fs.appendFileSync(manifestPath, JSON.stringify(row)+"\n");
  } catch (e) {
    console.log(`  ${id} error ${e.message}`);
  }
  await new Promise(r=>setTimeout(r, 800));
}
console.log("done");
