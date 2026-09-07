import { useState } from "react";
import { Plus } from "lucide-react";
import { InlineNameInput } from "../shared/InlineNameInput";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { researchLabelPath, type ResearchAction, type ResearchLabel } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelColor } from "./ResearchLabelCircle";
import type { ResearchRemoval } from "./ResearchTree";
import { useSourcesWorkspace } from "./SourcesWorkspace";

/** Choosing a type chooses its colour; there is no independent pen palette. */
export function ResearchHighlightTypes({ onRemove, onStatus }: {
  onRemove: (removal: ResearchRemoval) => void; onStatus: (message: string) => void }) {
  const { file, mutations: commit, highlight } = useSourcesWorkspace();
  const [renaming, setRenaming] = useState<string | null>(null), [coloring, setColoring] = useState<string | null>(null);
  const pens = Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight")
    .sort((a, b) => a.order - b.order);
  async function act(action: ResearchAction) {
    try { return await commit.act(action); }
    catch (reason) { onStatus(errorMessage(reason, "Could not update highlight types")); return null; }
  }
  const add = async () => { const id = crypto.randomUUID();
    if (await act({ type: "label", id, name: "New highlight type", parentId: null, scope: "highlight", color: "#eab308" })) {
      highlight.setPen(id); setRenaming(id); } };
  if (!file) return null;
  return <div role="group" aria-label="Highlight types" className="flex min-w-0 flex-wrap items-center gap-1">
    {pens.map((pen: ResearchLabel) => renaming === pen.id
      ? <span key={pen.id} className="inline-flex h-7 min-w-24 items-center rounded-md border border-gray-300 px-1.5">
        <InlineNameInput kind="folder" value={pen.name} label="Highlight type name" onCancel={() => setRenaming(null)}
          onCommit={(value) => { setRenaming(null);
            if (value.trim() && value !== pen.name) void act({ type: "label", ...pen, name: value.trim() }); }} />
      </span>
      : <span key={pen.id} className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md border border-gray-300 ps-1.5">
        <button type="button" aria-pressed={highlight.pen === pen.id}
          onClick={() => highlight.setPen(pen.id)}
          className="inline-flex min-w-0 items-center gap-1 text-xs aria-pressed:font-semibold">
          {coloring === pen.id
            ? <input type="color" autoFocus aria-label={`${pen.name} colour`} value={researchLabelColor(pen)}
              onBlur={() => setColoring(null)} onChange={(event) => void act({ type: "label", ...pen, color: event.target.value })}
              className="size-4 cursor-pointer border-0 bg-transparent p-0" />
            : <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: researchLabelColor(pen) }} />}
          <span className="max-w-32 truncate">{researchLabelPath(file.state.labels, pen.id).map(({ name }) => name).join(" / ")}</span>
        </button>
        <MoreActionsMenu label={`${pen.name} options`} triggerClassName="grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:text-gray-900"
          items={[{ label: "Rename", onSelect: () => setRenaming(pen.id) },
            { label: "Colour", onSelect: () => setColoring(pen.id) },
            { label: "Delete", onSelect: () => onRemove({ kind: "label", id: pen.id, name: pen.name }) }]} />
      </span>)}
    <button type="button" aria-label="Add highlight type" onClick={() => void add()}
      className="grid size-7 shrink-0 place-items-center rounded-md border border-dashed border-gray-300 text-gray-500 hover:border-gray-500 hover:text-gray-800">
      <Plus aria-hidden="true" className="size-3.5" />
    </button>
  </div>;
}
