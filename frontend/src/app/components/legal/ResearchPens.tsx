import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";
import { Modal } from "../modals/Modal";
import { researchLabelPath } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelCircle";
import { ResearchHierarchy } from "./ResearchHierarchy";
import type { ResearchRemoval } from "./ResearchTree";
import { useSourcesWorkspace } from "./SourcesWorkspace";

/** Selecting a type selects its colour and meaning together. Editing is disclosed on demand. */
export function ResearchPens({ onRemove, onStatus }: {
  onRemove: (removal: ResearchRemoval) => void; onStatus: (message: string) => void;
}) {
  const { file, highlight } = useSourcesWorkspace();
  const [editing, setEditing] = useState(false);
  const labels = file?.state.labels ?? {};
  const path = (id: string) => researchLabelPath(labels, id).map(({ name }) => name).join(" › ");
  const types = Object.values(labels).filter(({ scope }) => scope === "highlight");
  // Compare ancestry order, so descendants immediately follow their parent.
  types.sort((a, b) => {
    const left = researchLabelPath(labels, a.id), right = researchLabelPath(labels, b.id);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i].id !== right[i].id) return left[i].order - right[i].order || left[i].id.localeCompare(right[i].id);
    }
    return left.length - right.length;
  });
  const active = types.find(({ id }) => id === highlight.pen) ?? types[0];
  if (!file) return null;
  return <>
    <ActionMenu label="Choose highlight type" className="min-w-0 max-w-full shrink" triggerClassName="h-8 min-w-0 max-w-full items-center gap-1.5 rounded px-2 text-xs text-gray-700 hover:bg-gray-100"
      items={[...types.map((type) => ({ label: path(type.id), icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: researchLabelColor(type) }} />, checked: active?.id === type.id, onSelect: () => highlight.setPen(type.id) })),
        { label: "Edit highlight types…", onSelect: () => setEditing(true) }]}>
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: active ? researchLabelColor(active) : "#d6b656" }} />
      <span className="max-w-48 truncate">{active ? path(active.id) : "Highlight"}</span><ChevronDown className="size-3 shrink-0" aria-hidden="true" />
    </ActionMenu>
    <Modal open={editing} onClose={() => setEditing(false)} size="sm" breadcrumbs={["Highlight types"]}
      className="h-fit max-h-[min(600px,calc(100dvh-2rem))]"
      cancelAction={{ label: "Done", onClick: () => setEditing(false) }}>
      <ResearchHierarchy scope="highlight" selectedId={active?.id} onSelect={(id) => highlight.setPen(id)}
        onStatus={onStatus} onRemove={(removal) => { setEditing(false); onRemove(removal); }} />
    </Modal>
  </>;
}
