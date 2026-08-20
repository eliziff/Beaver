/**
 * Small-model verifier-loop experiment: can a local Qwen (via ollama on the
 * desktop PC) translate the amendment instructions our deterministic grammar
 * REFUSES (definition-scoped / portion-scoped heads) into typed AmendOps that
 * `applyAmendOps` — acting as a rejection sampler — applies and verifies
 * against the real current consolidation?
 *
 * Division of labor under test (the product thesis): deterministic parser
 * first; the model only on refused residues, over a BOUNDED excerpt (lean
 * context); the deterministic applier gates every model output, and gold is
 * exact-match against today's law (A2AJ corpus text) — the NLLP-2025
 * "exactness, not similarity" bar.
 *
 * Cases:
 *  1. SC 2021 c 11 s.4 — definition "general holiday" in s.166 Canada Labour
 *     Code (pre-text reconstructed by removing the NDTR entry the Act added;
 *     gold = current corpus text verbatim).
 *  2. SC 2021 c 11 s.3 — portion of definition "holiday" in s.35(1)
 *     Interpretation Act before paragraph (a) (same reconstruction).
 *  3. Synthetic definition swap on the unit-test STATUTE fixture.
 *
 * Usage:
 *   npx tsx scripts/ollama-amend-loop.ts [--url http://127.0.0.1:11434]
 *     [--models qwen3:32b,qwen3:8b] [--samples 3] [--out attempts.jsonl]
 */
import { appendFileSync, writeFileSync } from "node:fs";

import { applyAmendOps, type AmendOp } from "../src/lib/legalAmendOps";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const URL_BASE = argument("url", "http://127.0.0.1:11434").replace(/\/$/u, "");
const SAMPLES = Number(argument("samples", "3"));
const OUT = argument("out", "");
const CALL_TIMEOUT_MS = 420_000; // cold model loads on the desktop GPU are slow

const NDTR = "National Day for Truth and Reconciliation, which is observed on September 30";

// ---- Case 1: CLC s.166 (definition-scoped; grammar refuses) ----
const CLC_GOLD_DEF =
  "general holiday means New Year’s Day, Good Friday, Victoria Day, Canada Day, " +
  `Labour Day, ${NDTR}, Thanksgiving Day, Remembrance Day, Christmas Day and ` +
  "Boxing Day and includes any day substituted for any such holiday under " +
  "section 195; (jours fériés)";
const CLC_NEIGHBOURS = [
  "health care practitioner means a person lawfully entitled, under the laws " +
    "of a province, to provide health services in the place in which they " +
    "provide those services; (professionnel de la santé)",
];
const CLC_PRE = [
  "166. In this Division,",
  CLC_GOLD_DEF.replace(`Labour Day, ${NDTR}, Thanksgiving`, "Labour Day, Thanksgiving"),
  ...CLC_NEIGHBOURS,
].join("\n\n");
const CLC_GOLD = ["166. In this Division,", CLC_GOLD_DEF, ...CLC_NEIGHBOURS].join("\n\n");
const CLC_INSTRUCTION =
  "The definition general holiday in section 166 of the Canada Labour Code " +
  "is replaced by the following:\n\ngeneral holiday means New Year’s Day, " +
  "Good Friday, Victoria Day, Canada Day, Labour Day, National Day for Truth " +
  "and Reconciliation, which is observed on September 30, Thanksgiving Day, " +
  "Remembrance Day, Christmas Day and Boxing Day and includes any day " +
  "substituted for any such holiday under section 195; (jours fériés)";

// ---- Case 2: Interpretation Act s.35(1) (portion-scoped; grammar refuses) ----
const IA_GOLD_CHAPEAU =
  "holiday means any of the following days, namely, Sunday; New Year’s Day; " +
  "Good Friday; Easter Monday; Christmas Day; the birthday or the day fixed " +
  "by proclamation for the celebration of the birthday of the reigning " +
  `Sovereign; Victoria Day; Canada Day; the first Monday in September, ` +
  `designated Labour Day; ${NDTR}; Remembrance Day; any day appointed by ` +
  "proclamation to be observed as a day of general prayer or mourning or day " +
  "of public rejoicing or thanksgiving; and any of the following additional " +
  "days, namely,";
const IA_TAIL = [
  "(a) in any province, any day appointed by proclamation of the lieutenant " +
    "governor of the province to be observed as a public holiday or as a day " +
    "of general prayer or mourning or day of public rejoicing or thanksgiving " +
    "within the province, and any day that is a non-juridical day by virtue " +
    "of an Act of the legislature of the province, and",
  "(b) in any city, town, municipality or other organized district, any day " +
    "appointed to be observed as a civic holiday by resolution of the council " +
    "or other authority charged with the administration of the civic or " +
    "municipal affairs of the city, town, municipality or district; (jour férié)",
];
const IA_PRE = [
  "35. (1) In every enactment,",
  IA_GOLD_CHAPEAU.replace(`Labour Day; ${NDTR}; Remembrance`, "Labour Day; Remembrance"),
  ...IA_TAIL,
].join("\n\n");
const IA_GOLD = ["35. (1) In every enactment,", IA_GOLD_CHAPEAU, ...IA_TAIL].join("\n\n");
const IA_INSTRUCTION =
  "The portion of the definition holiday in subsection 35(1) of the " +
  "Interpretation Act before paragraph (a) is replaced by the following:\n\n" +
  IA_GOLD_CHAPEAU;

