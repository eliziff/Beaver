import { useEffect, useState } from "react";
import { getResearchFile, openWorkspaceTable } from "@/app/lib/api/researchFiles";
import { isResearchDocument, type ResearchFile } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FieldGroup, FormField } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalSelect } from "../modals/ModalSelect";
import { FileDirectory } from "../shared/FileDirectory";
import { tabularReviewPath } from "./tabularReviewRoute";

type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null; onOpen: (path: string) => void };

export function ImportResearchSet({ open, ...props }: Props) {
    return open ? <OpenImportResearchSet {...props} /> : null;
}
function OpenImportResearchSet({ onClose, fileId, projectId, onOpen }: Omit<Props, "open">) {
    const [picked, setPicked] = useState<Document[]>([]);
    const [rows, setRows] = useState<"sources" | "passages">("sources");
    const [pen, setPen] = useState("");
    const [file, setFile] = useState<ResearchFile | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const activeId = fileId ?? picked[0]?.id;
    useEffect(() => {
        if (!activeId) return setFile(null);
        let active = true;
        setPen("");
        void getResearchFile(activeId).then((next) => { if (active) setFile(next); }).catch(() => undefined);
        return () => { active = false; };
    }, [activeId]);
    const pens = Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight");
    async function create() {
        if (!activeId || busy) return;
        setBusy(true); setError("");
        try {
            const review = await openWorkspaceTable(activeId, { rows, ...(pen ? { labelId: pen } : {}) });
            onOpen(tabularReviewPath(review));
            onClose();
        } catch (reason) { setError(errorMessage(reason, "The review could not be created. Try again.")); }
        finally { setBusy(false); }
    }
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={["Import a Research set"]}
        footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        primaryAction={{ label: busy ? "Creating…" : "Create", onClick: () => void create(), disabled: !activeId || busy }}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 pb-3">
            {!fileId && <div className="flex min-h-0 flex-1 flex-col">
                <FileDirectory selectedDocuments={picked} onChange={setPicked} showTabs multiple={false} noun="research sets"
                    documentFilter={isResearchDocument} initialLocation={projectId ? { projectId } : { library: "files" }} />
            </div>}
            <div className="flex flex-wrap items-end gap-4">
                <FieldGroup legend="Rows">
                    <ModalSegmentedToggle value={rows} onChange={setRows}
                        options={[{ value: "sources", label: "Sources" }, { value: "passages", label: "Passages" }]} />
                </FieldGroup>
                {!!pens.length && <FormField label="Pen" htmlFor="import-research-pen" className="min-w-40">
                    <ModalSelect id="import-research-pen" value={pen} ariaLabel="Pen" placeholder="Any pen"
                        options={[{ value: "", label: "Any pen" }, ...pens.map(({ id, name }) => ({ value: id, label: name }))]}
                        onChange={setPen} />
                </FormField>}
            </div>
        </div>
    </Modal>;
}
