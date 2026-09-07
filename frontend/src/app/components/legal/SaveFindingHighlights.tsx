import { useState } from "react";
import { saveFindingHighlights, type ResearchFindingReference } from "@/app/lib/api/researchFiles";
import { researchLabelPath } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { useSourcesWorkspace } from "./SourcesWorkspace";

/** Deliberately save actual claim support, using the existing highlight type (colour and meaning). */
export function SaveFindingHighlights({ references, tableId }: {
  references: ResearchFindingReference[]; tableId?: string;
}) {
  const workspace = useSourcesWorkspace();
  const [typeId, setTypeId] = useState<string | undefined>(), [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""), [error, setError] = useState("");
  const types = Object.values(workspace.file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight"),
    active = typeId ?? workspace.highlight.pen ?? "";
  return <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
    <select aria-label="Save highlight type" value={types.some(({ id }) => id === active) ? active : ""}
      onChange={(event) => { setTypeId(event.target.value); setStatus(""); }} disabled={busy}
      className="h-7 max-w-44 rounded border border-gray-200 bg-transparent px-1 text-gray-700">
      <option value="">Highlight</option>
      {types.map((type) => <option key={type.id} value={type.id}>
        {researchLabelPath(workspace.file!.state.labels, type.id).map(({ name }) => name).join(" › ")}
      </option>)}
    </select>
    <Button size="compact" variant="outline" disabled={busy || !references.length} onClick={async () => {
      setBusy(true); setError(""); setStatus("");
      try {
        const file = tableId ? await workspace.ensure({ tableId }) : workspace.file;
        if (!file) throw new Error("Open a research set first");
        if (active && file.state.labels[active]?.scope !== "highlight") throw new Error("That highlight type changed. Choose it again.");
        const selectedType = active || undefined;
        const saved = await saveFindingHighlights(file, references, selectedType);
        workspace.accept(saved.file); setStatus(`${saved.saved} highlight${saved.saved === 1 ? "" : "s"} saved`);
      } catch (reason) { setError(errorMessage(reason, "Could not save highlights")); }
      finally { setBusy(false); }
    }}>{busy ? "Saving…" : "Save highlights"}</Button>
    {status && <span role="status" className="text-gray-600">{status}</span>}
    {error && <span role="alert" className="text-red-700">{error}</span>}
  </div>;
}
