import type { ResearchFileState, ResearchLabel } from "mike/shared/runtime/researchContract.mjs";
import { jsonRecord as record } from "./value";
export const RESEARCH_MANIFEST_PART = "research.json";
export const validResearchIds = (value: unknown, prefix = "") => Array.isArray(value) && value.length <= 10_000 &&
  new Set(value).size === value.length && value.every((id) =>
    typeof id === "string" && id.startsWith(prefix));
/** The state as this application writes it. A file can come back edited by hand, so the label tree, which
 *  everything walks, must still be one: every parent present, in its child's scope, and no cycle. */
export function decodeResearchFileState(value: unknown): ResearchFileState | null {
  const state = record(value), labels = record(state?.labels) as Record<string, ResearchLabel> | null;
  if (state?.schemaVersion !== "beaver.research.v2" || !labels || !record(state.sources) ||
      typeof state.note !== "string") return null;
  for (const label of Object.values(labels)) {
    const seen = new Set<string>();
    for (let at: ResearchLabel | undefined = label; at?.parentId; at = labels[at.parentId]) {
      const parent = labels[at.parentId];
      if (!parent || parent.scope !== label.scope || seen.has(at.parentId)) return null;
      seen.add(at.parentId);
    }
  }
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
