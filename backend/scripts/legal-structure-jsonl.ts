import { createInterface } from "node:readline";
import { structureNative } from "../src/lib/structureNative";

type Request = {
  id: string;
  citation: string;
  text: string;
  dataset?: string | null;
};

function scalarCoordinates(text: string, offsets: number[]) {
  const wanted = new Set(offsets);
  const result = new Map<number, number>([[0, 0]]);
  let utf16 = 0;
  let scalar = 0;
  for (const character of text) {
    utf16 += character.length;
    scalar += 1;
    if (wanted.has(utf16)) result.set(utf16, scalar);
  }
  return result;
}

async function compile(input: Request) {
  const document = await structureNative().deriveDocumentStructure({
    kind: "a2aj",
    input: {
      citation: input.citation,
      source_kind: "cases",
      text: input.text,
      dataset: input.dataset ?? undefined,
    },
  });
  const blocks = structureNative().documentAnchors(document)
    .filter(({ kind, parentLabel }) => kind === "paragraph" && !parentLabel);
  const coordinates = scalarCoordinates(input.text,
    blocks.flatMap(({ start, end }) => [start, end]));
  return blocks.map(({ label, start, end }) => [
    label,
    [],
    coordinates.get(start),
    coordinates.get(end),
  ]);
}

async function main() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let id: unknown = null;
    try {
      const input = JSON.parse(line) as Request;
      id = input.id;
      if (typeof id !== "string" || typeof input.citation !== "string" ||
          typeof input.text !== "string") throw new Error("invalid request");
      process.stdout.write(`${JSON.stringify({ id, paragraphs: await compile(input) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id,
        error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

void main();
