import { useRef, useState } from "react";
import { MessageSquare, Table2, Upload } from "lucide-react";
import { createWorkflow, updateWorkflow } from "@/app/lib/beaverApi";
import type { Workflow } from "../shared/types";
import { PRACTICE_OPTIONS } from "./practices";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalTextInput } from "../modals/ModalTextInput";
const DEFAULT_LANGUAGE = "English";
const DEFAULT_PRACTICE = "General Transactions";
const DEFAULT_JURISDICTION = "General";
const LANGUAGE_OPTIONS =
    "English|Chinese|Spanish|French|German|Japanese|Korean|Portuguese|Italian|Dutch|Arabic|Hebrew|Persian|Urdu|Hindi|Bengali|Tamil|Telugu|Indonesian|Malay|Filipino|Vietnamese|Thai|Burmese|Khmer|Lao|Russian|Ukrainian|Turkish|Polish|Czech|Romanian|Greek|Danish|Finnish|Norwegian|Swedish|Afrikaans|Swahili".split("|");
const JURISDICTION_OPTIONS =
    "General|United States|England and Wales|European Union|Singapore|Hong Kong|Australia|Canada|India|Malaysia|Indonesia|Philippines|Thailand|Vietnam|Japan|South Korea|China|Taiwan|Germany|France|Netherlands|Ireland|Scotland|Luxembourg|Switzerland|Cayman Islands|British Virgin Islands|United Arab Emirates|Saudi Arabia|Brazil|Mexico".split("|");
const US_STATE_OPTIONS =
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia".split("|");
const CANADA_PROVINCE_OPTIONS =
    "Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland and Labrador|Northwest Territories|Nova Scotia|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon".split("|");
