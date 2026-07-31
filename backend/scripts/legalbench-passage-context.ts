/**
 * Offline contextual-enrichment header generation (Stage 18 R5): one
 * flat-rate LLM call per passage of the crowned LegalBench-RAG index
 * (chars t1600/o120, ~6k passages) writes a 1-2 sentence situating
 * header, later indexed in the FTS `context` column via
 * `PassageIndexOptions.contextJsonl` (Anthropic contextual-retrieval
 * pattern). The header NEVER replaces passage text — retrieval still
 * returns verbatim source slices at exact offsets; enrichment only
 * adds searchable words to the index.
 *
 * Usage (from backend/):
 *   npx tsx scripts/legalbench-passage-context.ts \
 *     [--model codex:gpt-5.6-luna] [--effort low] [--concurrency 3] \
 *     [--resume 1] [--limit 0]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { completeText } from "../src/lib/llm";
import { ensurePassageIndex } from "../src/lib/passageRetrieval";
import { LEGALBENCH_RAG_DATA_DIR } from "../src/lib/legalbenchRag";

const SYSTEM =
  "You situate a chunk of a legal document within the whole document " +
  "for search indexing. Reply with 1-2 plain sentences naming the " +
  "document, the parties or subject if identifiable, and what this " +
  "chunk specifically addresses. No preamble, no quotes, no markdown.";

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main() {
  const model = flag("model", "codex:gpt-5.6-luna");
  const effort = flag("effort", "low");
  const concurrency = Number(flag("concurrency", "3"));
  const resume = flag("resume", "0") !== "0";
  const limit = Number(flag("limit", "0"));
  const output = flag(
    "output",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "OpenLegalData/experiments/legal-grounding/2026-07-30/stage18-passage-context.jsonl",
    ),
  );
  const sourceDb = path.join(
    LEGALBENCH_RAG_DATA_DIR,
    "db",
    "a2aj-mini.sqlite",
  );
  const { indexDb } = ensurePassageIndex({
    sourceDb,
    target: 1600,
    overlap: 120,
  });

  const index = new DatabaseSync(indexDb, { readOnly: true });
  const source = new DatabaseSync(sourceDb, { readOnly: true });
  const passages = index
    .prepare(
      "SELECT id, doc_id, language, start, end FROM passage ORDER BY id",
    )
    .all() as Array<{
    id: number;
    doc_id: number;
    language: string;
    start: number;
    end: number;
  }>;
  const docStmt = source.prepare(
    "SELECT name_en, citation_en, unofficial_text_en AS text FROM document WHERE id = ?",
  );
  const docs = new Map<number, { name: string; text: string }>();
  for (const row of passages) {
    if (docs.has(row.doc_id)) continue;
    const doc = docStmt.get(row.doc_id) as
      | { name_en?: string; citation_en?: string; text?: string }
      | undefined;
    docs.set(row.doc_id, {
      name: [doc?.name_en, doc?.citation_en].filter(Boolean).join(" "),
      text: doc?.text ?? "",
    });
  }
  index.close();
  source.close();

  const done = new Set<string>();
  if (resume && existsSync(output)) {
    for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as {
        doc_id: number;
        language: string;
        start: number;
        end: number;
        error?: string;
      };
      if (!row.error)
        done.add(`${row.doc_id}|${row.language}|${row.start}|${row.end}`);
    }
  } else {
    writeFileSync(output, "", "utf8");
  }
  const todo = passages
    .filter(
      (row) => !done.has(`${row.doc_id}|${row.language}|${row.start}|${row.end}`),
    )
    .slice(0, limit > 0 ? limit : undefined);
  console.log(
    `passage-context: ${todo.length} headers to write (${done.size} resumed), model=${model}@${effort}`,
  );

  let next = 0;
  let written = 0;
  const worker = async () => {
    for (;;) {
      const at = next++;
      if (at >= todo.length) return;
      const row = todo[at];
      const doc = docs.get(row.doc_id);
      if (!doc?.text) continue;
      const chunk = doc.text.slice(row.start, row.end);
      const opening = doc.text.slice(0, 1500);
      const user = JSON.stringify({
        document_name: doc.name,
        document_opening: opening,
        chunk,
      });
      try {
        // Short low-effort calls at high concurrency trip the codex
        // 429 rate limit (measured: 1,502/2,008 rows at c=12); retry
        // with exponential backoff + jitter before recording an error.
        let reply = "";
        for (let attempt = 0; ; attempt += 1) {
          try {
            reply = await completeText({
              model,
              systemPrompt: SYSTEM,
              user,
              reasoningEffort: effort,
            });
            break;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!message.includes("429") || attempt >= 5) throw error;
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                1000 * 2 ** attempt + Math.random() * 1000,
              ),
            );
          }
        }
        const header = reply.trim().replace(/\s+/gu, " ").slice(0, 600);
        if (!header) throw new Error("empty header");
        appendFileSync(
          output,
          `${JSON.stringify({
            doc_id: row.doc_id,
            language: row.language,
            start: row.start,
            end: row.end,
            header,
          })}\n`,
          "utf8",
        );
        written += 1;
        if (written % 200 === 0)
          console.log(`${written}/${todo.length} headers written`);
      } catch (error) {
        appendFileSync(
          output,
          `${JSON.stringify({
            doc_id: row.doc_id,
            language: row.language,
            start: row.start,
            end: row.end,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
          "utf8",
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
  console.log(`done: ${written} headers, receipts ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
