// Default-export `llm` for `scripts/alr-verify.ts --llm <this file>`.
// ALR_EVAL_ARM selects the codex arm (luna-max | sol-low); ALR_EVAL_LLM_DIR is
// where answers, receipts and per-process usage totals are kept.
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODEX_ARMS, createCodexLlm, type CodexArm } from "./codexLlm";

const arm = (process.env.ALR_EVAL_ARM ?? "sol-low") as CodexArm;
if (!(arm in CODEX_ARMS)) throw new Error(`ALR_EVAL_ARM must be one of ${Object.keys(CODEX_ARMS).join(", ")}`);
const dir = resolve(process.env.ALR_EVAL_LLM_DIR ?? join(__dirname, "..", "local-data", "alr-verifier", "llm", arm));
mkdirSync(dir, { recursive: true });

const llm = createCodexLlm({
  arm,
  workDir: dir,
  receiptsPath: join(dir, "receipts.jsonl"),
  concurrency: Number(process.env.ALR_EVAL_CONCURRENCY ?? 6),
});

process.on("exit", () => {
  appendFileSync(join(dir, "process-usage.jsonl"), JSON.stringify({ arm, label: process.env.ALR_EVAL_LABEL ?? "", ...llm.stats }) + "\n");
});

export default llm;
