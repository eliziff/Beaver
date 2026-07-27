/**
 * Prompt-cache stability check.
 *
 * The conditional spreadsheet splice is appended to the TAIL of the system
 * prompt so the static prefix stays cacheable. This script proves it with
 * the provider's own counters:
 *
 *   call 1  non-spreadsheet turn  (warms the cache)
 *   call 2  same turn shape, new question       -> expect large cached_tokens
 *   call 3  spreadsheet turn (tail splice)      -> expect cached_tokens still
 *           covering the shared static prefix, not zero
 *
 * Run from backend/:  npx tsx scripts/prompt-cache-check.ts
 */
import "dotenv/config";
import { buildMessages } from "../src/lib/chat/contextBuilders";

const MODEL = "gpt-5.4-mini";

function system(
  docs: { doc_id: string; filename: string }[],
): string {
  const messages = buildMessages(
    [{ role: "user", content: "q" }],
    docs,
  );
  return (messages[0] as { content: string }).content;
}

async function call(instructions: string, user: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input: [{ role: "user", content: user }],
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as {
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  return {
    input: json.usage?.input_tokens ?? 0,
    cached: json.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

async function main() {
  const pdfDocs = [{ doc_id: "doc-0", filename: "lease.pdf" }];
  const sheetDocs = [
    { doc_id: "doc-0", filename: "lease.pdf" },
    { doc_id: "doc-1", filename: "rent-roll.xlsx" },
  ];
  const pdfSystem = system(pdfDocs);
  const sheetSystem = system(sheetDocs);

  const sharedPrefix = (() => {
    let index = 0;
    while (
      index < pdfSystem.length &&
      pdfSystem[index] === sheetSystem[index]
    ) {
      index += 1;
    }
    return index;
  })();
  console.log(
    `system sizes: pdf=${pdfSystem.length} chars, sheet=${sheetSystem.length} chars, shared prefix=${sharedPrefix} chars (~${Math.round(sharedPrefix / 4)} tokens)`,
  );

  console.log("call 1 (pdf turn, cache warm-up)...");
  const first = await call(pdfSystem, "What should a lease term sheet cover?");
  console.log(`  input=${first.input} cached=${first.cached}`);

  console.log("call 2 (pdf turn, same shape, new question)...");
  const second = await call(pdfSystem, "List three common lease covenants.");
  console.log(`  input=${second.input} cached=${second.cached}`);

  console.log("call 3 (spreadsheet turn, tail splice)...");
  const third = await call(sheetSystem, "How should rent rolls be reviewed?");
  console.log(`  input=${third.input} cached=${third.cached}`);

  const sharedTokens = Math.round(sharedPrefix / 4);
  console.log("\n=== VERDICT ===");
  const identicalHit = second.cached > 1024;
  // OpenAI caches in 128-token increments; require the splice turn to reuse
  // most of the shared static prefix rather than starting cold.
  const spliceHit = third.cached >= Math.min(second.cached, sharedTokens) * 0.7;
  console.log(
    `identical-prefix reuse: cached ${second.cached} of ${second.input} -> ${identicalHit ? "PASS" : "FAIL"}`,
  );
  console.log(
    `tail-splice prefix reuse: cached ${third.cached} (shared prefix ~${sharedTokens} tokens) -> ${spliceHit ? "PASS" : "FAIL"}`,
  );
  process.exitCode = identicalHit && spliceHit ? 0 : 1;
}

main();
