import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CASE_TARGET_MVP_JSON_SCHEMA,
  caseTargetMvpPacket,
  loadCase,
} from "../runner";

type PairFile = {
  pairs: Array<{
    document_id: number;
    source: { dataset: string; citation: string; name: string | null; date: string | null };
    target: {
      document_id: number | null;
      citation: string;
      citation_aliases?: string[];
      name: string | null;
      same_litigation_eligible?: boolean;
    };
  }>;
};

async function main() {
  const input = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "case-target-v13-canary-5.json"));
  const manifest = JSON.parse(await readFile(input, "utf8")) as PairFile;
  const rows: Array<Record<string, unknown>> = await Promise.all(
    manifest.pairs.map(async (pair) => {
      const record = await loadCase({
        documentId: pair.document_id,
        dataset: pair.source.dataset,
        citation: pair.source.citation,
        name: pair.source.name,
        date: pair.source.date,
        target: {
          documentId: pair.target.document_id,
          citation: pair.target.citation,
          citationAliases: pair.target.citation_aliases ?? [],
          name: pair.target.name,
          sameLitigationEligible: pair.target.same_litigation_eligible === true,
        },
      });
      if (!record) throw new Error(`missing A2AJ document ${pair.document_id}`);
      const packet = caseTargetMvpPacket(record, "nested");
      if (!packet.endsWith(record.source.text)) throw new Error(`${pair.document_id}: source is not the exact packet suffix`);
      const prefix = packet.slice(0, -record.source.text.length);
      if (prefix.includes(record.source.text)) throw new Error(`${pair.document_id}: source text is duplicated in packet scaffolding`);
      return {
        document_id: pair.document_id,
        dataset: pair.source.dataset,
        source_chars: record.source.text.length,
        packet_chars: packet.length,
        non_source_chars: packet.length - record.source.text.length,
        citation_occurrences: record.targetOccurrences.filter(({ kind }) => kind === "citation").length,
        case_name_occurrences: record.targetOccurrences.filter(({ kind }) => kind === "case_name").length,
      };
    }),
  );

  console.log(JSON.stringify({
    input,
    schema_chars: JSON.stringify(CASE_TARGET_MVP_JSON_SCHEMA).length,
    rows,
  }, null, 2));
}

void main();