const JURISDICTION_SUGGESTIONS = [
    ...JURISDICTION_OPTIONS,
    ...US_STATE_OPTIONS,
    ...CANADA_PROVINCE_OPTIONS,
];
const PRACTICE_SUGGESTIONS = PRACTICE_OPTIONS.filter(
    (option) => option !== "Other",
);
const NEW_WORKFLOW = {
    title: "",
    type: "assistant" as const,
    language: DEFAULT_LANGUAGE,
    practice: DEFAULT_PRACTICE,
    jurisdiction: DEFAULT_JURISDICTION,
};
interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (workflow: Workflow) => void;
    editWorkflow?: Workflow;
    readOnly?: boolean;
    onUpdated?: (workflow: Workflow) => void;
}
export function NewWorkflowModal({
    open,
    ...props
}: Props) {
    if (!open) return null;
    return (
        <OpenNewWorkflowModal
            key={props.editWorkflow?.id ?? "new"}
            open={open}
            {...props}
        />
    );
}
function OpenNewWorkflowModal({
    open,
    onClose,
    onCreated,
    editWorkflow,
    readOnly = false,
    onUpdated,
}: Props) {
    const defaults = editWorkflow
        ? {
              title: editWorkflow.metadata.title,
              type: editWorkflow.metadata.type,
              language: editWorkflow.metadata.language ?? DEFAULT_LANGUAGE,
              practice: editWorkflow.metadata.practice ?? DEFAULT_PRACTICE,
              jurisdiction:
                  editWorkflow.metadata.jurisdictions?.join(", ") ||
                  DEFAULT_JURISDICTION,
          }
        : NEW_WORKFLOW;
    const [type, setType] = useState(defaults.type);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [importedSkillName, setImportedSkillName] = useState<string | null>(
        null,
    );
    const [markdownImportError, setMarkdownImportError] = useState("");
    const importedSkillMdRef = useRef("");
    const markdownInputRef = useRef<HTMLInputElement>(null);
    const isEditing = !!editWorkflow;
    const viewOnly = isEditing && readOnly;
    const formId = "workflow-modal-form";
    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (viewOnly) return;
        const form = new FormData(e.currentTarget);
        const title = String(form.get("title") ?? "").trim();
        const language = String(form.get("language") ?? "").trim();
        const practice = String(form.get("practice") ?? "").trim();
        const jurisdictions = String(form.get("jurisdiction") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        if (!title) return;
        setLoading(true);
        setError("");
        try {
            if (isEditing && editWorkflow) {
                const updated = await updateWorkflow(editWorkflow.id, {
                    metadata: {
                        title,
                        language: language || null,
                        practice: practice || null,
                        jurisdictions: jurisdictions.length
                            ? jurisdictions
                            : null,
                    },
                });
                onUpdated?.(updated);
            } else {
                const createPayload: Parameters<typeof createWorkflow>[0] = {
                    metadata: {
                        title,
                        type,
                        language: language || null,
                        practice: practice || null,
                        jurisdictions: jurisdictions.length
                            ? jurisdictions
                            : null,
                    },
                };
                if (type === "assistant" && importedSkillMdRef.current) {
                    createPayload.skill_md = importedSkillMdRef.current;
                }
                const workflow = await createWorkflow(createPayload);
                onCreated(workflow);
            }
            onClose();
        } catch (err: unknown) {
            setError((err as Error).message || `Failed to ${isEditing ? "update" : "create"} workflow`);
        } finally {
            setLoading(false);
        }
    }
    async function handleMarkdownImport(
        e: React.ChangeEvent<HTMLInputElement>,
    ) {
        const file = e.target.files?.[0];
        setMarkdownImportError("");
        if (!file) return;
        const normalizedName = file.name.toLowerCase();
        if (
            !normalizedName.endsWith(".md") &&
            !normalizedName.endsWith(".markdown")
        ) {
            importedSkillMdRef.current = "";
            setImportedSkillName(null);
            setMarkdownImportError("Choose a .md or .markdown file.");
            e.target.value = "";
            return;
        }
        try {
            importedSkillMdRef.current = await file.text();
            setImportedSkillName(file.name);
        } catch {
            importedSkillMdRef.current = "";
            setImportedSkillName(null);
            setMarkdownImportError("Could not read that markdown file.");
            e.target.value = "";
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                "Workflows",
                isEditing ? "View and Edit details" : "New workflow",
            ]}
            primaryAction={
                viewOnly
                    ? undefined
                    : {
                          label: loading
                              ? isEditing
                                  ? "Saving…"
                                  : "Creating…"
                              : isEditing
                                ? "Save changes"
                                : "Create workflow",
                          type: "submit",
                          form: formId,
                          disabled: loading,
                      }
            }
            secondaryAction={
                !isEditing && type === "assistant"
                      ? {
                          label: importedSkillName ? (
                              <span
                                  className="max-w-40 truncate"
                                  title={importedSkillName}
                              >
                                  {importedSkillName}
                              </span>
                          ) : (
                              "Upload markdown"
                          ),
                          icon: <Upload className="h-3.5 w-3.5" />,
                          onClick: () => markdownInputRef.current?.click(),
                          disabled: loading,
                      }
                    : undefined
            }
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex min-h-0 flex-1 flex-col pb-5"
            >
                <div className="space-y-6">
                    <div>
                        <ModalFieldLabel htmlFor="workflow-title">
                            Title
                        </ModalFieldLabel>
                        <ModalTextInput
                            id="workflow-title"
                            name="title"
                            type="text"
                            defaultValue={defaults.title}
                            placeholder="Add workflow name"
                            variant="minimal"
                            disabled={viewOnly}
                            required
                            autoFocus={!viewOnly}
                        />
                    </div>
                    {!isEditing && (
                        <div>
                            <ModalFieldLabel as="p">Type</ModalFieldLabel>
                            <ModalSegmentedToggle
                                value={type}
                                onChange={setType}
                                options={[
                                    {
                                        value: "assistant",
                                        label: "Assistant",
                                        icon: MessageSquare,
                                    },
                                    {
                                        value: "tabular",
                                        label: "Tabular",
                                        icon: Table2,
                                    },
                                ]}
                            />
                        </div>
                    )}
                    <div className="grid gap-5 md:grid-cols-2">
                        <DatalistField
                            id="workflow-language"
                            name="language"
                            label="Language"
                            defaultValue={defaults.language}
                            options={LANGUAGE_OPTIONS}
                            disabled={viewOnly}
                        />
                        <DatalistField
                            id="workflow-practice"
                            name="practice"
                            label="Practice area"
                            defaultValue={defaults.practice}
                            options={PRACTICE_SUGGESTIONS}
                            disabled={viewOnly}
                        />
                    </div>
                    <DatalistField
                        id="workflow-jurisdiction"
                        name="jurisdiction"
                        label="Jurisdiction"
                        defaultValue={defaults.jurisdiction}
                        options={JURISDICTION_SUGGESTIONS}
                        disabled={viewOnly}
                    />
                    {(error || markdownImportError) && (
                        <p className="text-sm text-red-500">
                            {error || markdownImportError}
                        </p>
                    )}
                </div>
                <input
                    ref={markdownInputRef}
                    type="file"
                    className="hidden"
                    accept=".md,.markdown,text/markdown,text/x-markdown,text/plain"
                    onChange={handleMarkdownImport}
                />
            </form>
        </Modal>
    );
}
function DatalistField({
    id,
    name,
    label,
    defaultValue,
    options,
    disabled,
}: {
    id: string;
    name: string;
    label: string;
    defaultValue: string;
    options: string[];
    disabled: boolean;
}) {
    return (
        <div>
            <ModalFieldLabel htmlFor={id}>{label}</ModalFieldLabel>
            <ModalTextInput
                id={id}
                name={name}
                list={`${id}-options`}
                defaultValue={defaultValue}
                disabled={disabled}
                required
            />
            <datalist id={`${id}-options`}>
                {options.map((option) => (
                    <option key={option} value={option} />
                ))}
            </datalist>
        </div>
    );
}
