import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResearchLabelDesign, ResearchLabelProposal } from "@/app/lib/api/researchFiles";
import type { ResearchAction, ResearchFile } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { SourcesWorkspace } from "./SourcesWorkspace";
import { ResearchTree, type ResearchTreePreview } from "./ResearchTree";
import { editResearchProposal, mergeResearchProposal, researchProposalTree } from "./researchProposalDraft";

/** A draft uses the Sources tree and palette. Only its mutation destination changes. */
export function ResearchProposalEditor({ file, proposal, design, onChange, disabled = false }: {
  file: ResearchFile; proposal: Pick<ResearchLabelProposal, "sources" | "items">; design: ResearchLabelDesign;
  onChange: (design: ResearchLabelDesign) => void; disabled?: boolean;
}) {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [labelId, setLabelId] = useState<string | null>(null), [typeId, setTypeId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const current = useRef(design);
  useLayoutEffect(() => { current.current = design; }, [design]);
  const projected = useMemo(() => {
    try { return { tree: researchProposalTree(file, proposal, design), error: "" }; }
    catch (reason) { return { tree: null, error: errorMessage(reason, "Could not display this proposal") }; }
  }, [file, proposal, design]);
  function change(next: ResearchLabelDesign) {
    if (disabled) throw new Error("Wait for the current operation to finish");
    const result = researchProposalTree(file, proposal, next);
    current.current = next; onChange(next); setError(""); return result.file;
  }
  async function act(action: ResearchAction) { return change(editResearchProposal(current.current, proposal, action)); }
  function merge(from: string, to: string) { change(mergeResearchProposal(current.current, from, to)); }
  const tree = projected.tree;
  const preview: ResearchTreePreview | undefined = tree ? { ...tree.preview, file: tree.file,
    ...(!disabled ? { act, merge } : {}) } : undefined;
  return <fieldset disabled={disabled} className="min-w-0 space-y-4">
    <input aria-label="Organization name" value={design.title}
      className="block w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-gray-900 hover:border-gray-200 focus:border-gray-300"
      onChange={(event) => { const next = { ...current.current, title: event.target.value }; current.current = next; onChange(next); }} />
    {(error || projected.error) && <p role="alert" className="text-sm text-red-700">{error || projected.error}</p>}
    {tree && <SourcesWorkspace file={file}>
      <section aria-label="Proposed source labels"><h3 className="mb-1 text-xs text-gray-500">Source labels</h3>
        <ResearchTree sources={tree.sources} scope="source" preview={preview} opened={opened} setOpened={setOpened}
          labelId={labelId} onLabelChange={setLabelId} onStatus={setError}
          onRemove={(item) => { if (item.kind === "label") void act({ type: "remove", kind: "label", id: item.id })
            .catch((reason) => setError(errorMessage(reason, "Could not remove this label"))); }} />
      </section>
      <section aria-label="Proposed highlight types"><h3 className="mb-1 text-xs text-gray-500">Highlight types</h3>
        <ResearchTree sources={tree.sources} scope="highlight" preview={preview} opened={opened} setOpened={setOpened}
          labelId={typeId} onLabelChange={setTypeId} onStatus={setError}
          onRemove={(item) => { if (item.kind === "label") void act({ type: "remove", kind: "label", id: item.id })
            .catch((reason) => setError(errorMessage(reason, "Could not remove this highlight type"))); }} />
      </section>
    </SourcesWorkspace>}
  </fieldset>;
}
