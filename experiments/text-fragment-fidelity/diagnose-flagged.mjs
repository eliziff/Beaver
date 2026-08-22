import fs from "node:fs";

const rows = fs.readFileSync("experiments/text-fragment-fidelity/results/gate-results.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.verdict === "no-highlight");
const seeds = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);

const normalize = (value) => value.replace(/\s+/gu, " ").toLowerCase();
async function check(row) {
  const seed = seeds.get(row.label);
  if (!seed) return { label: row.label, note: "seed missing" };
  const wanted = normalize(seed.quotes[0]).slice(0, 60);
  try {
    const response = await fetch(row.target.split("#")[0], {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" },
    });
    const body = await response.text();
    const text = normalize(body.replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gi, " ").replace(/&#160;/gi, " "));
    return {
      label: row.label,
      dataset: row.dataset,
      httpStatus: response.status,
      bytes: body.length,
      contentType: (response.headers.get("content-type") ?? "").split(";")[0],
      quoteInHtml: text.includes(wanted),
      blockInHtml: text.includes(normalize(seed.blockText).slice(10, 70)),
      looksLikePdfCard: /download.*pdf version|case documents/iu.test(body.slice(0, 4000)) && !text.includes(wanted),
    };
  } catch (error) {
    return { label: row.label, error: String(error).slice(0, 80) };
  }
}

const sample = [];
const seenDataset = new Map();
for (const row of flaggedRows(rows)) {
  const count = seenDataset.get(row.dataset) ?? 0;
  if (count >= 3) continue;
  seenDataset.set(row.dataset, count + 1);
  sample.push(row);
}
function flaggedRows(all) { return all; }

for (const row of sample) {
  console.log(JSON.stringify(await check(row)));
}
