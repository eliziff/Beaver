#!/usr/bin/env -S npx tsx
/**
 * Differential oracle for the text-fragment regression hunt.
 *
 * For N real A2AJ decisions each seed's fragment URL is built two ways and
 * painted in headless Chrome against locally rendered HTML of the very same
 * flattened text:
 *
 *   grounded  - the corpus-proven path: the compiled document is handed to
 *               the builder, so `textFragmentPlan` verifies the directive is
 *               unique across the whole document.
 *   grouped   - the same block, but also handed a quote from a sibling block,
 *               as citation grouping used to do.
 *
 * Before the fix a third arm existed - `degraded`, with no `documentText` at
 * all, planned by `textFragmentPlanStandalone`. It scored 17/40 with genuine
 * mispaints. `documentText` is now a required field, so that arm no longer
 * compiles: the unverified path is gone by construction.
 *
 * Verification is exact, not "did something paint": every word of the page is
 * its own span, the page is screenshotted once, and each span's centre pixel
 * is tested against Chrome's ::target-text lavender. The painted word set is
 * then compared with the intended one.
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { structureNative } from "../../backend/src/lib/structureNative";
import { buildLegalSourcePinpoint } from "../../backend/src/lib/legalSourceLinks";

const CORPUS =
  "C:/Users/elias/AppData/Local/OpenLegalProducts/LegalData/providers/a2aj/a2aj-cases-fulltext.sqlite";
const SEEDS = Number(process.env.SEEDS ?? 40);

// ::target-text paints ~(231,209,252): red and blue both above green, blue
// at least as strong as red. Copied from the corpus gate's detector.
function isHighlightPixel(r: number, g: number, b: number) {
  return r >= 205 && g >= 175 && r - g >= 12 && b - g >= 18 &&
    b >= 228 && b >= r;
}

type Seed = {
  label: string;
  citation: string;
  dataset: string;
  blockText: string;
  quote: string;
  /** A quote from a DIFFERENT block, as `chat/citations.ts` groups them. */
  siblingQuote: string;
  text: string;
};

function pickSeeds(): Seed[] {
  const db = new DatabaseSync(CORPUS, { readOnly: true });
  const rows = db.prepare(
    `select citation_en as citation, dataset, unofficial_text_en as text
       from document
      where doc_type = 'cases' and citation_en is not null
        and unofficial_text_en is not null
        and length(unofficial_text_en) between 8000 and 18000
      order by id limit ?`,
  ).all(SEEDS * 8) as unknown as { citation: string; dataset: string; text: string }[];
  const seeds: Seed[] = [];
  for (const row of rows) {
    if (seeds.length >= SEEDS) break;
    const blocks = row.text.split(/\n+/u).map((block) => block.trim())
      .filter((block) => block.split(/\s+/u).length >= 45);
    if (!blocks.length) continue;
    if (blocks.length < 2) continue;
    const pick = (block: string) => {
      const words = block.split(/\s+/u);
      const at = Math.max(0, Math.floor(words.length / 2) - 6);
      return words.slice(at, at + 12).join(" ");
    };
    const block = blocks[Math.floor(blocks.length / 2)]!;
    const sibling = blocks[Math.floor(blocks.length / 2) + 1] ?? blocks[0]!;
    const quote = pick(block);
    const siblingQuote = pick(sibling);
    if (quote.split(" ").length < 12 || siblingQuote.split(" ").length < 12) continue;
    seeds.push({
      label: `${row.dataset}_${row.citation}`.replace(/\W+/gu, "_"),
      citation: row.citation,
      dataset: row.dataset,
      blockText: block,
      quote,
      siblingQuote,
      text: row.text,
    });
  }
  db.close();
  return seeds;
}

const escapeHtml = (value: string) =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** One span per word so the painted extent can be read back exactly. */
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

