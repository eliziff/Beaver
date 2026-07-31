/**
 * Persistent JSONL bridge to the shipping A2AJ compiler.
 *
 * Benchmark callers must use this process instead of copying SourceDoc's
 * detector grammar into Python. One request line produces one response line.
 */
import { createInterface } from "node:readline";

import { compileA2AJSourceDoc } from "../src/lib/sourceDocA2AJ";

const PROTOCOL = "beaver.sourcedoc.jsonl.v1";
const COMPILER = "compileA2AJSourceDoc";

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

function compile(input: Request) {
  const started = performance.now();
  const doc = compileA2AJSourceDoc(input);
  const blocks = Object.fromEntries(
    (["paragraph", "page", "section"] as const).map((kind) => [
      kind,
      doc.blocks
        .filter((block) => block.kind === kind && !block.parentLabel)
        .map(({ label, aliases, start, end, origin }) => ({
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
    blocks,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let id: unknown = null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    id = parsed?.id;
    process.stdout.write(`${JSON.stringify(compile(request(parsed)))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        protocol: PROTOCOL,
        compiler: COMPILER,
        id,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
});