// ---- Case 3: synthetic definition swap on the unit-test statute ----
const SYN_PRE = [
  "1. In this Act, “Minister” means the Minister of Justice.",
  "",
  "5. (1) A person may apply to the Minister for a permit.",
  "",
  "(2) The Minister shall respond within sixty days after the application.",
].join("\n");
const SYN_GOLD = SYN_PRE.replace("Minister of Justice", "Minister of Public Safety");
const SYN_INSTRUCTION =
  "The definition Minister in section 1 of the Act is replaced by the " +
  "following:\n\n“Minister” means the Minister of Public Safety.";

export // ---- Case 4: CLC art. 166 (fr) — the same definition, French version;
// chapeau and neighbour are verbatim corpus text (equal authenticity). ----
const CLC_FR_GOLD_DEF =
  "jours fériés Le 1er janvier, le vendredi saint, la fête de Victoria, la " +
  "fête du Canada, la fête du Travail, la Journée nationale de la vérité et " +
  "de la réconciliation, qui a lieu le 30 septembre, le jour de l’Action de " +
  "grâces, le jour du Souvenir, le jour de Noël et le lendemain de Noël; " +
  "s’entend également de tout jour de substitution fixé dans le cadre de " +
  "l’article 195. (general holiday)";
const CLC_FR_NEIGHBOUR =
  "professionnel de la santé Personne légalement autorisée en vertu de la " +
  "loi d’une province à fournir des services de santé au lieu où elle les " +
  "fournit. (health care practitioner)";
const CLC_FR_CHAPEAU =
  "166. Les définitions qui suivent s’appliquent à la présente partie.";
const CLC_FR_PRE = [
  CLC_FR_CHAPEAU,
  CLC_FR_GOLD_DEF.replace(
    "la fête du Travail, la Journée nationale de la vérité et de la " +
      "réconciliation, qui a lieu le 30 septembre, le jour",
    "la fête du Travail, le jour",
  ),
  CLC_FR_NEIGHBOUR,
].join("\n\n");
const CLC_FR_GOLD = [CLC_FR_CHAPEAU, CLC_FR_GOLD_DEF, CLC_FR_NEIGHBOUR].join("\n\n");
const CLC_FR_INSTRUCTION =
  "La définition de jours fériés, à l’article 166 du Code canadien du " +
  "travail, est remplacée par ce qui suit :\n\n" + CLC_FR_GOLD_DEF;

type Case = { id: string; instruction: string; pre: string; gold: string };
export const CASES: Case[] = [
  { id: "clc-s166-definition", instruction: CLC_INSTRUCTION, pre: CLC_PRE, gold: CLC_GOLD },
  { id: "ia-s35(1)-portion", instruction: IA_INSTRUCTION, pre: IA_PRE, gold: IA_GOLD },
  { id: "synthetic-definition", instruction: SYN_INSTRUCTION, pre: SYN_PRE, gold: SYN_GOLD },
  { id: "clc-s166-definition-fr", instruction: CLC_FR_INSTRUCTION, pre: CLC_FR_PRE, gold: CLC_FR_GOLD },
];

const SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["substitute_text", "replace_provision"] },
          target: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["kind", "target", "newText"],
      },
    },
  },
  required: ["ops"],
} as const;

const SYSTEM_PROMPT = [
  "You compile a legal amendment instruction into typed edit operations on",
  "the current provision text. Output only the JSON object.",
  "Rules:",
  "- target is the provision key: sec166, sec35(1), sec1, sec5(2), ...",
  '- substitute_text replaces oldText with newText inside the target;',
  "  oldText must be copied VERBATIM from the current text (every character,",
  "  accent and punctuation mark identical) and long enough to be unique.",
  "- replace_provision replaces the target's entire text with newText.",
  "- Prefer the narrowest edit that fully implements the instruction: a",
  "  definition or a portion of a provision is edited with substitute_text,",
  "  never by replacing the whole provision.",
].join("\n");

const normalize = (text: string) =>
  text
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim();

type Attempt = {
  model: string;
  case_id: string;
  sample: number;
  outcome:
    | "exact_match"
    | "not_concordant"
    | `apply_failed:${string}`
    | "schema_invalid"
    | `call_error:${string}`;
  op_kinds: string[];
  latency_ms: number;
  prompt_eval_count: number | null;
  eval_count: number | null;
};

