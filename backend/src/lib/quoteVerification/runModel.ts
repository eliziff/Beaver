// The quote verifier's AI run modes:
//   high_accuracy: the model reads every note;
//   economy: a note that is only ibid and supra clauses is left to the engine, unless it starts with an ibid and
//     the note before it ends without a link;
//   ultra_economy: also a note the engine splits completely, every part's fields complete, no reference among them
//     and every decision or statute linked;
// and in each, a supra the engine leaves unresolved is given to the model to choose among the earlier parts.
// Free mode never reaches this module. The model is Beaver's note split model (noteSplitModel.ts) over any model with
// the structured contract: a model the person connected in an app, or Beaver's own.
import type { StructuredLlm } from "../llm/keyConnection";
import { chooseReferenceTarget, splitNotesWithModel } from "../noteSplitModel";
import { structureNative } from "../structureNative";
import type { AlrCandidate, AlrModel, AlrModelNote } from "./checkedWorkbook";

export type AlrRunMode = "high_accuracy" | "economy" | "ultra_economy";
export const RUN_MODES: readonly AlrRunMode[] = ["high_accuracy", "economy", "ultra_economy"];

const engine = <T>(method: string, request: unknown) => structureNative().citationEngineCall(method, JSON.stringify(request)) as T;
const isIbid = (text: string) => engine<{ kind: string }>("referenceInfo", { text }).kind === "ibid";

/** Whether the run mode leaves the note to the engine. */
function engineReads(runMode: AlrRunMode, note: AlrModelNote, previous?: AlrModelNote) {
  if (!note.text.trim()) return true;
  if (runMode === "high_accuracy") return false;
  const clauses = engine<Array<{ text: string }> | null>("pureReferenceClauses", { text: note.text });
  if (clauses?.length) return !isIbid(clauses[0].text) || !!previous?.parts.at(-1)?.link;
  if (runMode !== "ultra_economy") return false;
  const split = engine<{ status: string; parts: unknown[] }>("splitSources", { text: note.text, recallFirst: false, offsetUnit: "utf16" });
  if (split.status !== "deterministic_complete") return false;
  const fields = split.parts.map((part) => engine<{ status: string; kind: string }>("sourceFields", { part }));
  return fields.every((field) => field.status === "complete") && note.parts.every((part) => !part.reference)
    && note.parts.every((part) => !["case", "unreported", "statute"].includes(part.kind) || !!part.link);
}

/** `limit` at once, in order. */
async function each<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; results[at] = await work(items[at]); }
  }));
  return results;
}

/** The run mode over a model: `llm` is any model with the structured contract. `progress` says what it is doing;
 *  `stats` counts the requests asked. */
export function alrModel(llm: StructuredLlm, runMode: AlrRunMode, progress: (message: string) => void = () => {}) {
  const stats = { requests: 0, notes: 0, references: 0 };
  const model: AlrModel = {
    async split(notes, signal) {
      const read = notes.filter((note, index) => !engineReads(runMode, note, notes[index - 1]));
      stats.notes = read.length;
      if (!read.length) return new Map();
      const { parts, requests } = await splitNotesWithModel(llm, read.map((note) => ({ id: String(note.index), text: note.text })),
        { signal, progress: (done, total) => progress(`Reading ${read.length} footnote${read.length === 1 ? "" : "s"} with the model: ${done} of ${total} requests`) });
      stats.requests += requests;
      return new Map(read.flatMap((note) => {
        const placed = parts.get(String(note.index));
        return placed ? [[note.index, placed.map(({ start, end, fields }) => ({ start, end, fields }))] as const] : [];
      }));
    },
    async choose(references, signal) {
      stats.references = references.length;
      let done = 0;
      return each(references, 4, async ({ text, earlier, proposition }) => {
        progress(`Finding what ${references.length} supra reference${references.length === 1 ? "" : "s"} name: ${done} of ${references.length}`);
        const { chosen } = await chooseReferenceTarget(llm, text, earlier, proposition, signal);
        stats.requests += 1; done += 1;
        return chosen as AlrCandidate | null;
      });
    },
  };
  return { model, stats };
}
