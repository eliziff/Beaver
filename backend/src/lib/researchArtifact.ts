import { z } from "mike/shared/runtime/schema.mjs";
import { researchSourceReferenceSchema as source, researchChangeSummarySchema,
  type ResearchFileState } from "mike/shared/runtime/researchContract.mjs";
import { jsonRecord as record } from "./value";
const uuid = z.string().uuid();
export const RESEARCH_MANIFEST_PART = "research.json";
export const validResearchIds = (value: unknown, prefix = "") => Array.isArray(value) && value.length <= 10_000 &&
  new Set(value).size === value.length && value.every((id) =>
    typeof id === "string" && id.startsWith(prefix));
const validPart = (value: unknown, max: number) => { const item = record(value); return !!item &&
  Number.isInteger(item.count) && Number(item.count) > 0 && Number(item.count) <= max &&
  typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256); };
const validPassages = (value: unknown, labels: Record<string, unknown>) => { const item = record(value),
  counts = record(item?.labelCounts), count = Number(item?.count); return validPart(value, 100_000) &&
    !!counts && Object.keys(counts).length <= 10_000 && Object.entries(counts).every(([id, value]) =>
      uuid.safeParse(id).success && record(labels[id])?.scope === "highlight" &&
      Number.isInteger(value) && Number(value) > 0 && Number(value) <= count) &&
    Number.isInteger(item?.unlabelledCount) && Number(item?.unlabelledCount) >= 0 &&
    Number(item?.unlabelledCount) <= count; };
export function decodeResearchFileState(value: unknown): ResearchFileState | null {
  const state = record(value), labels = record(state?.labels), sources = record(state?.sources);
  if (state?.schemaVersion !== "beaver.research.v2" || !labels || !sources ||
      !(state.queries === null || validPart(state.queries, 10_000)) ||
      (state.tables !== undefined && !validResearchIds(state.tables)) ||
      (state.chats !== undefined && !validResearchIds(state.chats)) ||
      (state.history !== undefined && !validPart(state.history, 10_000)) ||
      (state.proposals !== undefined && !researchChangeSummarySchema.array().max(100).safeParse(state.proposals).success) ||
      typeof state.note !== "string" || state.note.length > 250_000 ||
      Object.keys(labels).length > 10_000 || Object.keys(sources).length > 10_000) return null;
  const validLabels = (value: unknown) => validResearchIds(value) &&
    (value as string[]).every((id) => uuid.safeParse(id).success && labels[id]);
  if (Object.entries(labels).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || typeof item.name !== "string" ||
      !item.name || item.name.length > 200 || !(item.parentId === null ||
        typeof item.parentId === "string" && uuid.safeParse(item.parentId).success) ||
      !(item.color === null || typeof item.color === "string" && /^#[a-f0-9]{6}$/iu.test(item.color)) ||
      !Number.isInteger(item.order) || Number(item.order) < 0 || Number(item.order) > 1_000_000 ||
      (item.definition !== undefined && (typeof item.definition !== "string" || item.definition.length > 20_000)) ||
      (item.scope !== "source" && item.scope !== "highlight"); })) return null;
  if (Object.values(labels).some((value) => { const parent = record(value)?.parentId;
    return typeof parent === "string" && (!labels[parent] ||
      record(labels[parent])?.scope !== record(value)?.scope); })) return null;
  const visitedLabels = new Set<string>();
  for (const id of Object.keys(labels)) { const seen = new Set<string>(); let next: string | null = id;
    while (next && !visitedLabels.has(next)) { if (seen.has(next)) return null; seen.add(next);
      next = record(labels[next])?.parentId as string | null; }
    seen.forEach((labelId) => visitedLabels.add(labelId)); }
  if (Object.entries(sources).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || !source.safeParse(item.reference).success ||
      (item.collected !== undefined && typeof item.collected !== "boolean") ||
      !validLabels(item.labelIds) || (item.labelIds as string[]).some((labelId) =>
        record(labels[labelId])?.scope !== "source") || typeof item.note !== "string" ||
      item.note.length > 50_000 ||
      !(item.passages === null || validPassages(item.passages, labels));
    })) return null;
  if (Object.values(sources).reduce<number>((sum, value) =>
    sum + Number(record(record(value)?.passages)?.count ?? 0), 0) > 100_000) return null;
  return state as ResearchFileState;
}

export function researchFileMarkdown(title: string, state: ResearchFileState) {
  let passages = 0, sources = 0;
  for (const item of Object.values(state.sources)) { if (item.collected) sources++; passages += Object.values(item.passages?.labelCounts ?? {}).reduce((sum, count) => sum + count, 0); }
  const note = state.note.trim();
  return `# ${title.replace(/[\r\n#]/gu, " ").trim() || "Research"}\n\n` +
    `${sources} source${sources === 1 ? "" : "s"} · ${passages} passage${passages === 1 ? "" : "s"} · ` +
    `${state.queries?.count ?? 0} saved search${state.queries?.count === 1 ? "" : "es"}\n\n` +
    `${note ? `${note}\n\n` : ""}<!-- beaver-research:v2\n${JSON.stringify(state)}\n-->\n`;
}

export function parseResearchFile(value: Buffer | string) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value,
    marker = "<!-- beaver-research:v2\n", start = text.lastIndexOf(marker),
    end = text.indexOf("\n-->", start + marker.length);
  if (start < 0 || end <= start) return null;
  try { return decodeResearchFileState(JSON.parse(text.slice(start + marker.length, end))); }
  catch { return null; }
}


/** The memo is the document source; structured workspace state lives in one named part. */
export function researchManifestBytes(state: ResearchFileState) {
  const { note: _note, ...manifest } = state;
  return Buffer.from(JSON.stringify(manifest));
}
export function readResearchManifest(bytes: Buffer, memo: Buffer): ResearchFileState | null {
  try { return decodeResearchFileState({ ...JSON.parse(bytes.toString("utf8")), note: memo.toString("utf8") }); }
  catch { return null; }
}
