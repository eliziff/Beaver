import { useRef, useState } from "react";
import { ChevronDown, MessageSquare, Table2, Upload } from "lucide-react";
import { createWorkflow, updateWorkflow } from "@/app/lib/beaverApi";
import type { Workflow, WorkflowAudience } from "../shared/types";
import { Modal } from "../modals/Modal";
import { FieldGroup, FormField } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ModalTextarea } from "../modals/ModalTextarea";
import { Button } from "../ui/button";
import { WORKFLOW_CATEGORIES } from "./workflowCatalog";

interface Props {
    open: boolean; onClose: () => void; editWorkflow?: Workflow;
    onCreated?: (workflow: Workflow) => void; onUpdated?: (workflow: Workflow) => void;
}

export function NewWorkflowModal({ open, ...props }: Props) {
    return open ? <OpenNewWorkflowModal key={props.editWorkflow?.id ?? "new"} {...props} /> : null;
}

function OpenNewWorkflowModal({ onClose, onCreated, editWorkflow, onUpdated }: Omit<Props, "open">) {
    const current = editWorkflow?.launcher.kind === "instructions"
        ? editWorkflow.launcher.variants[0] : undefined;
    const [execution, setExecution] = useState(current?.execution ?? "assistant");
    const [audiences, setAudiences] = useState<WorkflowAudience[]>(editWorkflow?.metadata.audiences ?? ["general"]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [instructions, setInstructions] = useState(current?.skill_md ?? "");
    const fileInput = useRef<HTMLInputElement>(null);
    const audienceField = useRef<HTMLInputElement>(null);
    const instructionsField = useRef<HTMLTextAreaElement>(null);
    const formId = "workflow-details-form";
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const title = String(form.get("title") ?? "").trim();
        const category = String(form.get("category") ?? "");
        const language = String(form.get("language") ?? "").trim();
        const jurisdictions = String(form.get("jurisdictions") ?? "").split(",")
            .map((item) => item.trim()).filter(Boolean);
        if (execution === "assistant" && !instructions.trim()) {
            setError("Write instructions for this workflow.");
            requestAnimationFrame(() => instructionsField.current?.focus()); return;
        }
        if (!audiences.length) {
            setError("Choose at least one audience.");
            requestAnimationFrame(() => audienceField.current?.focus()); return;
        }
        const launcher = { kind: "instructions" as const, variants: [{
            label: title, execution,
            result: current?.result ?? (execution === "assistant" ? "Written response" : "Review table"),
            skill_md: execution === "assistant" ? instructions.trim() : null,
            columns_config: execution === "tabular" ? current?.columns_config ?? [] : null }] };
        setLoading(true); setError("");
        try {
            const metadata = { title, category, audiences, language: language || null,
                jurisdictions: jurisdictions.length ? jurisdictions : null };
            if (editWorkflow) onUpdated?.(await updateWorkflow(editWorkflow.id, { metadata, launcher }));
            else onCreated?.(await createWorkflow({ metadata, launcher }));
            onClose();
        } catch (reason) {
            setError((reason as Error).message || "Unable to save workflow.");
        } finally { setLoading(false); }
    }
    async function importMarkdown(file?: File) {
        if (!file) return;
        if (!/\.(?:md|markdown)$/iu.test(file.name)) { setError("Choose a Markdown file."); return; }
        try { setInstructions(await file.text()); setError(""); }
        catch { setError("Unable to read that file."); }
    }
    function toggleAudience(audience: WorkflowAudience) {
        setAudiences((items) => items.includes(audience)
            ? items.filter((item) => item !== audience) : [...items, audience]);
    }
    const instructionsError = error === "Write instructions for this workflow.";
    const audienceError = error === "Choose at least one audience.";
    return <Modal open onClose={onClose} size="xl"
            className="!h-fit max-h-[calc(100dvh-2rem)]"
            breadcrumbs={["Workflows", editWorkflow ? "Edit workflow" : "New workflow"]}
            primaryAction={{ label: loading ? "Saving…" : editWorkflow ? "Save changes" : "Create workflow",
                type: "submit", form: formId, disabled: loading }}>
            <form id={formId} onSubmit={submit} className="space-y-6 pb-5">
                <input ref={fileInput} type="file" accept=".md,.markdown" hidden
                    onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        void importMarkdown(file);
                    }} />
                <div className={`grid gap-5 ${editWorkflow
                    ? "" : "sm:grid-cols-[minmax(0,1fr)_auto]"}`}>
                    <FormField label="Workflow name" htmlFor="workflow-title">
                        <ModalTextInput name="title" required autoFocus
                            defaultValue={editWorkflow?.metadata.title} />
                    </FormField>
                    {!editWorkflow && <FieldGroup legend="Opens in">
                        <ModalSegmentedToggle value={execution} onChange={setExecution} options={[
                            { value: "assistant", label: "Assistant", icon: MessageSquare },
                            { value: "tabular", label: "Table", icon: Table2 }]} />
                    </FieldGroup>}
                </div>
                {execution === "assistant" && <div>
                    <FormField label="Instructions" htmlFor="workflow-instructions">
                        <ModalTextarea ref={instructionsField} required rows={6}
                            aria-invalid={instructionsError || undefined}
                            aria-describedby={instructionsError ? "workflow-form-error" : undefined}
                            value={instructions}
                            onChange={(event) => setInstructions(event.currentTarget.value)} />
                    </FormField>
                    <Button variant="white" size="compact" className="mt-2"
                        type="button" disabled={loading} onClick={() => fileInput.current?.click()}>
                        <Upload aria-hidden="true" className="h-4 w-4" />Import instructions
                    </Button>
                </div>}
                <div className="grid gap-6 sm:grid-cols-2">
                    <FormField label="Category" htmlFor="workflow-category">
                        <select name="category" required
                            defaultValue={editWorkflow?.metadata.category ?? WORKFLOW_CATEGORIES[0][0]}
                            className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-base text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 sm:text-sm">
                        {WORKFLOW_CATEGORIES.map(([value, label]) => <option key={value}
                            value={value}>{label}</option>)}
                        </select>
                    </FormField>
                    <FieldGroup legend="Audience" aria-invalid={audienceError || undefined}
                        aria-describedby={audienceError ? "workflow-form-error" : undefined}>
                        <div className="flex min-h-10 flex-wrap items-center gap-x-5 gap-y-2">
                            {(["general", "solicitor", "litigator"] as const).map((audience) => <label
                                key={audience} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm capitalize text-gray-700">
                                <input ref={audience === "general" ? audienceField : undefined}
                                    type="checkbox" checked={audiences.includes(audience)}
                                    onChange={() => toggleAudience(audience)} />{audience}
                            </label>)}
                        </div>
                    </FieldGroup>
                </div>
                <details className="group rounded-lg bg-gray-50 px-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-medium text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                        <span className="flex-1">Language and jurisdiction</span>
                        <ChevronDown aria-hidden="true"
                            className="h-4 w-4 text-gray-400 motion-safe:transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="grid gap-5 pb-3 sm:grid-cols-2">
                        <FormField label="Language" htmlFor="workflow-language">
                            <ModalTextInput name="language"
                                defaultValue={editWorkflow?.metadata.language ?? "English"} />
                        </FormField>
                        <FormField label="Jurisdictions" htmlFor="workflow-jurisdictions">
                            <ModalTextInput name="jurisdictions"
                                defaultValue={editWorkflow?.metadata.jurisdictions?.join(", ") ?? "General"} />
                        </FormField>
                    </div>
                </details>
                {error && <p id="workflow-form-error" role="alert" className="text-sm text-red-700">{error}</p>}
            </form>
        </Modal>;
}
