import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";
import { buttonClassName } from "../ui/button";
import { useResearchFileMutations, type ResearchFileMutations } from "../legal/useResearchFileMutations";
import { researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";

type Selection = { file: ResearchFile; selection: ResearchSelection };
export function ResearchSelectionLabels({ prepare, mutations, onChange }: {
  prepare: () => Selection | Promise<Selection>;
  mutations?: ResearchFileMutations; onChange?: (file: ResearchFile) => void;
}) {
  const navigate = useNavigate();
  const [ready, setReady] = useState<Selection | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const local = useResearchFileMutations(ready?.file ?? null, (file) => {
    setReady((current) => current ? { ...current, file } : null); onChange?.(file);
  });
  const commit = mutations ?? local;
  const labels = Object.values(ready?.file.state.labels ?? {}).filter(({ scope }) =>
    scope === (ready?.selection.target === "passages" ? "highlight" : "source"));
  const run = (id: string, mode: "add" | "remove") => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    void commit.act({ type: "label-selection", ...ready.selection, assign: [id], mode })
      .catch((reason) => setError(errorMessage(reason, "Could not update labels"))).finally(() => setBusy(false));
  };
  return <span className="relative inline-flex">
    <ActionMenu label="Labels for selection" onOpen={() => {
      setBusy(true); setError(""); setReady(null); void Promise.resolve().then(prepare).then((next) => {
        if (next.selection.sourceIds?.length === 0 || next.selection.target === "passages" &&
          (next.selection.evidenceIds?.length === 0 || next.selection.labelIds?.length === 0 && !next.selection.unlabelled))
          throw new Error(`No ${next.selection.target} selected`);
        setReady(next);
      })
        .catch((reason) => setError(errorMessage(reason, "Could not load labels"))).finally(() => setBusy(false));
    }} triggerClassName={buttonClassName({ variant: "outline", size: "compact" })}
      items={busy || !ready ? [{ label: error || "Loading labels…", disabled: true, onSelect() {} }]
        : labels.length ? labels.flatMap(({ id }) => {
          const path = researchLabelPath(ready.file.state.labels, id).map(({ name }) => name).join(" / ");
          return [{ label: `Add ${path}`, onSelect: () => run(id, "add") },
            { label: `Remove ${path}`, onSelect: () => run(id, "remove") }];
        }) : [{ label: "Create labels in workspace", onSelect: () => navigate(`/sources?research_file=${encodeURIComponent(ready.file.document.id)}`) }]}>
      Labels<ChevronDown aria-hidden className="size-3.5" />
    </ActionMenu>
    {error && <span role="alert" className="absolute end-0 top-full z-50 mt-1 w-64 rounded border border-red-200 bg-white p-2 text-sm text-red-700">{error}</span>}
  </span>;
}
