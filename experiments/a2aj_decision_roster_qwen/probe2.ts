import { fetchLocalA2AJDocument } from "../../backend/src/lib/a2ajLocalBulk";
import { a2ajLegalSourceProvider } from "../../backend/src/lib/legalSources/a2aj";

const document = fetchLocalA2AJDocument({
  citation: "CITT PR-2023-044",
  dataset: "CITT",
  docType: "cases",
  language: "en",
  maxChars: Number.MAX_SAFE_INTEGER,
});
if (!document) throw new Error("none");
const text = document.text;
const lines = text.split("\n");
for (let i = 0; i < lines.length; i += 1) {
  if (/^\s*\[\d+\]/.test(lines[i]) || /premature|jurisdiction|designated contract|^DECISION|STATEMENT OF REASONS/.test(lines[i])) {
    console.log(i, JSON.stringify(lines[i].slice(0, 180)));
  }
}
console.log("---- total lines:", lines.length);
const source = a2ajLegalSourceProvider.source(document);
const paragraphs = source.blocks.filter((b) => b.kind === "paragraph");
for (const block of paragraphs) {
  const snippet = text.slice(block.start, Math.min(block.end, block.start + 90)).replace(/\n/g, "\\n");
  console.log(block.label, JSON.stringify(snippet));
}
