import { useState } from "react";
import { Modal } from "../modals/Modal";
import type { Workflow } from "@/app/lib/api/workflows";
import type { WorkflowDocument } from "./ContextualWorkflowPicker";
import type { WorkflowSelection } from "./workflowRoutes";
import QuoteCheckWorkflow from "./QuoteCheckWorkflow";

export function QuoteReviewModal({ workflow, documents, onClose, onAssistantSelect }: {
    workflow: Workflow; documents?: WorkflowDocument[]; onClose: () => void;
    onAssistantSelect?: (selection: WorkflowSelection) => void;
}) {
    const [mode, setMode] = useState("mechanical");
    const [checking, setChecking] = useState(false);
    const variants = workflow.launcher.kind === "quote_check" ? workflow.launcher.variants : [];
    const options = [{ id: "mechanical", label: "Quotation text", description:
        "Compare wording, omissions, and changes without AI. Save an Excel workbook beside the source document." },
        ...variants.map((variant) => ({ id: variant.id, label: "Quotations and legal support", description:
            "Use AI to assess wording, source support, and misleading characterizations. Start with a prose critique in chat. Reports and edits are available on request." }))];
    return <Modal open onClose={onClose} size="xl" breadcrumbs={["Review quotations"]}
        secondaryAction={checking ? { label: "Change review type", onClick: () => setChecking(false) } : undefined}
        primaryAction={checking ? undefined : { label: mode === "mechanical" ? "Continue" : "Open chat",
            disabled: mode !== "mechanical" && !onAssistantSelect,
            onClick: () => {
                if (mode === "mechanical") { setChecking(true); return; }
                const variant = variants.find(({ id }) => id === mode);
                if (variant) { onClose(); onAssistantSelect?.({ workflow, variant }); }
            } }}>
        {checking ? <QuoteCheckWorkflow documents={documents} /> : <fieldset className="space-y-3 pb-5">
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
