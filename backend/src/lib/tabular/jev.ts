import type { LegalEvidenceReceipt } from "../chat/legalEvidence";
import type { TabularColumn } from "../tabularStore";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const MAX_REQUEST_BYTES = 100_000;
const MAX_PASSAGES = 64;
const MAX_COLUMNS = 24;

export type JevTabularMode = "off" | "shadow" | "assist";
type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type ProbeColumn = { column: TabularColumn; position: number; question: string };
export type JevTabularProbe = {
  mode: Exclude<JevTabularMode, "off">;
  model: string;
  evidence: Map<number, string>;
};

const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const threshold = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

export function jevTabularMode(): JevTabularMode {
  const value = process.env.BEAVER_JEV_TABULAR_MODE?.trim().toLowerCase();
  return value === "shadow" || value === "assist" ? value : "off";
}

/**
 * The first production use is deliberately only an evidence hint for bounded
 * columns. Beaver's existing extractor still answers every cell.
 */
export function isJevProbeColumn(column: TabularColumn) {
  return column.format === "yes_no" ||
    column.format === "tag" && !!column.tags?.length;
}

function choice(value: unknown, options: string[]): ChoiceAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>, probabilities = answer.probabilities;
  if (answer.type !== "choice" || typeof answer.choice !== "string" ||
      !options.includes(answer.choice) || !probabilities || typeof probabilities !== "object" ||
      Array.isArray(probabilities) || !probability(answer.confidence)) return null;
  const values = probabilities as Record<string, unknown>;
  if (Object.keys(values).length !== options.length ||
      !options.every((option) => probability(values[option]))) return null;
  const mass = options.reduce((sum, option) => sum + Number(values[option]), 0);
  if (Math.abs(mass - 1) > 0.025 ||
      Number(values[answer.choice]) + 1e-8 <
        Math.max(...options.map((option) => Number(values[option]))))
    return null;
  return answer as unknown as ChoiceAnswer;
}

function eligibleColumns(columns: TabularColumn[]): ProbeColumn[] {
  return columns.filter(isJevProbeColumn).slice(0, MAX_COLUMNS)
    .map((column, position) => ({ column, position, question: `e${position}` }));
}

function requestFor(columns: ProbeColumn[], passages: LegalEvidenceReceipt[], model: string) {
  const state = {
    columns: columns.map(({ column }) => ({
      index: column.index,
      prompt: column.prompt,
      format: column.format,
      ...(column.tags?.length ? { tags: column.tags } : {}),
    })),
    passages: passages.map(({ evidence_id, span_text, locator }) => ({
      evidence_id,
      text: span_text!,
      locator,
    })),
  };
  const criteria = Object.fromEntries([
    ...passages.map((_passage, index) => [
      `p${index}`,
      `The passage at passages[${index}] materially helps answer the column.`,
    ]),
    ["none", "No supplied passage materially helps answer the column."],
  ]);
  return {
    model,
    state,
    questions: Object.fromEntries(columns.map(({ position, question }) => [
      question,
      {
        type: "choice",
        instructions:
          `Which supplied passage most materially helps answer columns[${position}].prompt? ` +
          "A qualification or contrary provision is relevant evidence. " +
          "Choose none rather than infer anything from material that does not answer the question.",
        criteria,
      },
    ])),
  };
}

export async function probeTabularWithJev(input: {
  columns: TabularColumn[];
  evidence: LegalEvidenceReceipt[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<JevTabularProbe | null> {
  const mode = jevTabularMode(), apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (mode === "off" || !apiKey) return null;

  const columns = eligibleColumns(input.columns),
    passages = input.evidence
      .filter((receipt) => typeof receipt.span_text === "string" && !!receipt.span_text.trim())
      .slice(0, MAX_PASSAGES);
  if (!columns.length || !passages.length) return null;

  const model = process.env.TYPESAFE_JEV_MODEL?.trim() || DEFAULT_MODEL,
    request = requestFor(columns, passages, model),
    rawRequest = JSON.stringify(request);
  if (Buffer.byteLength(rawRequest) > MAX_REQUEST_BYTES) return null;

  const timeoutMs = Math.max(100, Math.min(10_000,
      Number(process.env.BEAVER_JEV_TIMEOUT_MS) || 1_500)),
    timeout = AbortSignal.timeout(timeoutMs),
    signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    started = Date.now();
  try {
    const response = await (input.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: rawRequest,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const object = body as Record<string, unknown>, answers = object.answers;
    if (typeof object.model !== "string" || !answers ||
        typeof answers !== "object" || Array.isArray(answers)) return null;

    const values = answers as Record<string, unknown>,
      evidence = new Map<number, string>(),
      min = threshold("BEAVER_JEV_ASSIST_MIN_PROBABILITY", 0.55),
      options = [...passages.map((_passage, index) => `p${index}`), "none"];

    for (const entry of columns) {
      const answer = choice(values[entry.question], options);
      if (!answer || answer.choice === "none" ||
          answer.probabilities[answer.choice] < min) continue;
      const passage = passages[Number(answer.choice.slice(1))];
      if (passage) evidence.set(entry.column.index, passage.evidence_id);
    }

    console.info("[jev-tabular]", {
      mode,
      model: object.model,
      columns: columns.length,
      passages: passages.length,
      hints: evidence.size,
      ms: Date.now() - started,
    });
    return { mode, model: object.model, evidence };
  } catch {
    // Jev is speculative. Its outage, malformed output, or cancellation cannot
    // turn a normal Beaver review into an incorrect or unavailable review.
    return null;
  }
}

export function jevEvidenceHint(probe: JevTabularProbe, columns: TabularColumn[]) {
  if (probe.mode === "shadow") return "";
  const names = new Map(columns.map((column) => [column.index, column.name])),
    lines = [...probe.evidence]
      .filter(([index]) => names.has(index))
      .map(([index, evidenceId]) => `- ${names.get(index)}: ${evidenceId}`);
  return lines.length
    ? `Jev identified these already-read passages as potentially relevant. They are hints, not answers: verify them, preserve qualifications, and read further whenever needed.\n${lines.join("\n")}\n\n`
    : "";
}