function normalize(value: string) {
  return value.normalize("NFKD").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
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

  const arms = ["grounded", "grouped"] as const;
  const tallies = Object.fromEntries(arms.map((arm) =>
    [arm, { exact: 0, sampled: 0, wrong: 0, none: 0, misses: [] as string[] }])) as Record<
      typeof arms[number],
      { exact: number; sampled: number; wrong: number; none: number; misses: string[] }
    >;

  for (const seed of seeds) {
    const url = `${origin}/${encodeURIComponent(seed.label)}`;
    const native = await structureNative().deriveDocumentStructure({
      kind: "provider_text",
      input: {
        provider: "a2aj", citation: seed.citation, source_kind: "cases",
        text: seed.text, url, dataset: seed.dataset,
      },
    });
    const built = {
      grounded: buildLegalSourcePinpoint(
        { url, docType: "cases", blockText: seed.blockText, documentText: native },
        [seed.quote]),
      // What chat/citations.ts used to send: members[0]'s block, but every
      // grouped member's quote - including quotes from other paragraphs.
      // citationPresentation now filters these out before building.
      grouped: buildLegalSourcePinpoint(
        { url, docType: "cases", blockText: seed.blockText, documentText: native },
        [seed.quote, seed.siblingQuote]),
    };

    for (const arm of arms) {
      const tally = tallies[arm];
      const target = built[arm]?.target;
      if (!target?.includes(":~:text=")) {
        tally.none += 1;
        tally.misses.push(`${seed.label}: no directive built`);
        continue;
      }
      await page.goto(target, { waitUntil: "load" });
      await page.waitForTimeout(250);
      // Chrome scrolls the match into view, so the viewport is enough and a
      // full-page shot of a long decision exceeds Chrome's capture limit.
      let shot: Buffer;
      try {
        shot = await page.screenshot();
      } catch {
        // Chrome intermittently refuses capture on very tall documents.
        await page.waitForTimeout(500);
        shot = await page.screenshot();
      }
      const boxes = await page.evaluate(() => {
        const out: [number, number, number][] = [];
        for (const span of document.querySelectorAll<HTMLElement>("span[data-w]")) {
          const rect = span.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          out.push([
            Number(span.dataset.w),
            Math.round(rect.left + rect.width / 2),
            Math.round(rect.top + rect.height / 2),
          ]);
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
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
          // Sample a short horizontal run: glyph strokes are dark even when
          // the highlight is behind them.
          let painted = false;
          for (let dx = -6; dx <= 6 && !painted; dx += 2) {
            const px = x + dx;
            if (px < 0 || px >= canvas.width) continue;
            const at = (y * canvas.width + px) * 4;
            if (hit(data[at]!, data[at + 1]!, data[at + 2]!)) painted = true;
          }
          if (painted) words.push(word);
        }
        return words;
      }, { b64: shot.toString("base64"), boxes, source: isHighlightPixel.toString() });

      if (!painted.length) {
        tally.none += 1;
        tally.misses.push(`${seed.label}: nothing painted for ${target.slice(target.indexOf(":~:"))}`);
        continue;
      }
      // Chrome paints one contiguous run per directive; centre-pixel sampling
      // can drop a word whose glyphs cover the sample row, so read the whole
      // span from the first painted word to the last.
      const paintedText = await page.evaluate(
        ([first, last]: [number, number]) => {
          const words: string[] = [];
          for (let at = first; at <= last; at += 1) {
            words.push(document.querySelector(`span[data-w="${at}"]`)?.textContent ?? "");
          }
          return words.join(" ");
        },
        [Math.min(...painted), Math.max(...painted)] as [number, number]);
      // Centre-pixel sampling can drop the first or last word of the run, so
      // score passage identity: one string containing the other is the cited
      // passage, a disjoint string is a mispaint.
      const painted_ = normalize(paintedText), want = normalize(seed.quote);
      if (painted_ === want) tally.exact += 1;
      else if (painted_.includes(want) || want.includes(painted_)) {
        tally.exact += 1;
        tally.sampled += 1;
      } else {
        tally.wrong += 1;
        tally.misses.push(
          `${seed.label}: painted ${JSON.stringify(paintedText.slice(0, 110))}` +
          ` | want ${JSON.stringify(seed.quote.slice(0, 110))}`);
      }
    }
  }

  await browser.close();
  server.close();

  console.log(`seeds: ${seeds.length}\n`);
  for (const arm of arms) {
    const { exact, sampled, wrong, none } = tallies[arm];
    const total = exact + wrong + none;
    console.log(`${arm.padEnd(9)} correct passage ${exact}/${total} ` +
      `(${(100 * exact / total).toFixed(1)}%)  mispaint ${wrong}  no-paint ${none}` +
      `  [${sampled} scored via edge-word tolerance]`);
  }
  console.log("\n--- misses ---");
  for (const arm of arms) {
    for (const miss of tallies[arm].misses.slice(0, 10)) console.log(`${arm}: ${miss}`);
  }
}

await main();
