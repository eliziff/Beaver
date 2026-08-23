#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
const chromeFiles = process.argv[2] ? [process.argv[2]] : [
  path.join(results, "webdriver-exact-html.jsonl"),
  path.join(results, "webdriver-exact-pdf.jsonl"),
];
const offlineFile = process.argv[3] ?? path.join(results, "offline-fragment-proof.jsonl");
const chrome = new Map();
for (const file of chromeFiles) {
  for (const row of read(file)) chrome.set(row.label, row);
}
let agree = 0; let falsePass = 0; let falseReject = 0;
const disagreements = [];
for (const row of read(offlineFile)) {
  const chromeRow = chrome.get(row.label);
  if (!chromeRow || !row.target || row.target !== chromeRow.target) continue;
  const offline = row.verdict === "offline-compatible";
  const actual = chromeRow.verdict === "exact-match" || chromeRow.verdict === "range-exact";
  if (offline === actual) agree += 1;
  else if (offline) { falsePass += 1; disagreements.push({ label: row.label, kind: "false-pass" }); }
  else { falseReject += 1; disagreements.push({ label: row.label, kind: "false-reject", verdict: row.verdict }); }
}
console.log(JSON.stringify({ comparable: agree + falsePass + falseReject, agree, falsePass, falseReject, disagreements: disagreements.slice(0, 25) }, null, 1));
