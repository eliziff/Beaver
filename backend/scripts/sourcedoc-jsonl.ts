/**
 * Persistent JSONL bridge to the shipping shared structure engine.
 *
 * Benchmark callers must use this process instead of copying SourceDoc's
 * detector grammar into Python. One request line produces one response line.
 */
import { createInterface } from "node:readline";

import type { SourceDoc } from "../src/lib/sourceDoc";
import { analyzeDocumentNative } from "../src/lib/structureNative";

const PROTOCOL = "beaver.sourcedoc.jsonl.v1";
const COMPILER = "legal-structure";

type Request = {
  id: string;
  docType: "cases" | "laws";
  citation: string;
  text: string;
  alternateCitation?: string | null;
  dataset?: string | null;
  name?: string | null;
  sectionMap?: Record<string, string> | null;
};

function request(value: unknown): Request {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    (row.docType !== "cases" && row.docType !== "laws") ||
    typeof row.citation !== "string" ||
    typeof row.text !== "string"
  ) {
    throw new Error("id, docType, citation, and text are required");
  }
  if (
    row.sectionMap != null &&
    (typeof row.sectionMap !== "object" ||
      Array.isArray(row.sectionMap) ||
      Object.values(row.sectionMap).some((text) => typeof text !== "string"))
  ) {
    throw new Error("sectionMap must map labels to strings");
  }
  return row as Request;
}

function numbered(label: string) {
  const value = Number(label.replace(/^(?:par|page)/u, ""));
  return Number.isFinite(value) ? value : label;
}

function rendition(
  text: string,
  selected: Array<{
    kind: "paragraph" | "page" | "section";
    label: string;
    aliases?: string[];
    start: number;
    end: number;
    origin: "native" | "heuristic";
  }>,
  kind: string,
) {
  const segments: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const block of [...selected].sort(
    (left, right) => left.start - right.start,
  )) {
    if (block.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, block.start) });
    }
    segments.push({
      kind: block.kind,
      label: block.label,
      aliases: block.aliases ?? [],
      origin: block.origin,
      text: text.slice(block.start, block.end),
    });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < text.length || !segments.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return { kind, segments };
}

async function compile(input: Request) {
  const started = performance.now();
  const analyzed = await analyzeDocumentNative({
    kind: "a2aj",
    source_doc: true,
    input: {
      citation: input.citation,
      source_kind: input.docType,
      text: input.sectionMap ? "" : input.text,
      id: input.id,
      alternate_citation: input.alternateCitation,
      dataset: input.dataset,
      name: input.name,
      section_map: input.sectionMap ? Object.entries(input.sectionMap) : null,
    },
  });
  const doc = analyzed.source_doc;
  if (!doc) throw new Error("Rust omitted SourceDoc");
  const blocks = Object.fromEntries(
    (["paragraph", "page", "section"] as const).map((kind) => [
      kind,
      doc.blocks
        .filter((block) => block.kind === kind && !block.parentLabel)
        .map(({ label, aliases, start, end, origin }) => ({
          kind,
          label,
          aliases: aliases ?? [],
          start,
          end,
          origin,
        })),
    ]),
  );
  const selected = blocks.paragraph.length
    ? blocks.paragraph
    : blocks.page.length
      ? blocks.page
      : blocks.section;
  const kind = blocks.paragraph.length
    ? "paragraphs"
    : blocks.page.length
      ? "pages"
      : blocks.section.length
        ? "sections"
        : "none";
  return {
    protocol: PROTOCOL,
    compiler: COMPILER,
    id: input.id,
    status: doc.status,
    summary: {
      kind,
      count: selected.length,
      first: selected.length ? numbered(selected[0].label) : null,
      last: selected.length ? numbered(selected.at(-1)!.label) : null,
      span:
        selected.length > 1
          ? Number(
              (
                (selected.at(-1)!.start - selected[0].start) /
                Math.max(1, doc.text.length)
              ).toFixed(4),
            )
          : selected.length
            ? 1
            : 0,
    },
    rendition: rendition(doc.text, selected, kind),
    blocks,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let id: unknown = null;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      id = parsed?.id;
      process.stdout.write(`${JSON.stringify(await compile(request(parsed)))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, compiler: COMPILER, id,
        error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

void main();
