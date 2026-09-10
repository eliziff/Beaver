import { useState } from "react";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import type { Document } from "@/app/lib/api/documents";
import type { Workflow } from "@/app/lib/api/workflows";
import type { WorkflowDocument } from "./ContextualWorkflowPicker";
import type { WorkflowSelection } from "./workflowRoutes";
import QuoteCheckWorkflow from "./QuoteCheckWorkflow";

export function QuoteReviewModal({ workflow, documents, onClose, onAssistantSelect }: {
    workflow: Workflow; documents?: WorkflowDocument[]; onClose: () => void;
    onAssistantSelect?: (selection: WorkflowSelection, documents: Document[]) => void;
}) {
    const [mode, setMode] = useState("mechanical");
    const [checking, setChecking] = useState(false);
    // The AI review picks its document before the chat opens (Eli, 2026-09-10).
    const [picking, setPicking] = useState(false);
    const [selected, setSelected] = useState<Document[]>(documents?.length === 1 ? [documents[0] as Document] : []);
    const variants = workflow.launcher.kind === "quote_check" ? workflow.launcher.variants : [];
    const options = [{ id: "mechanical", label: "Quotation text", description:
        "Compare wording, omissions, and changes without AI. Save an Excel workbook beside the source document." },
        ...variants.map((variant) => ({ id: variant.id, label: "Quotations and legal support", description:
            "Use AI to assess wording, source support, and misleading characterizations. Start with a prose critique in chat. Reports and edits are available on request." }))];
    return <Modal open onClose={onClose} size="xl" breadcrumbs={["Review quotations"]}
        secondaryAction={checking || picking ? { label: "Change review type", onClick: () => { setChecking(false); setPicking(false); } } : undefined}
        primaryAction={checking ? undefined : picking ? { label: "Open chat", disabled: selected.length !== 1,
            onClick: () => {
                const variant = variants.find(({ id }) => id === mode);
                if (variant) { onClose(); onAssistantSelect?.({ workflow, variant }, selected); }
            } } : { label: "Continue", disabled: mode !== "mechanical" && !onAssistantSelect,
            onClick: () => { if (mode === "mechanical") setChecking(true); else setPicking(true); } }}>
        {checking ? <QuoteCheckWorkflow documents={documents} /> : picking ? <FileDirectory showTabs tabs={[["files", "Files"], ["projects", "Projects"]]}
            multiple={false} selectedDocuments={selected} onChange={setSelected}
            documentFilter={(document) => document.library_kind !== "template" && /\.(docx|pdf)$/iu.test(document.filename)} /> : <fieldset className="space-y-3 pb-5">
            <legend className="mb-3 text-sm font-semibold text-gray-900">Choose the depth of review</legend>
            {options.map((option) => <label key={option.id}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-4 has-checked:border-gray-500 has-checked:bg-gray-50">
                <input type="radio" name="quote-review-type" value={option.id} checked={mode === option.id}
                    onChange={() => setMode(option.id)} className="mt-1 accent-gray-900" />
                <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">{option.label}</span>
                    <span className="mt-1 block text-sm leading-6 text-gray-600">{option.description}</span>
                </span>
            </label>)}
        </fieldset>}
    </Modal>;
}
