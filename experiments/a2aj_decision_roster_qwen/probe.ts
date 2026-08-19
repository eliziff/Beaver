import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocument,
  getLocalA2AJStructure,
} from "../../backend/src/lib/a2ajLocalBulk";
import { withReadonlySqlite } from "../../backend/src/lib/legalDataPath";
import { a2ajLegalSourceProvider } from "../../backend/src/lib/legalSources/a2aj";

const citation = "CITT PR-2023-044";
const dataset = "CITT";
const document = fetchLocalA2AJDocument({
  citation,
  dataset,
  docType: "cases",
  language: "en",
  maxChars: Number.MAX_SAFE_INTEGER,
});
if (!document) throw new Error("no document");
console.log("text length", document.text.length);

const structure = getLocalA2AJStructure(document);
console.log("structure summary", JSON.stringify(structure, null, 1));

const source = structure ?? a2ajLegalSourceProvider.source(document);
const blocks = source.blocks.filter((b) => b.kind === "paragraph");
console.log("paragraph labels:", blocks.map((b) => b.label).join(","));

const raw = document.text;
for (const n of [15, 16, 17, 18, 19, 20, 25, 26, 27, 32]) {
  const re = new RegExp(`\\[${n}\\]`, "u");
  const match = re.exec(raw);
  if (match) {
    console.log(
      `[${n}] at ${match.index}: ${raw.slice(match.index, match.index + 120).replace(/\s+/g, " ")}`,
    );
  } else {
    console.log(`[${n}] NOT FOUND in raw text`);
  }
}

const allRawNumbers = [...raw.matchAll(/\[(\d{1,3})\]/gu)].map((m) => Number(m[1]));
console.log("raw bracket numbers 1..40 missing:", [...Array(40).keys()].map((n) => n + 1).filter((n) => !allRawNumbers.includes(n)));
