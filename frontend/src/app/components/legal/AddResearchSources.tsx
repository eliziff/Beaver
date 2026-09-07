import { useState } from "react";
import type { Document } from "@/app/lib/api/documents";
import { actOnResearchFile, getResearchFile } from "@/app/lib/api/researchFiles";
import { isResearchDocument, researchLabelPath, researchSourceKey, type ResearchSourceReference } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { FileDirectory } from "../shared/FileDirectory";
import { Modal } from "../modals/Modal";
import { useSourcesWorkspace } from "./SourcesWorkspace";

export function AddResearchSources({ labelId, onClose, onAdded }: { labelId?: string; onClose: () => void; onAdded: (ids: string[]) => void }) {
  const workspace = useSourcesWorkspace(), file = workspace.file!;
  const [picked, setPicked] = useState<Document[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function add() {
    if (!picked.length || busy) return; setBusy(true); setError("");
    try {
      const current = await getResearchFile(file.document.id); workspace.accept(current);
      const references = picked.map((doc): ResearchSourceReference => {
        if (!doc.current_version_id) throw new Error("A selected document has no available version.");
        return { provider: "library", kind: "document", id: doc.id, versionId: doc.current_version_id, title: doc.filename };
      });
      const saved = await actOnResearchFile(current.document.id, current.versionId, current.workingRevision, { type: "batch", title: "Add Library sources", actions: references.map((reference) => {
        const existing = Object.values(current.state.sources).find((source) => researchSourceKey(source.reference) === researchSourceKey(reference));
        return { type: "source", reference, labelIds: [...new Set([...(existing?.labelIds ?? []), ...(labelId ? [labelId] : [])])] };
      }) });
      workspace.accept(saved);
      onAdded(Object.values(saved.state.sources).filter((source) => references.some((ref) => researchSourceKey(ref) === researchSourceKey(source.reference))).map(({ id }) => id));
      onClose();
    } catch (reason) { setError(errorMessage(reason, "Could not add the sources")); } finally { setBusy(false); }
  }
  return <Modal open onClose={onClose} size="lg" breadcrumbs={["Add sources from Library"]}
    primaryAction={{ label: "Add sources", onClick: () => void add(), disabled: busy || !picked.length || picked.length > 100 }}
    footerStatus={(error || picked.length > 100) && <p role="alert" className="text-sm text-red-700">{error || "Select at most 100 documents at once."}</p>}>
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-sm text-gray-600">Add to {labelId ? researchLabelPath(file.state.labels, labelId).map(({ name }) => name).join(" › ") : file.document.filename.replace(/\.research\.md$/iu, "")}</p>
      <FileDirectory selectedDocuments={picked} onChange={setPicked} multiple showTabs documentFilter={(doc) => !isResearchDocument(doc)}
        initialLocation={file.document.project_id ? { projectId: file.document.project_id } : { library: "files" }} />
    </div>
  </Modal>;
}
