import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";
import { buttonClassName } from "../ui/button";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { researchLabelPath, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";

export function ResearchSelectionLabels({ prepare, label = "Labels" }: { label?: string;
  prepare?: () => ResearchSelection | ResearchSelection[] | Promise<ResearchSelection | ResearchSelection[]> }) {
  const navigate = useNavigate();
  const { file, selection, mutations: commit } = useSourcesWorkspace();
  const [ready, setReady] = useState<ResearchSelection[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const labels = Object.values(file?.state.labels ?? {}).filter(({ scope }) =>
    ready?.some(({ target }) => scope === (target === "passages" ? "highlight" : "source")));
  const run = (id: string, mode: "add" | "remove", target: "sources" | "passages") => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    const scopes = ready.filter((scope) => scope.target === target), selection = scopes.length === 1 ? scopes[0] : {
      target, members: scopes.flatMap((scope) => scope.members ?? scope.sourceIds?.map((sourceId) => ({ sourceId,
        ...(scope.evidenceIds ? { evidenceIds: scope.evidenceIds } : {}) })) ?? []),
      ...(scopes[0]?.labelIds ? { labelIds: scopes[0].labelIds, unlabelled: scopes[0].unlabelled } : {}),
    };
    void commit.act({ type: "label-selection", ...selection, assign: [id], mode })
      .catch((reason) => setError(errorMessage(reason, "Could not update labels"))).finally(() => setBusy(false));
  };
  return <span className="relative inline-flex">
    <ActionMenu label={label} onOpen={() => {
      setBusy(true); setError(""); setReady(null); void Promise.resolve().then(prepare ?? (() => selection)).then((next) => {
        const scopes = (Array.isArray(next) ? next : [next]).flatMap((scope) => scope.members ? scope.members
          .filter((member) => !scope.sourceIds || scope.sourceIds.includes(member.sourceId)).map((member): ResearchSelection => ({
            ...scope, target: member.evidenceIds || scope.evidenceIds || scope.target === "passages" ? "passages" : "sources",
            members: [member],
          })) : [scope]).filter((scope) => scope.sourceIds?.length !== 0 && (scope.target !== "passages" ||
          scope.evidenceIds?.length !== 0 && (scope.labelIds?.length !== 0 || scope.unlabelled)));
        if (!scopes.length) throw new Error("Nothing selected");
        setReady(scopes);
      })
        .catch((reason) => setError(errorMessage(reason, "Could not load labels"))).finally(() => setBusy(false));
    }} triggerClassName={buttonClassName({ variant: "outline", size: "compact" })}
      items={busy || !ready || !file ? [{ label: error || "Loading labels…", disabled: true, onSelect() {} }]
        : labels.length ? labels.flatMap(({ id, scope }) => {
          const path = researchLabelPath(file.state.labels, id).map(({ name }) => name).join(" / ");
          const target = scope === "highlight" ? "passages" : "sources";
          return [{ label: `Add ${path}`, onSelect: () => run(id, "add", target) },
            { label: `Remove ${path}`, onSelect: () => run(id, "remove", target) }];
        }) : [{ label: "Create labels in workspace", onSelect: () => navigate(`/sources?research_file=${encodeURIComponent(file.document.id)}`) }]}>
      {label}<ChevronDown aria-hidden className="size-3.5" />
    </ActionMenu>
    {error && <span role="alert" className="absolute end-0 top-full z-50 mt-1 w-64 rounded border border-red-200 bg-white p-2 text-sm text-red-700">{error}</span>}
  </span>;
}
