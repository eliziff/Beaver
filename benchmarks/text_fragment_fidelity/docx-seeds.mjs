#!/usr/bin/env node
// Cache-tier seeds from the links the product made for real documents: the `<stem>.links.json` that
// benchmarks/alr-verifier/compose.ts --links writes beside each "[CHECKED]" workbook. Every citation part pinpointing a
// paragraph or provision (an ibid or supra too) gives a seed per link kind and mode:
//   kind  canlii    the CanLII link (the workbook's citation_part_link; with a quotation, the check's links.canlii);
//         provider  the page A2AJ names for the document (the part's or the quotation check's links.provider);
//         lawweb    A2AJ Law Web's page of the document (links.lawWeb);
//   mode  pinpoint  the link citing the pinpointed passage, its intended words the passage (citation_part_anchor_text);
//         quote     the link to a quotation found in the source, its intended words the source's words it matched.
// Usage: node benchmarks/text_fragment_fidelity/docx-seeds.mjs <run dir> [<run dir>...] > seeds.jsonl
// A run dir holds one folder per document, as compose.ts writes them.
import fs from "node:fs";
import path from "node:path";

const host = (url) => { try { return new URL(url).hostname; } catch { return ""; } };
const anchorOf = (url) => (url.split("#")[1] ?? "").split(":~:")[0] || null;
const seen = new Set();
for (const dir of process.argv.slice(2)) {
  for (const document of fs.readdirSync(dir)) {
    const folder = path.join(dir, document);
    const file = fs.existsSync(folder) && fs.statSync(folder).isDirectory()
      ? fs.readdirSync(folder).find((name) => name.endsWith(".links.json")) : null;
    if (!file) continue;
    const { parts, quotes } = JSON.parse(fs.readFileSync(path.join(folder, file), "utf8"));
    const checks = new Map(quotes.map((quote) => [quote.id, quote]));
    for (const part of parts) {
      const pinpoints = JSON.parse(part.pinpoint_fragments || "[]").filter((pin) => /^(?:par|sec)/u.test(pin));
      if (!pinpoints.length) continue;
      const reference = `${document.slice(0, 12)}:${part.footnote_id}:${part.citation_part_index}`;
      const seed = (kind, mode, url, text) => {
        if (!url || !/^https?:/u.test(url)) return;
        const id = `${reference}:${kind}:${mode}`;
        if (seen.has(id)) return;
        seen.add(id);
        console.log(JSON.stringify({ id, tier: "cache", role: mode === "quote" ? "quote" : "citation", origin: "docx",
          strategy: kind, mode, host: host(url), document, citation: part.citation_part_text, pinpoints, url,
          target: { pinpoint: anchorOf(url), texts: text ? [text] : [] } }));
      };
      const passage = part.citation_part_anchor_text || "";
      if (/canlii\.org/u.test(part.citation_part_link)) seed("canlii", "pinpoint", part.citation_part_link, passage);
      seed("provider", "pinpoint", part.links?.provider, passage);
      seed("lawweb", "pinpoint", part.links?.lawWeb, passage);
      for (const id of part.quote_ids) {
        const check = checks.get(id)?.checks.find((item) => item.receipt?.links && item.receipt.match?.location !== "unmatched");
        if (!check) continue;
        const words = check.receipt.match.fragment || checks.get(id).quote;
        seed("canlii", "quote", check.receipt.links.canlii, words);
        seed("provider", "quote", check.receipt.links.provider, words);
        seed("lawweb", "quote", check.receipt.links.lawWeb, words);
      }
    }
  }
}
