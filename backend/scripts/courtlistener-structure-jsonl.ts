/** Compile CourtListener markup through Beaver's shipping SourceDoc path. */
import { createInterface } from "node:readline";

import {
  compileA2AJSourceDoc,
  courtlistenerCaseBlocks,
} from "../src/lib/sourceDocA2AJ";
import { compileNativeMarkupSourceDoc } from "../src/lib/sourceDocNativeMarkup";

type Request = {
  id: string;
  clusterId: string;
  field: string | null;
  text: string;
  markup: string;
};

function request(value: unknown): Request {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.clusterId !== "string" ||
    (typeof row.field !== "string" && row.field !== null) ||
    typeof row.text !== "string" ||
    typeof row.markup !== "string"
  ) {
    throw new Error("id, clusterId, field, text, and markup are required");
  }
  return row as Request;
}

function count(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}

function markerStyle(value: string) {
  const opening = value.trimStart();
  if (/^\[\s*\d{1,5}\s*\]/u.test(opening)) return "bracket";
  if (/^\d{1,5}\.(?:\s|\p{L})/u.test(opening)) return "dot";
  if (/^\d{1,5}\s/u.test(opening)) return "bare";
  return "other";
}

function numberedLabels(labels: string[]) {
  return labels.map((label) => Number(label.replace(/^par/u, "")));
}

function sequence(labels: string[]) {
  const values = numberedLabels(labels);
  return {
    first: values[0] ?? null,
    last: values.at(-1) ?? null,
    rooted: values[0] === 1,
    contiguous: values.every(
      (value, index) => index === 0 || value === values[index - 1] + 1,
    ),
  };
}

function paragraphSummary(
  text: string,
  blocks: Array<{
    label: string;
    start: number;
    end: number;
  }>,
) {
  const details = blocks.map((block) => {
    const blockText = text.slice(block.start, block.end);
    return {
      label: block.label,
      style: markerStyle(blockText),
      start: block.start,
      end: block.end,
      words: count(blockText, /\p{L}+/gu),
      excerpt: blockText.replace(/\s+/gu, " ").trim().slice(0, 240),
    };
  });
  const styles = Object.fromEntries(
    ["bracket", "dot", "bare", "other"].map((style) => [
      style,
      details.filter((block) => block.style === style).length,
    ]),
  );
  const samples = details.length
    ? [details[0], details[Math.floor(details.length / 2)], details.at(-1)].filter(
        (block, index, values) =>
          values.findIndex((candidate) => candidate?.label === block?.label) === index,
      )
    : [];
  return {
    count: details.length,
    ...sequence(details.map(({ label }) => label)),
    styles,
    first_offset: details[0]?.start ?? null,
    last_offset: details.at(-1)?.start ?? null,
    samples,
  };
}

function compile(input: Request) {
  const document = compileNativeMarkupSourceDoc({
    provider: "courtlistener",
    id: input.id,
    text: input.text,
    markup: input.markup,
  });
  const paragraphs = document.blocks.filter(
    (block) => block.kind === "paragraph" && !block.parentLabel,
  );
  const native = paragraphs.filter(({ origin }) => origin === "native");
  const heuristic = paragraphs.filter(({ origin }) => origin === "heuristic");
  const alternatives = native.length
    ? null
    : {
        a2aj: compileA2AJSourceDoc({
          id: input.id,
          citation: "",
          docType: "cases",
          text: document.text,
        }).blocks.filter(
          (block) => block.kind === "paragraph" && !block.parentLabel,
        ),
        courtlistener: courtlistenerCaseBlocks({ text: document.text }).filter(
          (block) => block.kind === "paragraph" && !block.parentLabel,
        ),
      };
  const notes = document.text.search(
    /(?:^|\n)\s*(?:notes?|footnotes?)\s*(?:\n|$)/iu,
  );
  return {
    schema: 2,
    id: Number(input.id),
    cluster_id: Number(input.clusterId),
    field: input.field,
    markup_length: input.markup.length,
    text_length: document.text.length,
    markup: {
      native_divs: count(
        input.markup,
        /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bnum\b[^"']*["'])(?=[^>]*\bid\s*=\s*["']p\d{1,5}["'])[^>]*>/giu,
      ),
      para_ids: count(
        input.markup,
        /\b(?:eId|id)\s*=\s*["']para(?:graph)?[_-]?\d{1,5}["']/giu,
      ),
      notes_headings: count(
        input.markup,
        /<h([1-6])\b[^>]*>\s*(?:notes?|footnotes?)\s*<\/h\1\s*>/giu,
      ),
      numbered_headings: count(
        input.markup,
        /<h[1-6]\b[^>]*>\s*(?:\[\s*)?\d{1,4}(?:\s*\]|\.)/giu,
      ),
      footnote_containers: count(
        input.markup,
        /<(?:aside\b[^>]*\bclass\s*=\s*["'][^"']*\bfootnote\b|(?:div|li|section)\b[^>]*(?:\bclass\s*=\s*["'][^"']*\bfootnotes\b|\bid\s*=\s*["'](?:fn|footnote)[_-]))/giu,
      ),
    },
    notes_offset: notes < 0 ? null : notes,
    native: {
      count: native.length,
      ...sequence(native.map(({ label }) => label)),
    },
    heuristic: {
      ...paragraphSummary(document.text, heuristic),
    },
    a2aj: alternatives
      ? paragraphSummary(document.text, alternatives.a2aj)
      : null,
    courtlistener: alternatives
      ? paragraphSummary(document.text, alternatives.courtlistener)
      : null,
    footnotes: {
      native: document.blocks.filter(
        (block) => block.kind === "footnote" && block.origin === "native",
      ).length,
      heuristic: document.blocks.filter(
        (block) => block.kind === "footnote" && block.origin === "heuristic",
      ).length,
    },
    pages: {
      native: document.blocks.filter(
        (block) => block.kind === "page" && block.origin === "native",
      ).length,
      heuristic: document.blocks.filter(
        (block) => block.kind === "page" && block.origin === "heuristic",
      ).length,
    },
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let id: unknown = null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    id = parsed.id;
    process.stdout.write(`${JSON.stringify(compile(request(parsed)))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        id,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
});
