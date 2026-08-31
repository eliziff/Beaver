import type { Tool } from "../llm";
import { jsonRecord } from "../value";
import type { ChatToolContext } from "./turnEngine";
import { toolText, type BeaverTool } from "./toolRegistry";

export const READ_ACTIVE_DOCUMENT = "read_active_document";
export const APPLY_WORD_EDITS = "apply_word_edits";
const MAX_READ_CHARS = 50_000;
const MAX_EDITS = 20;
const MAX_ORIGINAL_CHARS = 255;
const FORMATS = new Set([
  "bold", "italic", "underline", "heading1", "heading2", "heading3",
]);

export type WordClientCall = (
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

type WordEdit = {
  original: string;
  replacement?: string;
  formats?: string[];
  occurrence?: "all";
  reason?: string;
};

const objectSchema = (
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

function edits(value: unknown): WordEdit[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_EDITS) return null;
  const parsed: WordEdit[] = [];
  for (const candidate of value) {
    const row = jsonRecord(candidate);
    const original = typeof row?.original === "string" ? row.original : "";
    const replacement = typeof row?.replacement === "string" ? row.replacement : undefined;
    const formats = Array.isArray(row?.formats) && row.formats.length
      ? [...new Set(row.formats.filter((item): item is string =>
          typeof item === "string" && FORMATS.has(item)))]
      : undefined;
    if (!original || original.length > MAX_ORIGINAL_CHARS || /[\r\n^]/u.test(original) ||
        (replacement === undefined) === (formats === undefined) ||
        (Array.isArray(row?.formats) && formats?.length !== row.formats.length) ||
        (replacement?.length ?? 0) > 10_000 ||
        (row?.occurrence !== undefined && row.occurrence !== "all")) return null;
    parsed.push({
      original,
      ...(replacement !== undefined ? { replacement } : {}),
      ...(formats ? { formats } : {}),
      ...(row?.occurrence === "all" ? { occurrence: "all" as const } : {}),
      ...(typeof row?.reason === "string" && row.reason.trim()
        ? { reason: row.reason.trim().slice(0, 500) } : {}),
    });
  }
  return parsed;
}

function readResult(value: unknown) {
  const row = jsonRecord(value);
  if (typeof row?.error === "string") return { error: row.error.slice(0, 500) };
  if (typeof row?.text !== "string" || row.text.length > MAX_READ_CHARS) {
    return { error: "Word returned an invalid document excerpt." };
  }
  const offset = Number.isSafeInteger(row.offset) && Number(row.offset) >= 0
    ? Number(row.offset) : 0;
  const total = Number.isSafeInteger(row.total_chars) && Number(row.total_chars) >= 0
    ? Number(row.total_chars) : offset + row.text.length;
  return {
    scope: row.scope === "selection" ? "selection" : "document",
    offset,
    text: row.text,
    total_chars: total,
    ...(offset + row.text.length < total
      ? { next_offset: offset + row.text.length } : {}),
  };
}

const OUTCOMES = new Set([
  "applied", "tracked", "not-found", "ambiguous", "skipped", "error",
]);
function applyResult(value: unknown, count: number, mode: "manual" | "auto") {
  const row = jsonRecord(value);
  const fallback = typeof row?.error === "string" ? row.error.slice(0, 500)
    : "Word did not confirm this edit.";
  const source = Array.isArray(row?.edits) ? row.edits.slice(0, count) : [];
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const candidate of source) {
    const item = jsonRecord(candidate);
    if (item && Number.isInteger(item.index) && Number(item.index) >= 0 &&
        Number(item.index) < count) byIndex.set(Number(item.index), item);
  }
  const normalized = Array.from({ length: count }, (_, index) => {
    const item = byIndex.get(index), status = String(item?.status ?? "");
    return OUTCOMES.has(status) ? {
      index,
      status,
      ...(Number.isSafeInteger(item?.matches) ? { matches: Number(item?.matches) } : {}),
      ...(typeof item?.error === "string" ? { error: item.error.slice(0, 500) } : {}),
    } : { index, status: "error", error: fallback };
  });
  const successful = normalized.filter(({ status }) =>
    status === "applied" || status === "tracked").length;
  return {
    ok: successful === count,
    mode: mode === "manual" ? "review" : "direct",
    successful,
    failed: count - successful,
    edits: normalized,
  };
}

export function wordClientTools(options: {
  call: WordClientCall;
  editMode: "manual" | "auto";
  onMutation: () => Promise<void>;
}): BeaverTool<ChatToolContext>[] {
  const read: BeaverTool<ChatToolContext> = {
    name: READ_ACTIVE_DOCUMENT,
    annotations: { readOnlyHint: true },
    activity: () => "Reading the active Word document",
    description:
      "Read text from the document currently open in Word. Read in bounded chunks; " +
      "use next_offset until the relevant passage is covered. Selection reads only " +
      "the user's current selection.",
    inputSchema: objectSchema({
      scope: { type: "string", enum: ["document", "selection"], default: "document" },
      offset: { type: "integer", minimum: 0, default: 0 },
      max_chars: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS,
        default: MAX_READ_CHARS },
    }),
    async execute(input, _context, signal) {
      const result = readResult(await options.call(READ_ACTIVE_DOCUMENT, input, signal));
      return { result: toolText(result, "error" in result) };
    },
  };
  const apply: BeaverTool<ChatToolContext> = {
    name: APPLY_WORD_EDITS,
    sequential: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    activity: () => options.editMode === "manual"
      ? "Applying tracked changes in Word" : "Editing the active Word document",
    description:
      "Edit the active Word document using exact text copied from " +
      "read_active_document. Each original must be one contiguous passage of at " +
      `most ${MAX_ORIGINAL_CHARS} characters in one paragraph. Omit occurrence ` +
      "unless the user explicitly requested replace-all. Review mode writes native " +
      "Word tracked changes; Direct mode writes ordinary edits. Inspect each returned " +
      "status and retry only not-found or ambiguous rows with a better exact anchor.",
    inputSchema: objectSchema({
      edits: {
        type: "array", minItems: 1, maxItems: MAX_EDITS,
        items: objectSchema({
          original: { type: "string", minLength: 1, maxLength: MAX_ORIGINAL_CHARS },
          replacement: { type: "string", maxLength: 10_000 },
          formats: { type: "array", minItems: 1, uniqueItems: true,
            items: { type: "string", enum: [...FORMATS] } },
          occurrence: { type: "string", enum: ["all"] },
          reason: { type: "string", maxLength: 500 },
        }, ["original"]),
      },
    }, ["edits"]),
    async execute(input, _context, signal) {
      const parsed = edits(input.edits);
      if (!parsed) return {
        result: toolText({ ok: false, error: "Invalid Word edit request." }, true),
      };
      // Persist the ordinary chat mutation fence before Word sees the request.
      // A crashed worker can then never replay a possibly-applied edit batch.
      await options.onMutation();
      const result = applyResult(await options.call(APPLY_WORD_EDITS, {
        edits: parsed,
        mode: options.editMode === "manual" ? "review" : "direct",
      }, signal), parsed.length, options.editMode);
      return { result: toolText(result, !result.ok), mutated: true };
    },
  };
  return [read, apply];
}
