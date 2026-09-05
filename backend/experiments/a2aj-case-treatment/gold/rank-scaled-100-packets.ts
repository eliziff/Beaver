import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SelectionCase = { document_id: number; dataset: string; citation: string; name: string | null };
type Selection = { document_ids: number[]; cases: SelectionCase[] };
const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return path.resolve(index < 0 ? fallback : process.argv[index + 1] ?? fallback);
};

async function main() {
  const selectionFile = argument("--selection", path.join(here, "selection-scaled-100.json"));
  const auditedSelectionFile = argument("--audited-selection", path.join(here, "selection-scaled-30.json"));
  const packetsDirectory = argument("--packets-dir", path.resolve("backend/experiments/a2aj-case-treatment/runs/product-gold-scale-direct/packets"));
  const destination = argument("--out", path.join(here, "packet-ranking-scaled-70.json"));
  const selection = JSON.parse(await readFile(selectionFile, "utf8")) as Selection;
  const audited = JSON.parse(await readFile(auditedSelectionFile, "utf8")) as Selection;
  const auditedIds = new Set(audited.document_ids);
  const newCases = selection.cases.filter(({ document_id }) => !auditedIds.has(document_id));
  const selectionPositions = new Map(selection.cases.map(({ document_id }, index) => [document_id, index + 1]));
  if (newCases.length !== 70) throw new Error(`expected 70 new cases; found ${newCases.length}`);

  const packets = await Promise.all(newCases.map(async (item) => {
    const filename = path.join(packetsDirectory, `${item.document_id}.txt`);
    try {
      const text = await readFile(filename, "utf8");
      const headerEnd = text.indexOf("\n\n");
      if (headerEnd < 0) throw new Error(`${filename} has no packet header`);
      const header = JSON.parse(text.slice(0, headerEnd)) as { document_id?: unknown };
      if (header.document_id !== item.document_id || !/^\d{5} \| /mu.test(text.slice(headerEnd + 2))) {
        throw new Error(`${filename} is not a packet for document ${item.document_id}`);
      }
      return {
        document_id: item.document_id,
        dataset: item.dataset,
        citation: item.citation,
        name: item.name,
        selection_position: selectionPositions.get(item.document_id)!,
        characters: [...text].length,
        bytes: Buffer.byteLength(text, "utf8"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  const missing = newCases.filter((_, index) => !packets[index]).map(({ document_id }) => document_id);
  if (missing.length) {
    throw new Error(`${missing.length} packets are missing from ${packetsDirectory}. Generate them with: tsx backend/experiments/a2aj-case-treatment/cli.ts packets --case-file "${selectionFile}" --out-dir "${packetsDirectory}" --workers 8`);
  }

  const ranked = packets.filter((packet): packet is NonNullable<typeof packet> => Boolean(packet))
    .sort((left, right) => left.characters - right.characters || left.document_id - right.document_id)
    .map((packet, index) => ({ rank: index + 1, ...packet }));
  await writeFile(destination, `${JSON.stringify({
    format: "a2aj-case-treatment-packet-ranking-v1",
    selection: path.basename(selectionFile),
    scope: "new cases only",
    sort: ["characters ascending", "document_id ascending"],
    cases: ranked,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ destination, cases: ranked.length, shortest_characters: ranked[0]?.characters, longest_characters: ranked.at(-1)?.characters }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
