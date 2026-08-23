import fs from "node:fs";
import path from "node:path";
import { pageTextOf, tolerantPattern } from "./gap-lib.mjs";
const label = "BCCA_2007_BCCA_536_p7_hard-section-word";
const gateOld = JSON.parse(fs.readFileSync("experiments/text-fragment-fidelity/results/gate-full-final2.jsonl","utf8").split("\n").find(l=>l.includes(label)));
const gateNew = JSON.parse(fs.readFileSync("experiments/text-fragment-fidelity/results/gate-replay.jsonl","utf8").split("\n").find(l=>l.includes(label)));
console.log("old target", gateOld.target.slice(0,200));
console.log("new target", gateNew.target.slice(0,200));
console.log("old highlight", gateOld.highlightPixels, "new", gateNew.highlightPixels);
const frag = gateOld.target.split(":~:text=")[1].split("&text=")[0].split(",")[0];
let decoded=""; try{decoded=decodeURIComponent(frag)}catch{}
console.log("frag decoded", JSON.stringify(decoded.slice(0,80)));
const page = pageTextOf({target: gateOld.target});
console.log("pageTextOf", page ? (page.cacheMiss?"cacheMiss":`len ${page.raw.length} hasFrag ${tolerantPattern(decoded).test(page.raw)}`) : "no page");
if (page && !page.cacheMiss) {
  console.log("page snippet", JSON.stringify(page.raw.slice(0,300).replace(/\s+/g," ").slice(0,200)));
}
