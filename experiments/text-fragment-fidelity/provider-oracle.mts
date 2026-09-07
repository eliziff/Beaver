#!/usr/bin/env -S npx tsx
/**
 * Provider oracle: journal and CourtListener receipts must still receive a
 * verified text fragment.
 *
 * Unlike `regression-oracle.mts`, which exercises the URL builder directly,
 * this drives the real presentation path — `presentLegalEvidence` on a
 * `RegisteredEvidence` whose `source` is the provider's own document artifact,
 * exactly as `legalEvidenceSource` (fresh reads) and
 * `restorePriorLegalEvidence` (prior turns) supply it. The resulting
 * `passageUrl` is then painted in headless Chrome against locally rendered
 * HTML of that same document text, and the highlighted words are read back.
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { structureNative } from "../../backend/src/lib/structureNative";
import { presentLegalEvidence } from "../../backend/src/lib/chat/citationPresentation";
import type { LegalEvidenceReceipt } from "../../backend/src/lib/chat/legalEvidence";

const COURTLISTENER =
  "C:/Users/elias/AppData/Local/OpenLegalProducts/LegalData/providers/courtlistener/courtlistener.sqlite";
const JOURNALS =
  "C:/Users/elias/AppData/Local/ALR Quote Verifier/data/public_endpoint-424c9f516423.db";
const PER_PROVIDER = Number(process.env.SEEDS ?? 8);

function isHighlightPixel(r: number, g: number, b: number) {
  return r >= 205 && g >= 175 && r - g >= 12 && b - g >= 18 && b >= 228 && b >= r;
}

const normalize = (value: string) =>
  value.normalize("NFKD").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";

/** CourtListener bodies are stored as HTML/XML fragments. */
const plainText = (value: string) =>
  value.replace(/<[^>]*>/gu, " ").replace(/&[a-z]+;/giu, " ")
    .replace(/[ \t]+/gu, " ").replace(/\n\s*\n\s*/gu, "\n").trim();

type Seed = {
  label: string;
  provider: "journal" | "courtlistener";
  citation: string;
  name: string;
  externalUrl: string;
  blockText: string;
  quote: string;
  text: string;
};

function windowQuote(block: string) {
  const words = block.split(/\s+/u);
  const at = Math.max(0, Math.floor(words.length / 2) - 6);
  return words.slice(at, at + 12).join(" ");
}

function seedsFrom(
  rows: { citation: string; name: string; url: string; text: string }[],
  provider: Seed["provider"],
): Seed[] {
  const seeds: Seed[] = [];
  for (const row of rows) {
    if (seeds.length >= PER_PROVIDER) break;
    const blocks = row.text.split(/\n+/u).map((block) => block.trim())
      .filter((block) => block.split(/\s+/u).length >= 45);
    if (blocks.length < 2) continue;
    const block = blocks[Math.floor(blocks.length / 2)]!;
    const quote = windowQuote(block);
    // A table-of-contents dot leader has no substantive words, and the
    // builder rightly refuses to spell a directive for it.
    if (quote.split(" ").length < 12 ||
      (quote.match(/[\p{L}]{3,}/gu)?.length ?? 0) < 8) continue;
    seeds.push({
      label: `${provider}_${row.citation}`.replace(/\W+/gu, "_"),
      provider,
      citation: row.citation,
      name: row.name,
      externalUrl: row.url,
      blockText: block,
      quote,
      text: row.text,
    });
  }
  return seeds;
}

function pickSeeds(): Seed[] {
  const cl = new DatabaseSync(COURTLISTENER, { readOnly: true });
  const clRows = (cl.prepare(
    `select o.cluster_id as id, c.case_name as name, o.body as body
       from opinion_search o join cluster c on c.id = o.cluster_id
      where length(o.body) between 9000 and 40000 limit ?`,
  ).all(PER_PROVIDER * 6) as unknown as
    { id: number; name: string | null; body: string }[]).map((row) => ({
      citation: `courtlistener-${row.id}`,
      name: row.name ?? "United States v. Example",
      url: `https://www.courtlistener.com/opinion/${row.id}/example/`,
      text: plainText(row.body),
    }));
  cl.close();

  const journals = new DatabaseSync(JOURNALS, { readOnly: true });
  const journalRows = (journals.prepare(
    // Journals in this corpus carry no neutral citation; they are cited by
    // article id and name, which is what the journal receipt records too.
    `select article_id as id, name_en as name, url_en as url, text
       from articles
      where text is not null and url_en is not null
        and length(text) between 9000 and 40000 limit ?`,
  ).all(PER_PROVIDER * 6) as unknown as
    { id: number; name: string; url: string; text: string }[]).map((row) => ({
      citation: `journal-${row.id}`, name: row.name, url: row.url, text: row.text,
    }));
  journals.close();

  return [
    ...seedsFrom(clRows, "courtlistener"),
    ...seedsFrom(journalRows, "journal"),
  ];
}

