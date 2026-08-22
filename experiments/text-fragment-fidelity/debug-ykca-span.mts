import {
  createTextSourceDoc,
  sourceDocPhraseSpans,
  sourceDocQuoteWords,
} from "../../backend/src/lib/sourceDoc";
import fs from "node:fs";

const seeds = fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const seed = seeds.find((s) => s.label === "YKCA_2019_YKCA_18_p18_short-exact");
const quote = seed.quotes[0];
const words = sourceDocQuoteWords(quote);
console.log("quote words:", words.length, JSON.stringify(words.slice(0, 10)));
const blockDoc = createTextSourceDoc(seed.blockText);
const blockSpans = sourceDocPhraseSpans(blockDoc, words, { limit: 5 });
console.log("block spans:", blockSpans.length);
for (const span of blockSpans) {
  console.log("  slice:", JSON.stringify(blockDoc.text.slice(span.start, span.end).slice(0, 100)));
}
const doctext = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/doctext.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key, r.text]),
);
const doc = createTextSourceDoc(doctext.get(seed.label.split("_").slice(1, -1).join("_")) ?? "");
const docSpans = sourceDocPhraseSpans(doc, words, { limit: 5 });
console.log("full-doc spans:", docSpans.length);
const blockTokens = blockDoc.tokens.map((t) => blockDoc.text.slice(t.start, t.end).toLowerCase());
console.log("block token count:", blockTokens.length);
const at = blockTokens.indexOf("noted");
console.log("around 'noted':", JSON.stringify(blockTokens.slice(Math.max(0, at - 6), at + 12)));
