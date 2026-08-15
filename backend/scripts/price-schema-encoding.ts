/**
 * Price the tool-schema mass under V0 (today's JSON Schema encoding)
 * vs V3 (signature + full tool description) over the LIVE tool roster,
 * so the survey-era -58% claim is re-measured against the current
 * surface rather than trusted. Token estimate is chars/4 (the same
 * estimate the arm runner reports); the authoritative number is the
 * first-round input_tokens delta between A/B arms.
 *
 *     npx tsx scripts/price-schema-encoding.ts
 */
import { ASSISTANT_TOOLS } from "../src/lib/chat/assistantTools";
import { encodeToolV3 } from "../src/lib/llm/schemaEncoding";

function main(): void {
  const rows: Array<{ name: string; v0: number; v3: number }> = [];
  for (const tool of ASSISTANT_TOOLS) {
    const v0 = JSON.stringify({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }).length;
    const v3 = JSON.stringify({
      type: "function",
      ...encodeToolV3(tool),
    }).length;
    rows.push({ name: tool.function.name, v0, v3 });
  }
  rows.sort((a, b) => b.v0 - a.v0);
  let t0 = 0;
  let t3 = 0;
  console.log("tool                                   V0chars  V3chars  saved");
  for (const row of rows) {
    t0 += row.v0;
    t3 += row.v3;
    const pct = Math.round((1 - row.v3 / row.v0) * 100);
    console.log(
      `${row.name.padEnd(38)} ${String(row.v0).padStart(7)} ${String(row.v3).padStart(8)} ${String(pct).padStart(5)}%`,
    );
  }
  const pct = Math.round((1 - t3 / t0) * 100);
  console.log(
    `TOTAL ${String(rows.length).padStart(2)} tools`.padEnd(38) +
      ` ${String(t0).padStart(7)} ${String(t3).padStart(8)} ${String(pct).padStart(5)}%`,
  );
  console.log(
    `token estimate (chars/4): V0 ~${Math.round(t0 / 4)}, V3 ~${Math.round(t3 / 4)}, saved ~${Math.round((t0 - t3) / 4)}`,
  );
}

main();