const escapeHtml = (value: string) =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function renderPage(text: string) {
  let index = 0;
  const body = text.split(/\n+/u).map((block) => {
    const words = block.trim().split(/\s+/u)
      .map((word) => `<span data-w="${index++}">${escapeHtml(word)}</span>`);
    return `<p>${words.join(" ")}</p>`;
  }).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>doc</title>` +
    `<style>body{font:16px/1.6 serif;margin:24px;max-width:40em}</style>${body}`;
}

/** The receipt shape each provider's evidence factory produces. */
function receiptFor(seed: Seed, url: string): LegalEvidenceReceipt {
  const shared = {
    evidence_id: `e_${seed.label}`,
    jurisdiction: seed.provider === "courtlistener" ? "US" : "CA",
    stable_source_id: seed.label,
    source_sha256: "0".repeat(64),
    scope: "passage" as const,
    block_id: "chars:0-1",
    span_sha256: "0".repeat(64),
    span_text: seed.blockText,
    citation: seed.citation,
    name: seed.name,
    language: "en" as const,
    version: null,
    external_url: url,
  };
  return seed.provider === "courtlistener"
    ? { ...shared, provider: "courtlistener", source_class: "case",
        dataset: "courtlistener", locator: { kind: "paragraph", label: "par12" },
        resolver_version: "courtlistener-span-v1" }
    : { ...shared, provider: "journal", source_class: "commentary",
        dataset: "journals", locator: { kind: "page", label: "page=4" },
        resolver_version: "public-journal-v1" };
}

async function main() {
  const seeds = pickSeeds();
  if (!seeds.length) throw new Error("no seeds available");
  const pages = new Map(seeds.map((seed) => [seed.label, renderPage(seed.text)]));

  const server = createServer((request, response) => {
    const label = decodeURIComponent((request.url ?? "/").split(/[?#]/u, 1)[0]!.slice(1));
    const html = pages.get(label);
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(html ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const page = await context.newPage();
  const analyzer = await context.newPage();
  await analyzer.goto("about:blank");

  const tally: Record<string, { fragment: number; correct: number; total: number;
    notes: string[] }> = {
    courtlistener: { fragment: 0, correct: 0, total: 0, notes: [] },
    journal: { fragment: 0, correct: 0, total: 0, notes: [] },
  };

  for (const seed of seeds) {
    const url = `${origin}/${encodeURIComponent(seed.label)}`;
    const source = await structureNative().deriveDocumentStructure({
      kind: "provider_text",
      input: {
        provider: "a2aj", citation: seed.citation,
        source_kind: seed.provider === "journal" ? "laws" : "cases",
        text: seed.text, url,
      },
    });
    const row = tally[seed.provider]!;
    row.total += 1;

    // Exactly what legalEvidenceSource / restorePriorLegalEvidence hand over:
    // the provider's own document artifact as `source`, no A2AJ document.
    const presentation = presentLegalEvidence(
      { receipt: receiptFor(seed, url), source },
      [seed.quote],
    );
    const target = presentation.passageUrl;
    if (!target?.includes(":~:text=")) {
      row.notes.push(`${seed.label}: no fragment (${target ?? "null"})`);
      continue;
    }
    row.fragment += 1;

    await page.goto(target, { waitUntil: "load" });
    await page.waitForTimeout(250);
    const shot = await page.screenshot();
    const boxes = await page.evaluate(() => {
      const out: [number, number, number][] = [];
      for (const span of document.querySelectorAll<HTMLElement>("span[data-w]")) {
        const rect = span.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        out.push([Number(span.dataset.w), Math.round(rect.left + rect.width / 2),
          Math.round(rect.top + rect.height / 2)]);
      }
      return out;
    });
    const painted = await analyzer.evaluate(async (
      { b64, boxes, source }: { b64: string; boxes: [number, number, number][]; source: string },
    ) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = new Function(`return ${source}`)() as
        (r: number, g: number, b: number) => boolean;
      const words: number[] = [];
      for (const [word, x, y] of boxes) {
        let on = false;
        for (let dx = -6; dx <= 6 && !on; dx += 2) {
          const px = x + dx;
          if (px < 0 || px >= canvas.width || y < 0 || y >= canvas.height) continue;
          const at = (y * canvas.width + px) * 4;
          if (hit(data[at]!, data[at + 1]!, data[at + 2]!)) on = true;
        }
        if (on) words.push(word);
      }
      return words;
    }, { b64: shot.toString("base64"), boxes, source: isHighlightPixel.toString() });

    if (!painted.length) {
      row.notes.push(`${seed.label}: fragment built but nothing painted`);
      continue;
    }
    const paintedText = await page.evaluate(([first, last]: [number, number]) => {
      const words: string[] = [];
      for (let at = first; at <= last; at += 1) {
        words.push(document.querySelector(`span[data-w="${at}"]`)?.textContent ?? "");
      }
      return words.join(" ");
    }, [Math.min(...painted), Math.max(...painted)] as [number, number]);
    const got = normalize(paintedText), want = normalize(seed.quote);
    if (got === want || got.includes(want) || want.includes(got)) row.correct += 1;
    else row.notes.push(`${seed.label}: painted ${JSON.stringify(paintedText.slice(0, 90))}` +
      ` | want ${JSON.stringify(seed.quote.slice(0, 90))}`);
  }

  await browser.close();
  server.close();

  for (const [provider, row] of Object.entries(tally)) {
    console.log(`${provider.padEnd(14)} fragment built ${row.fragment}/${row.total}  ` +
      `correct passage ${row.correct}/${row.total}`);
  }
  for (const [provider, row] of Object.entries(tally)) {
    for (const note of row.notes.slice(0, 6)) console.log(`${provider}: ${note}`);
  }
}

await main();
