import { MAX_WORD_EDITS, MAX_WORD_ANCHOR_CHARS, WORD_FORMATS, parseWordEdits } from
  "mike/shared/word-edits.mjs";
import { jsonRecord } from "../value";
import type { ChatToolContext } from "./turnEngine";
import { objectSchema, toolText, type BeaverTool } from "./toolRegistry";

export const READ_ACTIVE_DOCUMENT = "read_active_document";
export const APPLY_WORD_EDITS = "apply_word_edits";
const MAX_READ_CHARS = 50_000;

export type WordClientCall = (
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;


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
      `most ${MAX_WORD_ANCHOR_CHARS} characters in one paragraph. Omit occurrence ` +
      "unless the user explicitly requested replace-all. Review mode writes native " +
      "Word tracked changes; Direct mode writes ordinary edits. Inspect each returned " +
      "status and retry only not-found or ambiguous rows with a better exact anchor.",
    inputSchema: objectSchema({
      edits: {
        type: "array", minItems: 1, maxItems: MAX_WORD_EDITS,
        items: objectSchema({
          original: { type: "string", minLength: 1, maxLength: MAX_WORD_ANCHOR_CHARS },
          replacement: { type: "string", maxLength: 10_000 },
          formats: { type: "array", minItems: 1, uniqueItems: true,
            items: { type: "string", enum: WORD_FORMATS } },
          occurrence: { type: "string", enum: ["all"] },
          reason: { type: "string", maxLength: 500 },
        }, ["original"]),
      },
    }, ["edits"]),
    async execute(input, _context, signal) {
      const parsed = parseWordEdits(input.edits);
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