async function listModels(): Promise<string[]> {
  const response = await fetch(`${URL_BASE}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((m) => m.name);
}

async function callModel(model: string, testCase: Case) {
  const started = Date.now();
  const request = {
    model,
    stream: false,
    format: SCHEMA,
    // Thinking stays on (user directive: measure the models with their
    // reasoning intact); structured `format` constrains the content channel.
    options: { temperature: 0.2, num_ctx: 8192 },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `CURRENT TEXT:\n${testCase.pre}\n\nAMENDING INSTRUCTION:\n` +
          `${testCase.instruction}\n\nOutput the ops JSON.`,
      },
    ],
  };
  // The tailscale-serve TCP path drops idle-reused connections and the
  // route can flap for a beat (ECONNRESET / ENETUNREACH) — retry those.
  let lastNetworkError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));
    try {
      const response = await fetch(`${URL_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      return {
        content: body.message?.content ?? "",
        latencyMs: Date.now() - started,
        promptEval: body.prompt_eval_count ?? null,
        evalCount: body.eval_count ?? null,
      };
    } catch (error) {
      lastNetworkError = error;
    }
  }
  throw lastNetworkError;
}

export async function judge(
  testCase: Case,
  content: string,
): Promise<{ outcome: Attempt["outcome"]; kinds: string[] }> {
  let ops: AmendOp[];
  try {
    const parsed = JSON.parse(content) as { ops?: AmendOp[] };
    if (!Array.isArray(parsed.ops) || parsed.ops.length === 0)
      return { outcome: "schema_invalid", kinds: [] };
    ops = parsed.ops;
  } catch {
    return { outcome: "schema_invalid", kinds: [] };
  }
  const kinds = ops.map((op) => op.kind);
  // Every case's pre-text is A2AJ consolidation text (case 3 is the unit-test
  // statute fixture), so the line breaks are the publisher's and there is no
  // extraction damage to recover: the segmentation competition must not run.
  const result = await applyAmendOps(testCase.pre, ops, { recoverExtraction: false });
  if (result.failures.length)
    return { outcome: `apply_failed:${result.failures[0].code}`, kinds };
  return {
    outcome:
      normalize(result.text) === normalize(testCase.gold)
        ? "exact_match"
        : "not_concordant",
    kinds,
  };
}

async function main() {
  const available = await listModels();
  const wanted = argument("models", "");
  const models = wanted
    ? wanted.split(",").map((m) => m.trim())
    : available.filter((name) => /qwen/iu.test(name));
  if (!models.length) throw new Error(`no qwen models in tags: ${available.join(", ")}`);
  console.log(`ollama at ${URL_BASE}; models: ${models.join(", ")}; samples=${SAMPLES}`);
  if (OUT) writeFileSync(OUT, "");

  const attempts: Attempt[] = [];
  for (const model of models) {
    for (const testCase of CASES) {
      for (let sample = 1; sample <= SAMPLES; sample += 1) {
        let attempt: Attempt;
        try {
          const call = await callModel(model, testCase);
          const verdict = await judge(testCase, call.content);
          attempt = {
            model,
            case_id: testCase.id,
            sample,
            outcome: verdict.outcome,
            op_kinds: verdict.kinds,
            latency_ms: call.latencyMs,
            prompt_eval_count: call.promptEval,
            eval_count: call.evalCount,
          };
          if (OUT)
            appendFileSync(
              OUT,
              `${JSON.stringify({ ...attempt, raw: call.content.slice(0, 4000) })}\n`,
            );
        } catch (error) {
          const cause = (error as { cause?: unknown })?.cause;
          attempt = {
            model,
            case_id: testCase.id,
            sample,
            outcome: `call_error:${String(cause ?? error).slice(0, 120)}`,
            op_kinds: [],
            latency_ms: 0,
            prompt_eval_count: null,
            eval_count: null,
          };
        }
        attempts.push(attempt);
        console.log(
          `  ${model}  ${testCase.id}  #${sample}  ${attempt.outcome}  ` +
            `${attempt.latency_ms}ms  ops=[${attempt.op_kinds.join(",")}]`,
        );
      }
    }
  }

  console.log("\n== per-model summary (verifier-gated, exact-match gold) ==");
  for (const model of models) {
    const mine = attempts.filter((a) => a.model === model);
    const exact = mine.filter((a) => a.outcome === "exact_match").length;
    const applied = mine.filter(
      (a) => a.outcome === "exact_match" || a.outcome === "not_concordant",
    ).length;
    const latencies = mine.filter((a) => a.latency_ms > 0).map((a) => a.latency_ms);
    const median = latencies.sort((x, y) => x - y)[Math.floor(latencies.length / 2)] ?? 0;
    console.log(
      `${model}: exact ${exact}/${mine.length}, applier-accepted ${applied}/${mine.length}, ` +
        `median latency ${median}ms`,
    );
  }
}

if (/ollama-amend-loop/u.test(process.argv[1] ?? ""))
  main().catch((error) => {
    console.error("[ollama-amend-loop]", error);
    process.exit(1);
  });
